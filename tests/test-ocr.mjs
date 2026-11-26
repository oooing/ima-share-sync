import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Module from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { embeddedWasmPlugin } from '../scripts/inspector-wasm-build.mjs';

const compiled=await build({stdin:{contents:`export * from './src/pdf-ocr-core'; export * from './src/ocr-api'; export * from './src/ocr-local'; export * from './src/pdf-markdown-format'; export * from './src/pdf-to-markdown';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',loader:{'.py':'text'},plugins:[embeddedWasmPlugin()]});
const mod=new Module(path.resolve('tests/ocr-bundle.cjs')); mod.filename=path.resolve('tests/ocr-bundle.cjs'); mod._compile(compiled.outputFiles[0].text,mod.filename);
const {processPdfWithOcr,recognizeApi,recognizeLocal,defaultOcrRuntime,buildMarkdownContent,isLegacyScanPlaceholder,runDirectConversion}=mod.exports;
const directory=await mkdtemp(path.join(os.tmpdir(),'ima-ocr-tests-'));
let callbacks=0;
const recognition=async request=>{callbacks++; return request.pages.map(page=>({page,markdown:`Recognized page ${page}: 12.5%\n\n![chart](images/chart.png)`}));};
try {
  const doc=await PDFDocument.create();
  const png=await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYkAAAAASUVORK5CYII=','base64'));
  doc.addPage([612,792]).drawImage(png,{x:0,y:0,width:612,height:792});
  const pdfPath=path.join(directory,'scan.pdf'),mdPath=path.join(directory,'scan.md');
  await writeFile(pdfPath,await doc.save());
  const task={pdfPath,mdPath,title:'OCR fixture',scope:'all',embedPdfLink:true};
  assert.deepEqual(await processPdfWithOcr(task,recognition,'local'),{success:true,skipped:false});
  assert.equal(callbacks,1);
  let output=await readFile(mdPath,'utf8');
  assert.match(output,/ocr_provider: "local"/); assert.match(output,/ocr_content_sha256:/); assert.match(output,/scan.pdf#page=1/); assert.doesNotMatch(output,/images\/chart.png/);
  assert.match(output,/Recognized page 1: 12.5%/);
  assert.deepEqual(await processPdfWithOcr(task,recognition,'local'),{success:true,skipped:true}); assert.equal(callbacks,1);
  await writeFile(mdPath,output+'\nMy own analysis');
  assert.equal((await processPdfWithOcr(task,recognition,'local')).skipped,true); assert.equal(callbacks,1);
  const legacy=buildMarkdownContent(task,{pdfType:'Scanned',pageCount:1});
  assert.equal(isLegacyScanPlaceholder(legacy),true);
  assert.equal(isLegacyScanPlaceholder(legacy+'\nMy note'),false);
  assert.equal(isLegacyScanPlaceholder(legacy.replace('> [!WARNING]','My note\n> [!WARNING]')),false);
  await writeFile(mdPath,legacy);
  assert.equal((await processPdfWithOcr(task,recognition,'local')).success,true); assert.equal(callbacks,2);
  await writeFile(mdPath,'Human-authored'); assert.equal((await processPdfWithOcr(task,recognition,'local')).skipped,true);
  await rm(mdPath);
  const broken=await processPdfWithOcr(task,async()=>{throw new Error('local failed; no fallback');},'local');
  assert.equal(broken.success,false); await assert.rejects(stat(mdPath),{code:'ENOENT'});
  assert.equal((await processPdfWithOcr(task,async()=>[],'local')).success,false);
  assert.equal((await processPdfWithOcr({...task,scope:'text_only'},recognition,'local')).skipped,true);
  const editing=await processPdfWithOcr(task,async r=>{await writeFile(mdPath,'Written while OCR runs');return recognition(r);},'local');
  assert.equal(editing.skipped,true); assert.equal(await readFile(mdPath,'utf8'),'Written while OCR runs'); await rm(mdPath);
  const abort=new AbortController();
  await assert.rejects(runDirectConversion([task],async()=>{abort.abort();throw new Error('cancel');},undefined,abort.signal),/取消/);
  const textDoc=await PDFDocument.create(); const font=await textDoc.embedFont(StandardFonts.Helvetica);
  textDoc.addPage().drawText('Text PDF stays local without OCR',{font,x:40,y:600});
  const textPath=path.join(directory,'text.pdf'); await writeFile(textPath,await textDoc.save());
  assert.equal((await processPdfWithOcr({...task,pdfPath:textPath,mdPath:path.join(directory,'text.md')},async()=>{throw new Error('must not call');},'api')).success,true);
  let calls=[];
  const transport=async options=>{calls.push(options); if(calls.length===1)return JSON.stringify({data:{jobId:'job'}}); if(calls.length===2)return JSON.stringify({data:{state:'done',resultUrl:{jsonUrl:'https://result.example/file'}}});return JSON.stringify({result:{layoutParsingResults:[{markdown:{text:'Approved test'}}]}});};
  const request={pdfPath,pages:[1],pageCount:1};
  await assert.rejects(recognizeApi(request,'secret',false,transport),/手动确认/); assert.equal(calls.length,0);
  await assert.rejects(recognizeApi(request,'',true,transport),/令牌/); assert.equal(calls.length,0);
  assert.deepEqual(await recognizeApi(request,'secret',true,transport,async()=>{}),[{page:1,markdown:'Approved test'}]);
  assert.equal(calls[2].token,undefined); assert.match(calls[0].body.toString(),/useChartRecognition\\":false|useChartRecognition":false/);
  assert.match(calls[0].body.toString(),/name="pageRanges"/);
  if(process.argv.includes('--real-api')) {
    const fixture=await PDFDocument.create(); const face=await fixture.embedFont(StandardFonts.Helvetica);
    fixture.addPage([612,792]).drawText('FIRST PAGE NOT REQUESTED',{font:face,x:50,y:650,size:18});
    fixture.addPage([612,792]).drawText('OCR SECOND PAGE\nRevenue 12345\nGrowth 12.5%',{font:face,x:50,y:650,size:18,lineHeight:32});
    const fixturePath=path.join(directory,'api-fixture.pdf'); await writeFile(fixturePath,await fixture.save());
    let token;
    const itemId=process.env.IMA_OCR_TEST_ITEM;
    assert.ok(itemId,'Set IMA_OCR_TEST_ITEM to the authorized 1Password item ID (never a token)');
    try {
      const raw=execFileSync('pwsh.exe',['-NoProfile','-File',path.join(os.homedir(),'Tools','1PasswordAI','op-ai.ps1'),'item','get',itemId,'--vault','AI自动化','--format','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
      const item=JSON.parse(raw); token=item.fields?.find(field=>field.id==='credential')?.value;
    } catch { throw new Error('Could not read the authorized OCR credential'); }
    assert.ok(token,'OCR credential missing');
    const started=Date.now();
    const pages=await recognizeApi({pdfPath:fixturePath,pages:[2],pageCount:2},token,true);
    assert.equal(pages.length,1); assert.equal(pages[0].page,2);
    assert.match(pages[0].markdown,/SECOND PAGE/); assert.match(pages[0].markdown,/12345/);
    assert.doesNotMatch(pages[0].markdown,/FIRST PAGE/);
    console.log(JSON.stringify({real_api:true,synthetic_only:true,requested_page:2,seconds:(Date.now()-started)/1000,markdown_chars:pages[0].markdown.length}));
  }
  const realIndex=process.argv.indexOf('--real-local');
  const cancelIndex=process.argv.indexOf('--real-local-cancel');
  if(cancelIndex>=0){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    const started=Date.now();
    try { await assert.rejects(recognizeLocal({pdfPath:process.argv[cancelIndex+1],pages:[1,2],pageCount:2,signal:controller.signal},defaultOcrRuntime()),/取消/); }
    finally {clearTimeout(timer);}
    console.log(JSON.stringify({real_local_cancellation:true,seconds:(Date.now()-started)/1000}));
  }
  if(realIndex>=0){
    const input=process.argv[realIndex+1]; assert.ok(input);
    await copyFile(input,pdfPath); await rm(mdPath,{force:true});
    const started=Date.now();
    const result=await processPdfWithOcr(task,r=>recognizeLocal(r,defaultOcrRuntime(),(p,n)=>console.log(`LOCAL ${p}/${n}`)),'local');
    assert.equal(result.success,true,result.error); output=await readFile(mdPath,'utf8'); assert.match(output,/ocr_provider: "local"/);
    console.log(JSON.stringify({real_local:true,seconds:(Date.now()-started)/1000,markdown_chars:output.length}));
  }
  console.log('PASS: OCR consent gate, no fallback, text-only path, page completeness, cancellation, incremental skip, scan upgrade, user edits and API token isolation');
} finally { await rm(directory,{recursive:true,force:true}); }
