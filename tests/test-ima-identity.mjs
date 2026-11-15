import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
const bundle=buildSync({entryPoints:['src/ima-identity-provider.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',bundle.outputFiles[0].text)(mod,mod.exports);
const {ImaIdentityProvider}=mod.exports;
const root={folder_id:'kb-a',name:'库 A',parent_folder_id:''};
const folder={folder_id:'folder-a',name:'月目录',parent_folder_id:'kb-a'};
const ok=data=>({code:0,msg:'success',data});
const listing=(rows=[],path=[root],is_end=true,next_cursor='')=>ok({knowledge_list:rows,current_path:path,is_end,next_cursor});
test('actual search field names and complete pagination are supported',async()=>{
 const calls=[]; const p=new ImaIdentityProvider(async(method,body)=>{calls.push(body);return body.cursor?ok({info_list:[{id:'kb-b',name:'库 B'}],is_end:true}):ok({info_list:[{kb_id:'kb-a',kb_name:'库 A'}],is_end:false,next_cursor:'next'});});
 assert.deepEqual((await p.listKnowledgeBases()).map(x=>x.id),['kb-a','kb-b']);assert.equal(calls[1].cursor,'next');
});
test('auth errors and malformed or incomplete lists fail instead of returning empty sources',async()=>{
 for(const response of [{code:200002,msg:'skill auth failed'},ok({info_list:[],is_end:undefined}),ok({is_end:true})]){const p=new ImaIdentityProvider(async()=>response);await assert.rejects(p.listKnowledgeBases());}
});
test('repeated pagination cursor fails instead of hanging or accepting partial data',async()=>{
 const p=new ImaIdentityProvider(async()=>ok({info_list:[],is_end:false,next_cursor:'same'}));await assert.rejects(p.listKnowledgeBases(),/分页未前进/);
});
test('a directory is resolved by stable ID while its visible name changes',async()=>{
 const p=new ImaIdentityProvider(async()=>listing([],[root,{...folder,name:'改名后的月目录'}]));
 const choice=await p.resolve('kb-a','folder-a');assert.equal(choice.folder.id,'folder-a');assert.equal(choice.folder.name,'改名后的月目录');
});
test('foreign or stale folder identity and wrong parent chains are rejected',async()=>{
 for(const path of [[{...root,folder_id:'other'}],[root,{...folder,parent_folder_id:'other'}],[root,{...folder,folder_id:'recreated'}]]){
  const p=new ImaIdentityProvider(async()=>listing([],path));await assert.rejects(p.resolve('kb-a','folder-a'));
 }
});
test('folders remain separate from PDF files across directory pagination',async()=>{
 const p=new ImaIdentityProvider(async(_,body)=>body.cursor?listing([{media_type:99,media_id:'folder-a',title:'月目录',parent_folder_id:'kb-a'}]):listing([{media_type:1,media_id:'pdf-a',title:'研报',parent_folder_id:'kb-a'}],[root],false,'next'));
 const rows=await p.listFolders('kb-a');assert.deepEqual(rows.map(x=>x.id),['folder-a']);assert.deepEqual(rows[0].path,[{id:'folder-a',name:'月目录'}]);
});
test('legacy record bridge accepts verified PDF ID convention and does not guess note identities',async()=>{
 const p=new ImaIdentityProvider(async()=>listing([{media_type:1,media_id:'pdf-a',title:'研报',parent_folder_id:'kb-a'},{media_type:11,media_id:'note-a',title:'笔记',parent_folder_id:'kb-a'}]));
 assert.equal(await p.matchRecords({knowledgeBase:{id:'kb-a',name:'库 A'},includeSubfolders:false},['knowledge-pdf-a','knowledge-note-a']),1);
});
test('same-name distinct KBs fail desktop preflight rather than choosing by name',async()=>{
 const p=new ImaIdentityProvider(async()=>ok({info_list:[{kb_id:'kb-a',kb_name:'库 A'},{kb_id:'kb-b',kb_name:'库 A'}],is_end:true}));
 await assert.rejects(p.assertDesktopNamesUnique({knowledgeBase:{id:'kb-a',name:'库 A'},includeSubfolders:true}),/同名知识库/);
});
test('a same-name duplicate folder fails desktop preflight',async()=>{
 const p=new ImaIdentityProvider(async(method)=>method==='search_knowledge_base'?ok({info_list:[{kb_id:'kb-a',kb_name:'库 A'}],is_end:true}):listing([{media_id:'folder-a',title:'月目录',media_type:99,parent_folder_id:'kb-a'},{media_id:'folder-b',title:'月目录',media_type:99,parent_folder_id:'kb-a'}]));
 await assert.rejects(p.assertDesktopNamesUnique({knowledgeBase:{id:'kb-a',name:'库 A'},folder:{id:'folder-a',name:'月目录',path:[{id:'folder-a',name:'月目录'}]},includeSubfolders:true}),/同名/);
});
