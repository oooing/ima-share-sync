// Production bundle + real synthetic PDFs, no external network.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const {EventEmitter} = require('node:events');
const {Readable, PassThrough} = require('node:stream');
const {readFileSync} = require('node:fs');
const {PDFDocument, StandardFonts} = require('pdf-lib');
const Base = class {};
const realMobile = process.argv[2] === '--real-mobile';
const realLayoutGuard = process.argv[2] === '--layout-preflight';
let actualStarts=0;
let base, token = 'synthetic', calls = 0, posts = 0, httpError = 0, reads = 0, modals = 0;
let jobFailed = false;
let approveUpload = false, freeMemory = 8 * 2 ** 30;
const workers = [];
const failedJobMessage = '第 7 页无法解析；诊断 URL：https://example.invalid/result?signature=opaque；令牌：' + token;
class Adapter { getBasePath(){return base;} async write(file,data){this.queue=JSON.parse(data);} }
class Plugin {
  constructor(){this.app={vault:{adapter:new Adapter()},secretStorage:{getSecret(){reads++;return token;}},
    loadLocalStorage:()=>this.grant, saveLocalStorage:(_,v)=>{this.grant=v;}};}
}
class Modal {
  constructor(){this.contentEl={createEl(){},empty(){}};}
  setTitle(){} open(){modals++;this.onOpen();queueMicrotask(()=>approveUpload?this.contentEl.approve():this.close());} close(){this.onClose();}
}
class Setting {
  constructor(el){this.el=el;}
  addButton(cb){
    const b={setButtonText(text){b.text=text;return b;},setCta(){return b;},onClick:fn=>{if(b.text==='仅允许本轮')this.el.approve=fn;return b;}};
    cb(b);return this;
  }
}
const load=Module._load;
Module._load=function(name,...rest){
  if(name==='obsidian')return {Plugin,Modal,Setting,PluginSettingTab:Base,ItemView:Base,Menu:Base,Notice:Base,TFile:Base,TFolder:Base,FileSystemAdapter:Adapter,Platform:{isWin:true},normalizePath:x=>x};
  if(name==='os')return {...os,freemem:()=>freeMemory};
  if(name==='child_process')return {...load.call(this,name,...rest),spawn(exe,args,options){
    if(realMobile || realLayoutGuard) {
      const runtimePython=path.join(process.argv[3],'.venv','Scripts','python.exe');
      actualStarts++;
      assert.equal(path.resolve(exe).toLowerCase(),path.resolve(runtimePython).toLowerCase(),'real smoke test can only start its selected worker');
      return load.call(this,name,...rest).spawn(exe,args,options);
    }
    assert.equal(path.basename(args.at(-1)),'worker.py', 'only a chosen OCR worker may start');
    const worker=readFileSync(args.at(-1),'utf8').includes('One local PP-OCRv5 mobile job')?'mobile':'layout';
    const proc=new EventEmitter();
    proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.stdin=new PassThrough();
    let input='';
    proc.stdin.setEncoding('utf8').on('data',chunk=>input+=chunk);
    proc.stdin.on('end',()=>{
      const data=JSON.parse(input);
      workers.push({worker,exe,pdfPath:data.pdfPath});
      for(const page of data.pages)proc.stdout.write(JSON.stringify({type:'page',page,markdown:'Local text 42'})+'\n');
      proc.stdout.end('{"type":"done"}\n');proc.emit('close',0);
    });
    return proc;
  }};
  if(name==='https')return {request(url,opt,handle){
    calls++;if(opt.method==='POST')posts++;
    const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
      const payload=opt.method==='POST'?{data:{jobId:'synthetic-job'}}:url.pathname.endsWith('synthetic-job')?
        {data:jobFailed?{state:'failed',errorMsg:failedJobMessage}:{state:'done',resultUrl:{jsonUrl:'https://example.invalid/result'}}}:{result:{layoutParsingResults:[{markdown:{text:'Revenue 12345'}}]}};
      const res=Readable.from([Buffer.from(JSON.stringify(payload))]);res.statusCode=httpError||200;handle(res);
    });return req;
  }};
  return load.call(this,name,...rest);
};
global.window=global;
const pluginBundle = readFileSync(require.resolve('../dist/main.js'), 'utf8');
assert.doesNotMatch(pluginBundle, /Optional stand-alone Windows OCR setup|正在安装本地轻量 OCR 依赖|ima-ocr-install-/,
  'the release bundle must not include or launch the external installer');
