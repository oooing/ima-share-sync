import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const mod = {exports:{}}; new Function('require','module','exports',code)(id=>overrides[id]??require(id),mod,mod.exports);return mod.exports;
}
const {SilentDirectoryService}=load('src/silent-directory.ts');
const {chooseIdentity,refreshIdentityLabels}=load('src/source-identity.ts');
const kb='10000001', other='10000002', f='folder_201', child='folder_202';
const node=(folder_id,name,parent_folder_id='')=>({folder_id,name,parent_folder_id});
const root=node(kb,'研报库'), month=node(f,'十月',kb), day=node(child,'日报',f);
function fixture(options={}) {
 const calls=[];
 const query=async(endpoint,body)=>{
  calls.push({endpoint,body});
  if(options.query){const overridden=await options.query(endpoint,body);if(overridden!==undefined)return overridden;}
  if(endpoint==='get_knowledge_base_list')return {results:body.params.map(p=>({type:p.type,is_end:true,next_cursor:'',knowledge_base_list:p.type===1001?[{id:kb,basic_info:{name:root.name,has_deleted:false}}]:[]}))};
  if(endpoint==='get_folder_list'){
   const paths={'':[root],[f]:[root,month],[child]:[root,month,day]};
   const children={'':[month],[f]:[day],[child]:[]};
   return {current_path:paths[body.folder_id],folder_list:children[body.folder_id].map(item=>({...item,parent_folder_id:''})),is_end:true,next_cursor:'unused-at-end'};
  }
  return {current_path:body.folder_id===child?[root,month,day]:[root,month],knowledge_list:body.folder_id===child?[{media_id:'pdf_2'}]:[{media_id:'pdf_1'},{media_id:child}],is_end:true};
 };
 return {service:new SilentDirectoryService(query,options.cache),calls};
}
test('silent list returns complete directories and stable ID chains, with exact path verification',async()=>{
 const {service,calls}=fixture();const rows=await service.call({action:'list-folders',knowledgeBaseId:kb,folderId:f});
 assert.deepEqual(rows,[{id:child,name:'日报',path:[{id:f,name:'十月'},{id:child,name:'日报'}]}]);
 assert.ok(calls.some(c=>c.endpoint==='get_folder_list'&&c.body.folder_id===''));
 const selected=await service.call({action:'resolve',knowledgeBaseId:kb,folderId:child});
 assert.equal(selected.identityProvider,'desktop-uia');assert.equal(selected.folder.id,child);
});
test('cached browsing is immediate and never invokes network; resolve cannot accept a cached identity',async()=>{
 const {service,calls}=fixture();await service.call({action:'list-folders',knowledgeBaseId:kb,folderId:f});const count=calls.length;
 assert.equal((await service.call({action:'list-folders',knowledgeBaseId:kb,folderId:f,cacheOnly:true})).length,1);assert.equal(calls.length,count);
 await assert.rejects(service.call({action:'resolve',knowledgeBaseId:kb,folderId:f,cacheOnly:true}));
 await service.call({action:'resolve',knowledgeBaseId:kb,folderId:f});assert.ok(calls.length>count);
});
test('deleted KB returning successful detail cannot be rebound, including a same-name replacement',async()=>{
 const {service,calls}=fixture({query:(e,b)=>e==='get_knowledge_base_list'?{results:b.params.map(p=>({type:p.type,is_end:true,knowledge_base_list:p.type===1001?[{id:other,basic_info:{name:'研报库',has_deleted:false}}]:[]}))}:undefined});
 await assert.rejects(service.call({action:'resolve',knowledgeBaseId:kb,folderId:f}),e=>e.code==='not-found');assert.equal(calls.length,1);
});
test('deleted folder still answering detail must be present by ID in parent, never by name',async()=>{
 const {service}=fixture({query:(e,b)=>e==='get_folder_list'&&b.folder_id===''?{current_path:[root],folder_list:[node('folder_999','十月',kb)],is_end:true}:undefined});
 await assert.rejects(service.call({action:'resolve',knowledgeBaseId:kb,folderId:f}),e=>e.code==='not-found');
});
test('cross-library path and forged parent chains are rejected',async()=>{
 for(const path of [[node(other,'另一库'),month],[root,node(f,'十月',other)]]){
  const {service}=fixture({query:(e,b)=>e==='get_folder_list'&&b.folder_id===f?{current_path:path,folder_list:[],is_end:true}:undefined});
  await assert.rejects(service.call({action:'resolve',knowledgeBaseId:kb,folderId:f}));
 }
});
test('folder pagination consumes all pages and a terminal cursor is not mistaken for more results',async()=>{
 const {service,calls}=fixture({query:(e,b)=>e==='get_folder_list'&&b.folder_id===f?{current_path:[root,month],folder_list:[node(b.cursor?'folder_203':child,b.cursor?'第二个':'日报',f)],is_end:!!b.cursor,next_cursor:'second'}:undefined});
 assert.equal((await service.call({action:'list-folders',knowledgeBaseId:kb,folderId:f})).length,2);
 assert.equal(calls.filter(c=>c.endpoint==='get_folder_list'&&c.body.folder_id===f).length,2);
});
test('missing pagination flags, repeated cursor, duplicate IDs and missing KB groups cannot claim completeness',async()=>{
 for(const variant of ['missing','repeat','duplicate','groups']){
  const {service}=fixture({query:(e,b)=>{
   if(variant==='groups'&&e==='get_knowledge_base_list')return {results:[]};
   if(e==='get_folder_list'&&b.folder_id===f)return {current_path:[root,month],folder_list:variant==='duplicate'?[day,day]:[day],...(variant==='missing'?{}:{is_end:variant!=='repeat',next_cursor:'loop'})};
  }});
  await assert.rejects(service.call({action:'list-folders',knowledgeBaseId:kb,folderId:f}));
 }
});
test('matching existing records visits subfolders only when requested and never downloads files',async()=>{
 const {service,calls}=fixture();const request={action:'match-records',knowledgeBaseId:kb,folderId:f,sourceIds:['knowledge-pdf_1','knowledge-pdf_1','knowledge-pdf_2']};
 assert.equal(await service.call({...request,includeSubfolders:false}),1);
 assert.equal(await service.call({...request,includeSubfolders:true}),2);
 assert.ok(calls.every(c=>['get_folder_list','get_knowledge_base_list','get_knowledge_list'].includes(c.endpoint)));
});
test('restart cache cannot mask a remote failure or change old storage and record scopes',async()=>{
 const {service}=fixture();const choice=await service.call({action:'resolve',knowledgeBaseId:kb,folderId:f});
 const settings={knowledgeBaseName:'旧名',folderName:'旧月',sourceTargetKind:'folder',sourceFolderPath:['旧月'],includeSubfolders:true,destinationPath:'原保存位置',includeSourceFolder:true,records:[{id:'existing'}]};
 const before=chooseIdentity(settings,choice,()=> 'old-scope');
 const renamed=structuredClone(choice);renamed.knowledgeBase.name='新库名';renamed.folder.name='新月';renamed.folder.path[0].name='新月';
 const after=refreshIdentityLabels(before,renamed);
 assert.equal(after.sourceBinding.sourceScope,before.sourceBinding.sourceScope);assert.equal(after.sourceBinding.localDestination,before.sourceBinding.localDestination);assert.deepEqual(after.records,before.records);
 const restarted=new SilentDirectoryService(async()=>{throw new Error('offline');},JSON.parse(JSON.stringify(service.cache)));
 assert.ok(await restarted.call({action:'list-folders',knowledgeBaseId:kb,folderId:f,cacheOnly:true}));
 await assert.rejects(restarted.call({action:'resolve',knowledgeBaseId:kb,folderId:f}),/offline/);
 assert.deepEqual(before.records,[{id:'existing'}]);
});
test('HTTP failures and login expiry return sanitized errors with no login/refresh/redirect request',async()=>{
 for(const response of [{status:302,body:'secret'},{status:200,body:'{"code":41,"msg":"secret"}'},{status:200,body:'secret'}]){
  const calls=[];
  const runner=load('src/silent-identity-runner.ts',{'https':{request(options,callback){calls.push(options);const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=response.status;res.setEncoding=()=>{};callback(res);queueMicrotask(()=>{res.emit('data',response.body);res.emit('end');req.emit('close');});};req.destroy=()=>req.emit('error',new Error('secret'));return req;}}});
  await assert.rejects(runner.queryDirectories({})('get_folder_list',{}),error=>!error.message.includes('secret'));
  assert.equal(calls.length,1);assert.equal(calls[0].hostname,'ima.qq.com');assert.equal(calls[0].path,'/cgi-bin/knowledge_tab_reader/get_folder_list');
 }
});

