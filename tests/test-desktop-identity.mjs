import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
function load(entry) {
  const bundle = buildSync({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
  const mod={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(mod,mod.exports,id=>{if(id==='obsidian')return {Modal:class {}};throw new Error('Unexpected dependency '+id);});return mod.exports;
}
const {DesktopIdentityProvider}=load('src/desktop-identity-provider.ts');
const {activeProfile,chooseIdentity,refreshIdentityLabels,migrateDesktopIdentity,desktopSource,verifyIdentity,updateIdentityOptions}=load('src/source-identity.ts');
const clone=value=>JSON.parse(JSON.stringify(value));
const kb={id:'10000001',name:'研报库'};
const path=[{id:'folder_201',name:'十月'},{id:'folder_202',name:'日报'}];
const selected=(changes={})=>({knowledgeBase:{...kb},folder:{...path[1],path:clone(path)},includeSubfolders:true,identityProvider:'desktop-uia',...changes});
const input={knowledgeBaseName:'旧研报库',folderName:'旧日报',sourceTargetKind:'folder',sourceFolderPath:['旧十月','旧日报'],includeSubfolders:false,destinationPath:'研究/研报',includeSourceFolder:true,overwrite:false,maxItems:100,allowLargeSync:false,maxTotalMegabytes:200,scheduledTime:'08:30',skipExisting:true,titleFilterMode:'none',titleFilter:''};
const oldProfile={knowledgeBaseId:'ima_kb_old',knowledgeBaseName:'旧研报库',folderId:'folder_202',folderPath:['旧十月','旧日报'],includeSubfolders:false,sourceScope:'old-scope',localDestination:'研究/研报/旧日报',destinationPath:'研究/研报',includeSourceFolder:true,folderDestinations:{'["folder_203"]':['原子目录']}};
const oldState=()=>({...clone(input),sourceBinding:{version:1,knowledgeBaseName:input.knowledgeBaseName,remoteFolderName:input.folderName,localDestination:oldProfile.localDestination,sourceScope:oldProfile.sourceScope,targetKind:'folder',folderPath:input.sourceFolderPath},sourceIdentity:{version:1,activeKnowledgeBaseId:oldProfile.knowledgeBaseId,rangeReviewRequired:false,profiles:{[oldProfile.knowledgeBaseId]:clone(oldProfile)}},attachments:[{sourceId:'knowledge-pdf_fixture',sourceScope:'old-scope',path:'研究/研报/旧日报/原子目录/报告.pdf'}],records:[{status:'success',saved:1}]});
const evidence={previousKnowledgeBaseId:'ima_kb_old',matchedRecords:20,candidateKnowledgeBaseIds:['10000001']};
const migrate=()=>migrateDesktopIdentity(oldState(),selected(),evidence);

test('native provider accepts separate same-name KBs and only returns native numeric IDs',async()=>{
 const p=new DesktopIdentityProvider(async()=>[kb,{id:'10000002',name:kb.name}]);
 assert.deepEqual((await p.listKnowledgeBases()).map(x=>x.id),['10000001','10000002']);
 for(const reply of [[kb,kb],[{id:'ima_kb_old',name:'库'}],null,{rows:[kb]}]) await assert.rejects(new DesktopIdentityProvider(async()=>reply).listKnowledgeBases());
});
test('native provider rejects a recreated same-name folder, foreign KB and broken paths',async()=>{
 const cases=[selected({folder:{id:'folder_999',name:'日报',path:[{id:'folder_999',name:'日报'}]}}),selected({knowledgeBase:{id:'10000002',name:kb.name}}),selected({folder:{...path[1],path:[path[1],path[1]]}})];
 for(const value of cases) await assert.rejects(new DesktopIdentityProvider(async()=>value).resolve(kb.id,'folder_202'));
});
test('list-folder results must be immediate children of requested parent',async()=>{
 const p=new DesktopIdentityProvider(async()=>[selected().folder]);
 assert.equal((await p.listFolders(kb.id,'folder_201'))[0].id,'folder_202');
 await assert.rejects(p.listFolders(kb.id));await assert.rejects(p.listFolders(kb.id,'folder_999'));
 await assert.rejects(new DesktopIdentityProvider(async()=>[selected().folder,selected().folder]).listFolders(kb.id,'folder_201'));
});
test('saved path hints survive host restart but always revalidate through the native worker',async()=>{
 const profile=activeProfile(JSON.parse(JSON.stringify(migrate())));const calls=[];
 const p=new DesktopIdentityProvider(async req=>{calls.push(req);return selected({knowledgeBase:{...kb,name:'库已改名'},folder:{id:'folder_202',name:'新日报',path:[{id:'folder_201',name:'新十月'},{id:'folder_202',name:'新日报'}]}});},[profile]);
 const first=await p.resolve(kb.id,'folder_202');assert.equal(first.folder.name,'新日报');
 await p.resolve(kb.id,'folder_202');assert.equal(calls.length,2);assert.equal(calls[0].folderPath[0].id,'folder_201');assert.equal(calls[1].folderPath[0].name,'新十月');
});
test('a path hint cannot cause a missing directory to be accepted from cache',async()=>{
 let count=0;const p=new DesktopIdentityProvider(async()=>{if(count++)throw new Error('目标ID不存在');return selected();});
 await p.resolve(kb.id,'folder_202');await assert.rejects(p.resolve(kb.id,'folder_202'),/不存在/);
});
test('navigation calls are serialized and a rejected call does not poison the queue',async()=>{
 let release;const gate=new Promise(r=>release=r);const order=[];
 const p=new DesktopIdentityProvider(async req=>{order.push(req.action);if(order.length===1){await gate;throw new Error('temporary');}return [kb];});
 const first=p.listKnowledgeBases();const handled=assert.rejects(first,/temporary/);const second=p.listKnowledgeBases();
 await Promise.resolve();assert.equal(order.length,1);release();await handled;await second;assert.equal(order.length,2);
});
test('record comparison passes exact IDs, deduplicates inputs and checks returned count',async()=>{
 let sent;const p=new DesktopIdentityProvider(async req=>{sent=req;return 2;});
 assert.equal(await p.matchRecords(selected(),['a','a','b']),2);assert.deepEqual(sent.sourceIds,['a','b']);assert.equal(sent.folderId,'folder_202');
 for(const value of [-1,3,'1',1.5]) await assert.rejects(new DesktopIdentityProvider(async()=>value).matchRecords(selected(),['a','b']));
});
test('missing native KB never resolves a same-name replacement',async()=>{
 let resolved=false;const p=new DesktopIdentityProvider(async req=>{if(req.action==='list-knowledge-bases')return [{id:'10000002',name:kb.name}];resolved=true;return selected();});
 await assert.rejects(verifyIdentity(p,'10000001','folder_202'),/暂不可用/);assert.equal(resolved,false);
});
test('migration updates only identity and labels, preserving settings, destinations, scopes and old data',()=>{
 const before=oldState(),snapshot=clone(before);const after=migrateDesktopIdentity(before,selected(),evidence);const profile=activeProfile(after);
 assert.deepEqual(before,snapshot);assert.equal(after.sourceIdentity.activeKnowledgeBaseId,'10000001');assert.deepEqual(profile.legacyKnowledgeBaseIds,['ima_kb_old']);
 assert.equal(profile.identityProvider,'desktop-uia');assert.equal(profile.sourceScope,oldProfile.sourceScope);assert.equal(profile.localDestination,oldProfile.localDestination);assert.equal(profile.destinationPath,oldProfile.destinationPath);assert.equal(profile.includeSubfolders,false);assert.equal(after.sourceIdentity.rangeReviewRequired,false);
 assert.deepEqual(profile.folderDestinations,oldProfile.folderDestinations);assert.deepEqual(after.attachments,before.attachments);assert.deepEqual(after.records,before.records);assert.equal(after.overwrite,false);assert.deepEqual(profile.folderPathIds,['folder_201','folder_202']);
});
test('migration cannot be approved by matching names, a zero-record sample or ambiguous candidates',()=>{
 for(const changed of [{matchedRecords:0},{matchedRecords:-1},{matchedRecords:1.5},{candidateKnowledgeBaseIds:['10000001','10000002']},{candidateKnowledgeBaseIds:['10000002']},{previousKnowledgeBaseId:'ima_kb_other'}])assert.throws(()=>migrateDesktopIdentity(oldState(),selected(),{...evidence,...changed}),/未唯一核实/);
 assert.throws(()=>migrateDesktopIdentity(oldState(),selected({folder:{id:'folder_999',name:'旧日报',path:[{id:'folder_999',name:'旧日报'}]}}),evidence),/未唯一核实/);
});
test('migration cannot merge a pre-existing independent native source',()=>{
 const settings=oldState();settings.sourceIdentity.profiles['10000001']={...clone(oldProfile),knowledgeBaseId:'10000001',sourceScope:'other-scope'};
 assert.throws(()=>migrateDesktopIdentity(settings,selected(),evidence),/不能自动合并/);
});
test('KB, parent and selected folder rename change labels while preserving historical storage',()=>{
 const before=migrate(),beforeProfile=clone(activeProfile(before));const changed=selected({knowledgeBase:{id:'10000001',name:'2028研报库'},folder:{id:'folder_202',name:'新日报',path:[{id:'folder_201',name:'新十月'},{id:'folder_202',name:'新日报'}]}});
 const after=refreshIdentityLabels(before,changed);const profile=activeProfile(after);
 assert.equal(after.knowledgeBaseName,'2028研报库');assert.deepEqual(profile.folderPath,['新十月','新日报']);assert.equal(profile.localDestination,beforeProfile.localDestination);assert.equal(profile.sourceScope,beforeProfile.sourceScope);assert.deepEqual(profile.folderDestinations,beforeProfile.folderDestinations);assert.deepEqual(after.attachments,before.attachments);assert.deepEqual(profile.legacyKnowledgeBaseIds,beforeProfile.legacyKnowledgeBaseIds);
});
test('same-name recreation is never treated as rename',()=>{
 const before=migrate();assert.throws(()=>refreshIdentityLabels(before,selected({knowledgeBase:{id:'10000002',name:kb.name}})),/不一致/);
 assert.throws(()=>refreshIdentityLabels(before,selected({folder:{id:'folder_999',name:'日报',path:[{id:'folder_999',name:'日报'}]}})),/不一致/);
});
test('choosing a new same-name source has a new scope and retains the old profile',()=>{
 const before=migrate();const after=chooseIdentity(before,selected({knowledgeBase:{id:'10000002',name:kb.name}}),x=>'hash:'+x);
 assert.equal(activeProfile(after).sourceScope,'hash:ima-desktop:10000002');assert.equal(after.sourceIdentity.profiles['10000001'].sourceScope,'old-scope');assert.equal(after.sourceIdentity.rangeReviewRequired,true);
 const back=chooseIdentity(after,selected(),x=>'hash:'+x);assert.equal(activeProfile(back).sourceScope,'old-scope');assert.equal(activeProfile(back).localDestination,oldProfile.localDestination);assert.deepEqual(activeProfile(back).folderDestinations,oldProfile.folderDestinations);
});
test('serialized native profile builds an ID-only navigation contract without API credentials',()=>{
 const profile=activeProfile(clone(migrate()));assert.deepEqual(desktopSource(profile),{knowledgeBaseId:'10000001',folderId:'folder_202',folderPath:clone(path)});
 assert.throws(()=>desktopSource(oldProfile),/未完成/);assert.throws(()=>desktopSource({...profile,folderPathIds:['folder_999']}),/不完整/);
 const root={...profile,folderId:undefined,folderPath:[],folderPathIds:[]};assert.deepEqual(desktopSource(root),{knowledgeBaseId:'10000001',folderPath:[]});
});
test('ordinary include-subfolder changes keep migrated identities and pinned folder destinations',()=>{
 const before=migrate();const after=updateIdentityOptions(before,{...before,includeSubfolders:true});
 assert.equal(activeProfile(after).includeSubfolders,true);assert.equal(activeProfile(after).sourceScope,'old-scope');assert.deepEqual(activeProfile(after).folderDestinations,oldProfile.folderDestinations);assert.deepEqual(activeProfile(after).folderPathIds,['folder_201','folder_202']);
});
test('source verification uses the fresh resolved label after a rename during list navigation',async()=>{
 const p=new DesktopIdentityProvider(async req=>req.action==='list-knowledge-bases'?[kb]:selected({knowledgeBase:{...kb,name:'最新库名'}}));
 assert.equal((await verifyIdentity(p,kb.id,'folder_202')).knowledgeBase.name,'最新库名');
});
test('refresh cannot silently change the identity provider of a native source',()=>{
 assert.throws(()=>refreshIdentityLabels(migrate(),selected({identityProvider:'ima-api'})),/不一致/);
});
const {isSourcePendingRecords,restorePendingSourceResume}=load('src/source-binding.ts');
const pendingRecord={sourceTitle:'原报告',sourceId:'knowledge-pdf_original_article_123456789',kind:'pdf',relativeFolder:['原子目录'],relativeFolderIds:['folder_203'],scrollPercent:50,scrollStep:2};
test('suspended batch retains directory IDs through serialization and restore without sharing arrays',()=>{
 const input={version:1,sourceScope:'a'.repeat(64),localDestination:'研究/原月',knowledgeBaseName:'原库',folderName:'原月',folderPath:['原月'],records:[clone(pendingRecord)],unresumableCount:0};
 const restored=restorePendingSourceResume(JSON.parse(JSON.stringify(input)));assert.ok(restored);assert.deepEqual(restored.records[0].relativeFolderIds,['folder_203']);
 restored.records[0].relativeFolderIds[0]='folder_999';assert.deepEqual(input.records[0].relativeFolderIds,['folder_203']);
});
test('suspended native directory IDs must match depth and cannot contain names, invalid IDs or cycles',()=>{
 for(const ids of [null,[],['原子目录'],['folder_'],['folder_203','folder_204'],[203]])assert.equal(isSourcePendingRecords([{...pendingRecord,relativeFolderIds:ids}]),false);
 assert.equal(isSourcePendingRecords([{...pendingRecord,relativeFolder:['a','b'],relativeFolderIds:['folder_203','folder_203']}]),false);
 assert.equal(isSourcePendingRecords([{...pendingRecord,relativeFolder:[],relativeFolderIds:[]}]),true);
});
test('legacy suspended records remain readable but no stable directory IDs are invented from names',()=>{
 const legacy={...pendingRecord};delete legacy.relativeFolderIds;assert.equal(isSourcePendingRecords([legacy]),true);
 const restored=restorePendingSourceResume({version:1,sourceScope:'a'.repeat(64),localDestination:'研究/原月',knowledgeBaseName:'原库',folderName:'原月',records:[legacy],unresumableCount:0});assert.equal(restored.records[0].relativeFolderIds,undefined);
});
test('default personal library hex ID is accepted alongside shared decimal IDs',async()=>{
 const personal={id:'001a6dab3f807619',name:'个人知识库'};
 const provider=new DesktopIdentityProvider(async request=>request.action==='list-knowledge-bases'?[personal,kb]:{knowledgeBase:personal,includeSubfolders:true});
 assert.deepEqual((await provider.listKnowledgeBases()).map(item=>item.id),[personal.id,kb.id]);
 assert.equal((await provider.resolve(personal.id)).knowledgeBase.id,personal.id);
 const chosen=chooseIdentity(input,{knowledgeBase:personal,includeSubfolders:true,identityProvider:'desktop-uia'},value=>value);
 assert.deepEqual(desktopSource(activeProfile(chosen)),{knowledgeBaseId:personal.id,folderPath:[]});
 const restored=JSON.parse(JSON.stringify(chosen));assert.equal(activeProfile(restored).knowledgeBaseId,personal.id);
});
test('native knowledge base validation rejects malformed hex and out-of-range decimal IDs',async()=>{
 for(const bad of ['1234567','1'.repeat(31),'001a6dab3f80761','001a6dab3f8076190','001z6dab3f807619','ima_kb_old']){
  const p=new DesktopIdentityProvider(async()=>[{id:bad,name:'库'}]);await assert.rejects(p.listKnowledgeBases());
 }
});
test('record-backed API migration can retain a default personal library hex identity',()=>{
 const choice=selected({knowledgeBase:{id:'001a6dab3f807619',name:'个人库'}});
 const migrated=migrateDesktopIdentity(oldState(),choice,{...evidence,candidateKnowledgeBaseIds:[choice.knowledgeBase.id]});
 assert.equal(activeProfile(migrated).knowledgeBaseId,choice.knowledgeBase.id);assert.equal(activeProfile(migrated).sourceScope,'old-scope');assert.deepEqual(desktopSource(activeProfile(migrated)).folderPath,choice.folder.path);
});
const {sourceIdentityNotice}=load('src/identity-picker.ts');
const noticeProfile=(id,kind,extra={})=>({...oldProfile,knowledgeBaseId:id,knowledgeBaseName:'同名库',...(kind?{identityProvider:kind}:{}),...extra});
const noticeBase=id=>({id,name:'同名库'});
test('same-provider distinct stable IDs report a separate same-name library',()=>{
 const profiles={old:noticeProfile('10000001','desktop-uia')};
 assert.equal(sourceIdentityNotice(noticeBase('10000002'),profiles,'desktop-uia'),'这是另一个同名知识库，原记录不会合并到这里。');
 assert.equal(sourceIdentityNotice(noticeBase('10000001'),profiles,'desktop-uia'),undefined);
 assert.equal(sourceIdentityNotice({id:'10000002',name:'其他库'},profiles,'desktop-uia'),undefined);
});
test('cross-provider IDs remain uncertain, including equal raw strings and legacy missing kind',()=>{
 for(const old of [noticeProfile('ima_kb_old'),noticeProfile('ima_kb_old','ima-api'),noticeProfile('10000001','ima-api')]){
  const profiles={old},snapshot=clone(profiles);
  assert.equal(sourceIdentityNotice(noticeBase('10000001'),profiles,'desktop-uia'),'与已有来源同名，尚未确认是否为原来源；原记录保持不变。');
  assert.deepEqual(profiles,snapshot);
 }
 assert.equal(sourceIdentityNotice(noticeBase('ima_kb_other'),{old:noticeProfile('ima_kb_old')}),'这是另一个同名知识库，原记录不会合并到这里。');
});
test('verified migration aliases suppress false warnings in either namespace without hiding real conflicts',()=>{
 const native=noticeProfile('10000001','desktop-uia',{legacyKnowledgeBaseIds:['ima_kb_old']});
 const profiles={old:noticeProfile('ima_kb_old'),native},snapshot=clone(profiles);
 assert.equal(sourceIdentityNotice(noticeBase('10000001'),profiles,'desktop-uia'),undefined);
 assert.equal(sourceIdentityNotice(noticeBase('ima_kb_old'),profiles,'ima-api'),undefined);
 assert.deepEqual(profiles,snapshot);
 assert.equal(sourceIdentityNotice(noticeBase('10000001'),{...profiles,other:noticeProfile('10000002','desktop-uia')},'desktop-uia'),'这是另一个同名知识库，原记录不会合并到这里。');
});
