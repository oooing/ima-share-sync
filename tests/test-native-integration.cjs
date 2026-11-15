"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const clone=value=>JSON.parse(JSON.stringify(value));
let spawnHandler;
class Element { constructor(){this.children=[];} createDiv(){const x=new Element();this.children.push(x);return x;} createEl(){return this.createDiv();} createSpan(){return this.createDiv();} addClass(){} addEventListener(){} setText(){} empty(){} }
class FileSystemAdapter {getBasePath(){return 'D:\\IsolatedTestVault';}}
class TFile {}
class TFolder {constructor(){this.children=[];}}
class Base {}
class Plugin {
 constructor(){this.manifest={id:'ima-speed-sync',version:'test'};this.saveCalls=0;this.app={vault:{configDir:".obsidian",adapter:new FileSystemAdapter(),getAbstractFileByPath:()=>null,getFiles:()=>[]},workspace:{getLeavesOfType:()=>[]}};}
 async saveData(value){this.saveCalls++;this.savedData=clone(value);}
}
const obsidian={Plugin,PluginSettingTab:Base,ItemView:Base,Modal:Base,Menu:Base,Notice:class{},Setting:Base,WorkspaceLeaf:Base,TFile,TFolder,FileSystemAdapter,Platform:{isWin:true},normalizePath:x=>x.replace(/\\/g,'/'),setIcon(){},addIcon(){},getLanguage:()=> 'zh'};
const bundle=buildSync({entryPoints:['src/main.ts'],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.ps1':'text'},external:['obsidian','ima-pdf-worker','ima-inspector-wasm','@firecrawl/pdf-inspector-wasm']}).outputFiles[0].text;
const moduleObject={exports:{}};
new Function('require','module','exports',bundle)(name=>{
 if(name==='obsidian')return obsidian;
 if(name==='child_process')return {spawn(file,args,options){if(!spawnHandler)throw new Error('No real desktop process permitted');return spawnHandler(file,args,options);}};
 if(name==='ima-pdf-worker')return '';
 if(name==='ima-inspector-wasm')return new Uint8Array();
 if(name==='@firecrawl/pdf-inspector-wasm')return {initSync(){throw new Error('PDF operation outside native-identity tests');}};
 return require(name);
},moduleObject,moduleObject.exports);
const ImaPlugin=moduleObject.exports.default??moduleObject.exports;
global.window=global;
const nativeKb={id:'10000001',name:'改名库'};
const nativeFolder={id:'folder_201',name:'改名月',path:[{id:'folder_201',name:'改名月'}]};
const identityChoice={knowledgeBase:nativeKb,folder:nativeFolder,includeSubfolders:true,identityProvider:'desktop-uia'};
const oldProfile={knowledgeBaseId:'ima_kb_old',knowledgeBaseName:'原库',folderId:'folder_201',folderPath:['原月'],includeSubfolders:true,sourceScope:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',localDestination:'研究/原月',destinationPath:'研究',includeSourceFolder:true};
function fixture(native=false){
 const plugin=new ImaPlugin();
 plugin.settings={...plugin.settings,knowledgeBaseName:'原库',folderName:'原月',sourceFolderPath:['原月'],sourceTargetKind:'folder',destinationPath:'研究',includeSourceFolder:true,includeSubfolders:true,hasConsented:true,showOperationBefore:false,showOperationAfter:false,autoSync:false,contentMode:'general',overwriteSameName:false,enableMarkdownConversion:false,sourceBinding:{version:1,knowledgeBaseName:'原库',remoteFolderName:'原月',localDestination:'研究/原月',sourceScope:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',targetKind:'folder',folderPath:['原月']},sourceIdentity:{version:1,activeKnowledgeBaseId:native?'10000001':'ima_kb_old',profiles:{[native?'10000001':'ima_kb_old']:{...clone(oldProfile),...(native?{knowledgeBaseId:'10000001',identityProvider:'desktop-uia',folderPathIds:['folder_201']}: {})}}}};
 plugin.syncedAttachments=[{sourceId:'knowledge-pdf_existing',sourceScope:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',path:'研究/原月/旧研报.pdf'}];
 plugin.buildArticleIndex=async()=>({metadataByPath:new Map()});
 plugin.ensureConsent=async()=>true;plugin.refreshView=()=>{};plugin.notifyManual=()=>{};plugin.openOperationCard=async()=>null;
 plugin.recordSyncReport=async report=>{plugin.lastReport=report;};
 return plugin;
}
function answer(request){switch(request.action){case 'list-knowledge-bases':return [nativeKb];case 'resolve':return clone(identityChoice);case 'match-records':return 1;default:throw new Error('unexpected action');}}
const state=plugin=>JSON.stringify({settings:plugin.settings,attachments:plugin.syncedAttachments});
async function makeTemporary(){return await fsp.mkdtemp(path.join(os.tmpdir(),'ima-native-integration-'));}
function runObject(id=1){return {id,cancellationPath:null,cancellationRequested:false,process:null};}

test('native worker uses Windows system PowerShell with developer PATH absent and sends exact identity / skip contract',async()=>{
 const plugin=fixture(true),run=runObject();plugin.activeRun=run;plugin.running=true;
 let captured;const previousPath=process.env.PATH;
 spawnHandler=(file,args,options)=>{
   assert.equal(file,path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'));
   assert.equal(options.windowsHide,true);assert.equal(process.env.PATH,path.join(process.env.SystemRoot||'C:\\Windows','System32'));
   captured=JSON.parse(fs.readFileSync(args[args.indexOf('-InputPath')+1],'utf8'));
   assert.equal(captured.operation,'sync');assert.deepEqual(captured.nativeSource,{knowledgeBaseId:'10000001',folderId:'folder_201',folderPath:[{id:'folder_201',name:'原月'}]});
   assert.deepEqual(captured.skipSourceIds,['knowledge-pdf_existing']);assert.equal(captured.downloadDirectory.startsWith(os.tmpdir()),true);
   assert.equal(JSON.stringify(captured).includes('apiKey'),false);assert.equal(JSON.stringify(captured).includes('clientId'),false);
   fs.writeFileSync(args[args.indexOf('-OutputPath')+1],JSON.stringify({items:[],errors:[],skippedTitles:['existing']}));
   const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();process.nextTick(()=>child.emit('close',0,null));return child;
 };
 try{process.env.PATH=path.join(process.env.SystemRoot||'C:\\Windows','System32');await plugin.runPowerShell(100,[],plugin.settings,run,['knowledge-pdf_existing']);assert.ok(captured);assert.equal(plugin.getEffectiveDestinationPath(plugin.settings),'研究/原月');}
 finally{process.env.PATH=previousPath;spawnHandler=undefined;if(run.stagingDirectory)await fsp.rm(run.stagingDirectory,{recursive:true,force:true});}
});
test('silent identity failure retains settings and never takes the desktop task gate',async()=>{
 const plugin=fixture(),before=state(plugin);
 plugin.silentIdentityCall=async()=>{throw Object.assign(new Error('not found'),{code:'not-found'});};
 plugin.runPowerShell=async()=>{throw new Error('Desktop worker must not run');};
 await assert.rejects(plugin.runNativeIdentity({action:'resolve',knowledgeBaseId:'10000001',folderId:'folder_201'}),error=>error.code==='not-found');
 assert.equal(state(plugin),before);assert.equal(plugin.running,false);assert.equal(plugin.activeRun,null);assert.equal(plugin.currentProcess,null);assert.equal(plugin.cancellationPath,null);
});

test('silent source verification preserves parent sync ownership, staging and records',async()=>{
 const plugin=fixture(),parent=runObject(),original=await makeTemporary();parent.stagingDirectory=original;plugin.activeRun=parent;plugin.running=true;
 plugin.silentIdentityCall=async()=>[nativeKb];
 plugin.runPowerShell=async()=>{throw new Error('Desktop worker must not run');};
 try{assert.deepEqual(await plugin.runNativeIdentity({action:'list-knowledge-bases'},parent),[nativeKb]);assert.equal(plugin.activeRun,parent);assert.equal(plugin.running,true);assert.equal(parent.stagingDirectory,original);assert.equal(fs.existsSync(original),true);}
 finally{await fsp.rm(original,{recursive:true,force:true});}
});

test('canceling the parent sync rejects a late silent verification result',async()=>{
 const plugin=fixture(),parent=runObject();plugin.activeRun=parent;plugin.running=true;
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 plugin.silentIdentityCall=async()=>{started();await gate;return [nativeKb];};
 const reading=plugin.runNativeIdentity({action:'list-knowledge-bases'},parent);await ready;parent.cancellationRequested=true;release();await assert.rejects(reading);
 assert.equal(plugin.activeRun,parent);assert.equal(parent.stagingDirectory,undefined);
});

test('successful native migration preserves original scope, save path and attachments',async()=>{
 const plugin=fixture();const attachments=clone(plugin.syncedAttachments);plugin.runNativeIdentity=async request=>answer(request);plugin.identityProvider=plugin.createDesktopIdentityProvider();
 const resolved=await plugin.resolveActiveIdentity();assert.equal(resolved.knowledgeBase.id,'10000001');const profile=plugin.settings.sourceIdentity.profiles['10000001'];
 assert.equal(profile.sourceScope,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(profile.localDestination,'研究/原月');assert.deepEqual(profile.legacyKnowledgeBaseIds,['ima_kb_old']);assert.deepEqual(plugin.syncedAttachments,attachments);assert.equal(plugin.saveCalls,1);
});
test('a failed or ambiguous migration never persists a replacement or changes scope',async()=>{
 for(const mode of ['timeout','ambiguous','missing']){
   const plugin=fixture(),before=state(plugin);plugin.runNativeIdentity=async request=>{
    if(request.action==='list-knowledge-bases')return mode==='ambiguous'?[nativeKb,{id:'10000002',name:nativeKb.name}]:[nativeKb];
    if(request.action==='resolve'&&mode==='timeout')throw new Error('read timed out');
    if(request.action==='resolve'&&mode==='missing')throw Object.assign(new Error('missing'),{code:'not-found'});
    if(request.action==='resolve')return {...clone(identityChoice),knowledgeBase:{id:request.knowledgeBaseId,name:nativeKb.name}};
    return 1;
   };plugin.identityProvider=plugin.createDesktopIdentityProvider();await assert.rejects(plugin.resolveActiveIdentity());assert.equal(state(plugin),before);assert.equal(plugin.saveCalls,0);
 }
});
test('incomplete candidate reads are not mistaken for absence before committing a unique migration',async()=>{
 const plugin=fixture(),before=state(plugin);plugin.runNativeIdentity=async request=>{
  if(request.action==='list-knowledge-bases')return [nativeKb,{id:'10000002',name:'第二库'}];
  if(request.knowledgeBaseId==='10000002')throw new Error('incomplete catalog');return answer(request);
 };plugin.identityProvider=plugin.createDesktopIdentityProvider();await assert.rejects(plugin.resolveActiveIdentity(),/incomplete/);assert.equal(state(plugin),before);assert.equal(plugin.saveCalls,0);
});
test('a native host with no identity profile must not fall through to name-based sync',async()=>{
 const plugin=fixture();delete plugin.settings.sourceIdentity;plugin.identityProvider=plugin.createDesktopIdentityProvider();let extractionCalls=0,folderWrites=0;
 plugin.runPowerShell=async()=>{extractionCalls++;return JSON.stringify({items:[],errors:[],skippedTitles:[]});};plugin.ensureFolder=async()=>{folderWrites++;};
 await plugin.sync(true);assert.equal(extractionCalls,0,'profileless native sync must stop before extraction');assert.equal(folderWrites,0);assert.equal(plugin.running,false);assert.equal(plugin.activeRun,null);assert.match(plugin.lastReport.errors?.[0]?.message??plugin.lastReport.summary,/身份|来源/);
});
test('sync stops before extraction and writes when live identity fails despite a saved profile',async()=>{
 for(const interactive of [true,false]) {
  const plugin=fixture(true),before=state(plugin);let extractionCalls=0,folderWrites=0;
  plugin.identityProvider=plugin.createDesktopIdentityProvider();
  plugin.silentIdentityCall=async request=>{
   assert.notEqual(request.cacheOnly,true,'sync must request live identity');
   throw Object.assign(new Error('目录读取失败，请重试'),{code:'network-unavailable'});
  };
  plugin.runPowerShell=async()=>{extractionCalls++;};
  plugin.ensureFolder=async()=>{folderWrites++;};
  await plugin.sync(interactive);
  assert.equal(extractionCalls,0);assert.equal(folderWrites,0);assert.equal(state(plugin),before);
  assert.equal(plugin.lastReport.status,'failed');assert.match(plugin.lastReport.summary,/无法连接 IMA/);
  assert.equal(plugin.lastReport.action,'source-settings');
 }
});

test('browser mock identity providers remain usable without requiring native profile format',async()=>{
 const plugin=fixture();plugin.identityProvider={listKnowledgeBases:async()=>[{id:'ima_kb_old',name:'展示库'}],resolve:async()=>({knowledgeBase:{id:'ima_kb_old',name:'展示库'},folder:clone(nativeFolder),includeSubfolders:true}),listFolders:async()=>[],matchRecords:async()=>0};
 const result=await plugin.resolveActiveIdentity();assert.equal(result.knowledgeBase.id,'ima_kb_old');assert.equal(plugin.saveCalls,0);
});

test('source health distinguishes a missing folder, missing library, login and network; recovery clears it',async()=>{
 const plugin=fixture(true);plugin.identityProvider=plugin.createDesktopIdentityProvider();
 for(const [code,sourceTarget,pattern] of [
  ['not-found',undefined,/找不到文件夹/],['not-found','knowledge-base',/找不到知识库/],
  ['login-required',undefined,/登录/],['network-unavailable',undefined,/无法连接/],
 ]) {
  plugin.silentIdentityCall=async request=>{
   if(request.action==='list-knowledge-bases')return [nativeKb];
   throw Object.assign(new Error('test failure'),{code,sourceTarget});
  };
  await assert.rejects(plugin.resolveActiveIdentity(),error=>error.action==='source-settings'&&pattern.test(error.message));
  assert.match(plugin.currentSourceProblem,pattern);
  if(code!=='not-found')assert.doesNotMatch(plugin.currentSourceProblem,/找不到/);
 }
 plugin.silentIdentityCall=async request=>answer(request);
 await plugin.resolveActiveIdentity();assert.equal(plugin.currentSourceProblem,'');
});

test('missing library preflight is identified before folder resolution',async()=>{
 const plugin=fixture(true);plugin.identityProvider=plugin.createDesktopIdentityProvider();
 plugin.silentIdentityCall=async()=>[];
 await assert.rejects(plugin.resolveActiveIdentity(),/找不到知识库/);
 assert.match(plugin.currentSourceProblem,/找不到知识库/);
});

test('source recovery shortcut opens settings then scope and the source dialog',()=>{
 const plugin=fixture(true),calls=[];
 plugin.openSettings=()=>calls.push('settings');
 plugin.settingsTab={switchTab:tab=>calls.push(tab),openFlowSettings:group=>calls.push(group)};
 plugin.openSourceSettings();assert.deepEqual(calls,['settings','scope','source']);
});
test('native plugin bundle has no credential resolver or official IMA API authorization dependency',()=>{
 for(const needle of ['getImaCredentials','op-ai.ps1','ima-openapi-apikey','ima-openapi-clientid']) assert.equal(bundle.includes(needle),false,needle);
});
test('same-ID migration updates a suspended batch context without losing its exact targets',async()=>{
 const plugin=fixture();const pendingId='knowledge-pdf_oldarticlewithid123456';plugin.syncedAttachments[0].sourceId=pendingId;
 const record={sourceTitle:'旧研报',sourceId:pendingId,kind:'pdf',relativeFolder:['原日目录'],relativeFolderIds:['folder_202'],scrollPercent:20,scrollStep:0};
 plugin.settings.pendingSourceResume={version:1,sourceScope:'a'.repeat(64),localDestination:'研究/原月',knowledgeBaseName:'原库',folderName:'原月',folderPath:['原月'],records:[record],unresumableCount:0};
 plugin.runNativeIdentity=async request=>answer(request);plugin.identityProvider=plugin.createDesktopIdentityProvider();
 const beforeRecords=clone(plugin.settings.pendingSourceResume.records);await plugin.resolveActiveIdentity();
 assert.doesNotThrow(()=>plugin.assertPendingSourceContext(plugin.getPendingSourceResume(),plugin.settings));
 assert.deepEqual(plugin.settings.pendingSourceResume.records,beforeRecords);assert.equal(plugin.settings.pendingSourceResume.localDestination,'研究/原月');assert.equal(plugin.settings.pendingSourceResume.sourceScope,'a'.repeat(64));
});
test('a migration persistence failure rolls back the active identity and its original scope',async()=>{
 const plugin=fixture(),before=state(plugin);plugin.runNativeIdentity=async request=>answer(request);plugin.identityProvider=plugin.createDesktopIdentityProvider();plugin.saveData=async()=>{throw new Error('disk failure');};
 await assert.rejects(plugin.resolveActiveIdentity(),/disk failure/);assert.equal(state(plugin),before);
});
test('Windows lock during automatic native preflight defers instead of recording a failed sync',async()=>{
 const plugin=fixture(true);plugin.settings.autoSync=true;plugin.silentIdentityCall=async request=>answer(request);plugin.identityProvider=plugin.createDesktopIdentityProvider();let scheduled=false;
 plugin.ensureFolder=async()=>{};plugin.runPowerShell=async()=>JSON.stringify({locked:true,items:[],errors:[]});plugin.scheduleDeferredSync=()=>{scheduled=true;};
 await plugin.sync(false);assert.equal(scheduled,true);assert.notEqual(plugin.lastReport?.status,'failed');assert.equal(plugin.running,false);assert.equal(plugin.activeRun,null);
});
test('live Web host keeps the real desktop provider and automatically migrates saved API profiles over HTTP',async()=>{
 const {configureIdentityProvider,requestNativeIdentity}=await import('../web/obsidian-host.mjs');
 const plugin=fixture();plugin.identityProvider=plugin.createDesktopIdentityProvider();const original=plugin.identityProvider;const calls=[],http=[];
 const fakeFetch=async(url,options)=>{
   assert.equal(url,'/api/identity');const body=JSON.parse(options.body);http.push(body);assert.equal(body.operation,'nativeIdentity');const request=body.args[0];
   let value;if(request.action==='list-knowledge-bases')value=[{id:'10000000',name:'其他库'},nativeKb];
   else if(request.knowledgeBaseId==='10000000')return {ok:false,json:async()=>({error:'目标目录不存在',code:'not-found'})};
   else value=answer(request);return {ok:true,json:async()=>({value})};
 };
 configureIdentityProvider(plugin,{id:'live',nativeIdentity:request=>requestNativeIdentity(request,fakeFetch)},calls);
 assert.equal(plugin.identityProvider,original);await plugin.resolveActiveIdentity();
 assert.equal(plugin.settings.sourceIdentity.activeKnowledgeBaseId,'10000001');assert.equal(plugin.settings.sourceBinding.sourceScope,'a'.repeat(64));assert.equal(plugin.settings.sourceBinding.localDestination,'研究/原月');assert.equal(plugin.syncedAttachments.length,1);
 assert.ok(http.some(body=>body.args[0].knowledgeBaseId==='10000000'));assert.ok(calls.every(call=>call.operation==='identity.native'));assert.equal(plugin.saveCalls,1);
});
test('new and configured Web demos stay on local mocks and never invoke the live transport',async()=>{
 const {configureIdentityProvider}=await import('../web/obsidian-host.mjs');const {createScenario}=await import('../web/scenarios.mjs');
 for(const scenarioId of ['new','configured','renamed']){
   const plugin=fixture();plugin.identityProvider=plugin.createDesktopIdentityProvider();const original=plugin.identityProvider;const scenario=createScenario(scenarioId);let realCalls=0;scenario.nativeIdentity=async()=>{realCalls++;throw new Error('live transport must stay disabled');};
   configureIdentityProvider(plugin,scenario,[]);assert.notEqual(plugin.identityProvider,original);const bases=await plugin.identityProvider.listKnowledgeBases();assert.ok(bases.length);assert.equal(realCalls,0);
 }
});
test('live HTTP source failures retain the machine-readable reason used by migration',async()=>{
 const {requestNativeIdentity}=await import('../web/obsidian-host.mjs');
 for(const code of ['not-found','locked','busy','incomplete'])await assert.rejects(requestNativeIdentity({action:'resolve',knowledgeBaseId:'10000001'},async()=>({ok:false,json:async()=>({error:'读取失败',code})})),error=>error.code===code&&error.message==='读取失败');
});
test('silent source reading does not navigate or take over an active desktop sync',async()=>{
 const plugin=fixture(true),run=runObject();plugin.running=true;plugin.activeRun=run;
 plugin.runPowerShell=async()=>{throw new Error('busy host must not start another worker');};
 plugin.silentIdentityCall=async()=>[nativeKb];assert.deepEqual(await plugin.runNativeIdentity({action:'list-knowledge-bases'}),[nativeKb]);
 assert.equal(plugin.activeRun,run);assert.equal(plugin.running,true);
});

function prepareExtractedSync(result){
 const plugin=fixture(true),saved=[],requests=[];
 plugin.runNativeIdentity=async request=>answer(request);plugin.identityProvider=plugin.createDesktopIdentityProvider();
 plugin.ensureFolder=async()=>{};
 plugin.runPowerShell=async(_max,_titles,_settings,_run,skipIds,operation)=>{requests.push({skipIds,operation});return JSON.stringify(result);};
 plugin.saveArticle=async(item,destination)=>{saved.push({id:item.sourceId,destination});return 'created';};
 plugin.app.vault.getAbstractFileByPath=()=>new TFile();
 return {plugin,saved,requests};
}

test('native articles with absent or inconsistent directory IDs fail before any vault import or mapping update',async()=>{
 for(const malformed of [
   {relativeFolder:['新日目录']},
   {relativeFolder:[]},
   {relativeFolder:['新日目录'],relativeFolderIds:[]},
   {relativeFolder:[],relativeFolderIds:['folder_202']},
   {relativeFolder:['新日目录'],relativeFolderIds:['not-a-folder-id']},
   {relativeFolder:['父','子'],relativeFolderIds:['folder_202','folder_202']},
 ]){
   const {plugin,saved}=prepareExtractedSync({items:[
     {sourceTitle:'完整条目',sourceId:'knowledge-good',body:'body',relativeFolder:[],relativeFolderIds:[]},
     {sourceTitle:'缺少目录身份',sourceId:'knowledge-incomplete',body:'body',...malformed},
   ],errors:[]});
   const beforeAttachments=clone(plugin.syncedAttachments);
   await plugin.sync(true);
   assert.deepEqual(saved,[]);assert.equal(plugin.lastReport.status,'failed');assert.match(plugin.lastReport.errors[0].message,/目录.*ID/);
   assert.equal(plugin.settings.sourceIdentity.profiles['10000001'].folderDestinations,undefined);
   assert.equal(plugin.getEffectiveDestinationPath(plugin.settings),'研究/原月');assert.deepEqual(plugin.syncedAttachments,beforeAttachments);
 }
});

test('native skipped-article observations pin renamed subfolders while explicit root IDs stay at the original root',async()=>{
 const {plugin,saved,requests}=prepareExtractedSync({items:[
   {sourceTitle:'根目录新文章',sourceId:'knowledge-root-new',body:'body',relativeFolder:[],relativeFolderIds:[]},
   {sourceTitle:'子目录新文章',sourceId:'knowledge-child-new',body:'body',relativeFolder:['改名日目录'],relativeFolderIds:['folder_202']},
 ],errors:[],skippedTitles:['旧研报'],sourceFolderObservations:[{sourceId:'knowledge-pdf_existing',relativeFolder:['改名日目录'],relativeFolderIds:['folder_202']}]});
 plugin.syncedAttachments[0].path='研究/原月/原日目录/旧研报.pdf';
 const beforeAttachments=clone(plugin.syncedAttachments);
 await plugin.sync(true);
 assert.equal(plugin.lastReport.status,'success');
 assert.deepEqual(new Map(saved.map(item=>[item.id,item.destination])),new Map([['knowledge-root-new','研究/原月'],['knowledge-child-new','研究/原月/原日目录']]));
 assert.deepEqual(requests,[{skipIds:['knowledge-pdf_existing'],operation:'sync'}]);
 assert.deepEqual(plugin.settings.sourceIdentity.profiles['10000001'].folderDestinations,{'[]':[],'["folder_202"]':['原日目录']});
 assert.equal(plugin.settings.sourceIdentity.profiles['10000001'].sourceScope,'a'.repeat(64));assert.deepEqual(plugin.syncedAttachments,beforeAttachments);
});

test('capturing a pending batch clones its folder ID chain before retaining it',()=>{
 const plugin=fixture(true);
 const record={sourceTitle:'待补文章',sourceId:'knowledge-pdf_existing',kind:'pdf',relativeFolder:['原日目录'],relativeFolderIds:['folder_202'],scrollPercent:0,scrollStep:0};
 plugin.capturePendingSourceResume({sourceNeedsRebind:{reason:'path-changed',expectedPath:['原月'],actualPath:[],message:'changed'},sourcePendingRecords:[record]},plugin.settings);
 const captured=plugin.settings.pendingSourceResume.records[0];
 assert.deepEqual(captured,record);assert.notEqual(captured.relativeFolder,record.relativeFolder);assert.notEqual(captured.relativeFolderIds,record.relativeFolderIds);
 record.relativeFolderIds[0]='folder_999';record.relativeFolder[0]='changed later';
 assert.deepEqual(captured.relativeFolderIds,['folder_202']);assert.deepEqual(captured.relativeFolder,['原日目录']);
});
test('native source preflight preserves fixed-root speed-reader imports without inventing directory IDs',async()=>{
 const {plugin,saved,requests}=prepareExtractedSync({items:[{sourceTitle:'速读文章',sourceId:'knowledge-speed-reader',body:'body'}],errors:[]});
 plugin.settings.contentMode='speed-reader';
 plugin.buildArticleIndex=async()=>({metadataByPath:new Map(),sourceTitles:new Set(),markdownByBasename:new Map()});
 await plugin.sync(true);
 assert.equal(plugin.lastReport.status,'success');assert.deepEqual(saved,[{id:'knowledge-speed-reader',destination:'研究/原月'}]);
 assert.equal(requests.length,1);assert.equal(plugin.settings.sourceIdentity.profiles['10000001'].folderDestinations,undefined);
});