const bundle=require('../dist/main.js');Module._load=load;
(async()=>{
  base=await fs.mkdtemp(path.join(os.tmpdir(),'ima-byok-'));
  try{
    if(realMobile || realLayoutGuard){
      const P=bundle.default||bundle, p=new P();
      freeMemory=os.freemem();
      p.settings.imageOcrEnabled=true;
      p.settings.ocrProvider=realMobile?'local-mobile':'local';
      if(realMobile)p.settings.ocrMobileRuntimePath=process.argv[3];
      else p.settings.ocrRuntimePath=process.argv[3];
      p.canNotify=()=>false;p.updateMarkdownDashboardUI=()=>{};p.recordSyncReport=async r=>{p.report=r;};
      const source=await fs.readFile(process.argv[4]);
      const localPdf=path.join(base,'scan.pdf');
      await fs.writeFile(localPdf,source);
      const queued=await p.convertPdfFilesToMarkdown([{path:'scan.pdf',title:'OCR acceptance'}],false);
      assert.equal(queued.deferred,1);
      if(realLayoutGuard){
        assert.equal(await p.isLocalOcrReady('local'),true);
        assert.ok(freeMemory < 6 * 2 ** 30,'low-memory guard test requires less than 6 GiB free');
      }
      await p.retryPendingMarkdown();
      if(realLayoutGuard){
        assert.match(p.report.summary,/6 GiB/);
        assert.equal(p.pendingOcrCount,1);
        assert.equal(actualStarts,0);
        assert.deepEqual(await fs.readFile(localPdf),source);
        assert.deepEqual([calls,reads,modals],[0,0,0]);
        console.log(JSON.stringify({model:'PaddleOCR-VL-1.6',availableGiB:freeMemory/2**30,queued:1,workerStarts:0,cloudRequests:0}));
        return;
      }
      assert.equal(p.report.status,'success',JSON.stringify(p.report.errors));
      assert.equal(p.pendingOcrCount,0);
      const note=await fs.readFile(path.join(base,'scan.md'),'utf8');
      assert.match(note,/ocr_model: "PP-OCRv5 mobile"/);
      assert.match(note,/仅供文字检索/);
      assert.equal((note.match(/^## 第 \d+ 页$/gm)||[]).length,2);
      assert.deepEqual(await fs.readFile(localPdf),source);
      assert.deepEqual([calls,reads,modals],[0,0,0]);
      console.log(JSON.stringify({model:'PP-OCRv5 mobile',markdown:1,pages:2,cloudRequests:0,sourceUnchanged:true,durationMs:p.report.conversion.durationMs}));
      return;
    }
    const pdf=await PDFDocument.create();
    const image=await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYkAAAAASUVORK5CYII=','base64'));
    pdf.addPage([612,792]).drawImage(image,{x:0,y:0,width:612,height:792});
    const pdfBytes=await pdf.save();
    await fs.writeFile(path.join(base,'scan.pdf'),pdfBytes);
    const P=bundle.default||bundle, p=new P();
    assert.equal(p.settings.ocrProvider,'api');
    assert.equal(p.settings.imageOcrEnabled,false);
    p.settings.enableMarkdownConversion=true;
    p.canNotify=()=>false;p.updateMarkdownDashboardUI=()=>{};p.recordSyncReport=async r=>{p.report=r;};
    const textPdf=await PDFDocument.create();
    const page=textPdf.addPage();
    const font=await textPdf.embedFont(StandardFonts.Helvetica);
    for(let i=0;i<8;i++)page.drawText("Revenue and operating income, annual report excerpt.",{font,x:40,y:730-i*20,size:12});
    await fs.writeFile(path.join(base,'text.pdf'),await textPdf.save());
    const textOnly=await p.convertPdfFilesToMarkdown([{path:'text.pdf',title:'Text fixture'}],false);
    assert.equal(textOnly.completed,1);
    assert.match(await fs.readFile(path.join(base,'text.md'),'utf8'),/annual report excerpt/);
    assert.deepEqual([calls,reads,modals],[0,0,0]);
    const files=[{path:'scan.pdf',title:'Test'}];
    const noGrant=await p.convertPdfFilesToMarkdown(files,false);
    assert.equal(noGrant.deferred,1);assert.equal(noGrant.failed,0);assert.equal(reads,0);assert.equal(calls,0);
    assert.equal(p.report.conversion.uploadedFiles,0);
    assert.equal(p.report.conversion.unconfirmedFiles,0);
    assert.deepEqual(p.app.vault.adapter.queue,['scan.pdf']);
    await p.retryPendingMarkdown();
    assert.equal(calls,0);assert.equal(modals,0);
    p.settings.imageOcrEnabled=true;
    p.grant=p.settings.ocrSecretId; // A previously saved background grant is now inert.
    const automatic=await p.convertPdfFilesToMarkdown(files,false,{});
    assert.equal(automatic.deferred,1);assert.equal(reads,0);assert.equal(calls,0);
    const discovery=await p.convertPdfFilesToMarkdown(files,true);
    assert.equal(discovery.deferred,1);assert.equal(reads,0);assert.equal(modals,0);
    token='';await p.retryPendingMarkdown();assert.equal(calls,0);assert.equal(modals,0);
    token='synthetic';const previous=console.error;console.error=()=>{};
    try{await p.retryPendingMarkdown();}finally{console.error=previous;}
    assert.equal(calls,0);assert.equal(modals,1);assert.equal(p.report.status,'canceled');
    assert.equal(p.markdownDashboardState.status,'canceled');
    assert.equal(p.report.conversion.uploadedBytes,0);
    await fs.copyFile(path.join(base,'scan.pdf'),path.join(base,'second.pdf'));
    const both=[...files,{path:'second.pdf',title:'Test 2'}];
    await p.convertPdfFilesToMarkdown(both,false);
    approveUpload=true;
    httpError=429;
    await p.retryPendingMarkdown();
    assert.match(p.report.summary,/待转换 2/);assert.equal(posts,1);
    assert.equal(p.report.conversion.uploadedFiles,0);
    assert.equal(p.report.conversion.unconfirmedFiles,1);
    assert.equal(p.report.conversion.unconfirmedPdfBytes,pdfBytes.length);
    assert.equal(p.pendingOcrCount,2);
    httpError=0;await p.retryPendingMarkdown();assert.equal(p.pendingOcrCount,0);assert.equal(posts,3);
    assert.equal(modals,3, "every manual cloud batch needs fresh consent");
    assert.equal(p.report.conversion.uploadedFiles,2);
    assert.equal(p.report.conversion.uploadedBytes,2 * pdfBytes.length);
    assert.equal(p.report.conversion.unconfirmedFiles,0);
    assert.ok(Number.isSafeInteger(p.report.conversion.durationMs) && p.report.conversion.durationMs >= 0);
    const md=await fs.readFile(path.join(base,'scan.md'),'utf8');assert.match(md,/Revenue 12345/);assert.match(md,/ocr_provider: "api"/);
    await p.convertPdfFilesToMarkdown(files,false);assert.equal(posts,3);
    assert.equal(p.report.conversion.uploadedFiles,0);
    assert.equal(p.report.conversion.uploadedBytes,0);

    await fs.copyFile(path.join(base,'scan.pdf'),path.join(base,'failed-in-cloud.pdf'));
    jobFailed=true;
    await p.convertPdfFilesToMarkdown([{path:'failed-in-cloud.pdf',title:'Cloud failure'}],false);
    await p.retryPendingMarkdown();
    assert.equal(p.report.status,'failed');
    assert.equal(p.report.conversion.uploadedFiles,1);
    assert.equal(p.report.conversion.uploadedBytes,pdfBytes.length);
    assert.deepEqual(p.report.errors[0].ocr,{
      jobId:'synthetic-job',reason:'第 7 页无法解析；诊断 URL：[链接已隐藏]；令牌：[已隐藏]',
    });
    assert.equal(p.pendingOcrCount,1);
    jobFailed=false;

    const cloudCalls=calls, cloudReads=reads, cloudModals=modals;
    const fakeRuntime=async (folder,model,required)=>{
      const runtime=path.join(base,folder);
      for(const file of ['.venv/Scripts/python.exe',...required]){
        const dest=path.join(runtime,file);
        await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,'fixture');
      }
      await fs.writeFile(path.join(runtime,'runtime.json'),JSON.stringify({schema:1,model}));
      return runtime;
    };
    p.settings.ocrProvider='local';
    p.settings.ocrRuntimePath=await fakeRuntime('layout','PaddleOCR-VL-1.6',[
      'runtime/llama/llama-server.exe',
      'models/gguf/PaddleOCR-VL-1.6-GGUF.gguf','models/gguf/PaddleOCR-VL-1.6-GGUF-mmproj.gguf',
      'cache/paddlex/official_models/PP-DocLayoutV3/inference.pdiparams',
    ]);
    p.settings.ocrMobileRuntimePath=await fakeRuntime('mobile','PP-OCRv5 mobile',[
      'models/ch_PP-OCRv5_det_mobile.onnx','models/ch_PP-OCRv5_rec_mobile.onnx',
    ]);
    await p.convertPdfFilesToMarkdown([{path:'failed-in-cloud.pdf',title:'Local queue'}],true,{});
    assert.equal(workers.length,0,'sync cannot launch local OCR');
    freeMemory=2*2**30;await p.retryPendingMarkdown();
    assert.equal(workers.length,0,'layout mode stays queued on low memory');
    assert.equal(p.pendingOcrCount,1);
    assert.match(p.report.summary,/6 GiB/);
    assert.equal(p.settings.ocrProvider,'local','no automatic fallback to mobile or cloud');
    freeMemory=8*2**30;await p.retryPendingMarkdown();
    assert.deepEqual(workers.map(w=>w.worker),['layout']);
    assert.equal(p.pendingOcrCount,0);
    assert.match(await fs.readFile(path.join(base,'failed-in-cloud.md'),'utf8'),/ocr_provider: "local"/);

    p.settings.ocrProvider='local-mobile';freeMemory=2*2**30;
    await fs.copyFile(path.join(base,'scan.pdf'),path.join(base,'light.pdf'));
    await p.convertPdfFilesToMarkdown([{path:'light.pdf',title:'Light'}],false);
    assert.equal(workers.length,1);
    await p.retryPendingMarkdown();
    assert.deepEqual(workers.map(w=>w.worker),['layout','mobile']);
    const lightNote=await fs.readFile(path.join(base,'light.md'),'utf8');
    assert.match(lightNote,/ocr_model: "PP-OCRv5 mobile"/);
    assert.match(lightNote,/仅供文字检索/);
    assert.deepEqual(await fs.readFile(path.join(base,'light.pdf')),Buffer.from(pdfBytes));
    assert.equal(p.pendingOcrCount,0);
    assert.deepEqual([calls,reads,modals],[cloudCalls,cloudReads,cloudModals], 'local modes never touch cloud transport or credentials');

    const bad=Array.from({length:23},(_,i)=>({path:'missing-'+i+'.pdf',title:'missing '+i}));
    const failed=await p.convertPdfFilesToMarkdown(bad,false);assert.equal(failed.failed,23);assert.equal(p.report.errors.length,23);
    console.log('PASS: default off, no background OCR, confirmation per cloud batch, quota, cloud diagnostics, pinned local mode, memory, queue and no fallback');
  }finally{await fs.rm(base,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