test('standalone runner reuses in-memory login and persists only account-separated directory metadata',async()=>{
 let decrypts=0,requests=0,writes=0;
 const files=new Map();
 const prefs=JSON.stringify({tencent:{wxlogin:{account_meta:JSON.stringify({user_id:'fixture-account'}),account_secret_encrypted:'encrypted-fixture'}}});
 const overrides={
  'fs/promises':{readFile:async file=>String(file).endsWith('Preferences')?prefs:files.get(file)??Promise.reject(new Error('missing')),mkdir:async()=>{},writeFile:async(file,data)=>{writes++;assert.doesNotMatch(data,/SECRET|TOKEN|REFRESH/);files.set(file,data);}},
  'child_process':{execFile(file,args,options,callback){decrypts++;assert.equal(options.windowsHide,true);assert.match(file,/WindowsPowerShell/);assert.doesNotMatch(JSON.stringify(args),/FAKE-SECRET/);callback(null,JSON.stringify({uid:'fixture-account',token:'FAKE-SECRET-TOKEN',refresh:'FAKE-SECRET-REFRESH',version:'150.0',idType:1,tokenType:1}));}},
  'https':{request(options,callback){requests++;assert.equal(options.hostname,'ima.qq.com');const req=new EventEmitter();req.end=body=>{const params=JSON.parse(body).params;const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};callback(res);queueMicrotask(()=>{res.emit('data',JSON.stringify({code:0,results:params.map(p=>({type:p.type,is_end:true,knowledge_base_list:p.type===1001?[{id:kb,basic_info:{name:'测试库',has_deleted:false}}]:[]}))}));res.emit('end');req.emit('close');});};return req;}}
 };
 const runner=load('src/silent-identity-runner.ts',overrides);
 await runner.runSilentIdentity({action:'list-knowledge-bases'});await runner.runSilentIdentity({action:'list-knowledge-bases'});
 assert.equal(decrypts,1);assert.equal(requests,2);assert.equal(writes,2);
 const restarted=load('src/silent-identity-runner.ts',overrides);
 assert.deepEqual(await restarted.runSilentIdentity({action:'list-knowledge-bases',cacheOnly:true}),[{id:kb,name:'测试库'}]);
 assert.equal(decrypts,1);assert.equal(requests,2);assert.equal(writes,2);
});
