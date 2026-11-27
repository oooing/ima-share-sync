import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
const bundle=buildSync({entryPoints:['src/folder-destinations.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const mod={exports:{}};new Function('module','exports',bundle.outputFiles[0].text)(mod,mod.exports);
const {buildFolderDestinations:build,resolveFolderDestination:resolve,folderDestinationKey:key}=mod.exports;
const obs=(sourceId,ids,path)=>({sourceId,relativeFolderIds:ids,relativeFolder:path});
const old=(id,path)=>({id,path});
const clone=value=>JSON.parse(JSON.stringify(value));

test('same-ID rename and serialized restart preserve the original path without touching inputs',()=>{
 const existing={[key(['folder_1','folder_2'])]:['旧月份','旧日报']}, copy=clone(existing);
 const next=build(existing,[obs('article-1',['folder_1','folder_2'],['新月份','新日报'])],[]);
 assert.deepEqual(resolve(next,['folder_1','folder_2']),['旧月份','旧日报']);assert.deepEqual(existing,copy);
 const restored=build(clone(next),[obs('article-1',['folder_1','folder_2'],['再次改月名','再次改日名'])],[]);
 assert.deepEqual(resolve(restored,['folder_1','folder_2']),['旧月份','旧日报']);
});

test('a skipped article proves the old directory and pins ancestors before new children are assigned',()=>{
 const next=build(undefined,[obs('new',['folder_1','folder_3'],['新月份','新增日报']),obs('already-downloaded',['folder_1','folder_2'],['新月份','新日报'])],[old('already-downloaded',['旧月份','旧日报'])]);
 assert.deepEqual(resolve(next,['folder_1']),['旧月份']);
 assert.deepEqual(resolve(next,['folder_1','folder_2']),['旧月份','旧日报']);
 assert.deepEqual(resolve(next,['folder_1','folder_3']),['旧月份','新增日报']);
});

test('unobserved previous mappings remain; unrelated old names cannot supply identity evidence',()=>{
 const existing={[key(['folder_1'])]:['原位置']};
 const next=build(existing,[obs('new-id',['folder_2'],['新位置'])],[old('different-id',['旧位置'])]);
 assert.deepEqual(resolve(next,['folder_1']),['原位置']);assert.deepEqual(resolve(next,['folder_2']),['新位置']);
 assert.deepEqual(resolve(build(next,[],[]),['folder_1']),['原位置']);
});

test('same-name different IDs never share or overwrite a destination, including Windows casing',()=>{
 const existing={[key(['folder_1'])]:['Reports']};
 assert.throws(()=>build(existing,[obs('new',['folder_2'],['reports'])],[]),/不同目录 ID/);
 assert.deepEqual(existing,{[key(['folder_1'])]:['Reports']});
 assert.throws(()=>build({},[obs('a',['folder_1'],['同名']),obs('b',['folder_2'],['同名'])],[]),/不同目录 ID/);
});

test('same-named child directories under distinct verified parents stay separate',()=>{
 const next=build({},[obs('a',['folder_1','folder_3'],['甲','同名']),obs('b',['folder_2','folder_4'],['乙','同名'])],[]);
 assert.deepEqual(resolve(next,['folder_1','folder_3']),['甲','同名']);
 assert.deepEqual(resolve(next,['folder_2','folder_4']),['乙','同名']);
});

test('conflicting old records for one unmapped directory or one article fail instead of choosing one',()=>{
 const observations=[obs('a',['folder_1'],['新名']),obs('b',['folder_1'],['新名'])];
 assert.throws(()=>build({},observations,[old('a',['原甲']),old('b',['原乙'])]),/多个目录/);
 assert.throws(()=>build({},[observations[0]],[old('a',['原甲']),old('a',['原乙'])]),/多个目录/);
});

test('already-mapped folders remain pinned when articles are moved or merged into them from other folders',()=>{
 const existing={
  [key(['folder_1126'])]:['1126'],
  [key(['folder_1126','folder_1'])]:['1126','1'],
 };
 const next=build(existing,[
  obs('in-1126',['folder_1126'],['1126']),
  obs('moved-from-sub',['folder_1126'],['1126']),
  obs('moved-from-other',['folder_1126'],['1126']),
  obs('new-1127',['folder_1127'],['1127']),
 ],[
  old('in-1126',['1126']),
  old('moved-from-sub',['1126','1']),
  old('moved-from-other',['1125']),
 ]);
 assert.deepEqual(resolve(next,['folder_1126']),['1126']);
 assert.deepEqual(resolve(next,['folder_1126','folder_1']),['1126','1']);
 assert.deepEqual(resolve(next,['folder_1127']),['1127']);
 const renamed=build({[key(['folder_1'])]:['已绑定']},[obs('a',['folder_1'],['改名'])],[old('a',['原别处'])]);
 assert.deepEqual(resolve(renamed,['folder_1']),['已绑定']);
});

test('unmapped folders ignore moved-article evidence owned by another folder or at another depth',()=>{
 const existing={[key(['folder_1126'])]:['1126'],[key(['folder_1126','folder_1'])]:['1126','1']};
 const next=build(existing,[
  obs('moved-same-depth',['folder_1127'],['1127']),
  obs('moved-child-depth',['folder_1127'],['1127']),
  obs('fresh',['folder_1127'],['1127']),
 ],[
  old('moved-same-depth',['1126']),
  old('moved-child-depth',['1126','1']),
 ]);
 assert.deepEqual(resolve(next,['folder_1127']),['1127']);

 const mergedUnmapped=build({},[
  obs('orig',['folder_1126'],['1126']),
  obs('merged-sub',['folder_1126'],['1126']),
 ],[
  old('orig',['1126']),
  old('merged-sub',['1126','1']),
 ]);
 assert.deepEqual(resolve(mergedUnmapped,['folder_1126']),['1126']);
});

test('multi-folder unmapped scans resolve moved articles deterministically regardless of order',()=>{
 const obsA=obs('a',['folder_1125'],['1125']);
 const obsB1=obs('b',['folder_1126'],['1126']);
 const obsB2=obs('c',['folder_1126'],['1126']);
 const records=[old('a',['1125']),old('b',['1126']),old('c',['1125'])];
 for(const list of [[obsA,obsB1,obsB2],[obsB2,obsB1,obsA]]){
  const next=build({},list,records);
  assert.deepEqual(resolve(next,['folder_1125']),['1125']);
  assert.deepEqual(resolve(next,['folder_1126']),['1126']);
 }
 // When two unmapped folders both claim one unowned path, only an exact unrenamed folder wins; ambiguous renamed ties fail closed.
 const split=build({},[obs('m',['folder_1126'],['1126']),obs('orig',['folder_1125'],['1125'])],[old('m',['1125']),old('orig',['1125'])]);
 assert.deepEqual(resolve(split,['folder_1125']),['1125']);
 assert.deepEqual(resolve(split,['folder_1126']),['1126']);
 assert.throws(()=>build({},[obs('x',['folder_1'],['新甲']),obs('y',['folder_2'],['新乙'])],[old('x',['原同']),old('y',['原同'])]),/不同目录 ID/);
});

test('duplicate evidence for the same Windows directory preserves existing path spelling',()=>{
 const next=build({[key(['folder_1'])]:['Reports']},[obs('a',['folder_1'],['改名'])],[old('a',['Reports']),old('a',['reports'])]);
 assert.deepEqual(resolve(next,['folder_1']),['Reports']);
});

test('existing conflicting parent mappings cannot silently be reconciled by display names',()=>{
 assert.throws(()=>build({[key(['folder_1'])]:['甲'],[key(['folder_1','folder_2'])]:['乙','子']},[],[]),/多个保存位置/);
 assert.throws(()=>build({[key(['folder_1','folder_2'])]:['父','子'],[key(['folder_3','folder_4'])]:['父','另一个子']},[],[]),/不同目录 ID/);
});

test('new directory labels must be consistent without old identity evidence',()=>{
 assert.throws(()=>build({},[obs('a',['folder_1'],['甲']),obs('b',['folder_1'],['乙'])],[]),/名称发生变化/);
 const next=build({[key(['folder_1'])]:['已绑定']},[obs('a',['folder_1'],['甲']),obs('b',['folder_1'],['乙'])],[]);
 assert.deepEqual(resolve(next,['folder_1']),['已绑定']);
});

test('malformed or cyclic ID chains and noncanonical persisted keys are rejected',()=>{
 for(const chain of [['runtime-12'],['knowledge-folder_1'],['folder_1','folder_1'],[null],['folder_1/child']]) assert.throws(()=>build({},[obs('a',chain,chain.map(()=> '目录'))],[]),/ID/);
 for(const map of [{'not-json':['目录']},{'[ "folder_1" ]':['目录']},{'{}':[]}]) assert.throws(()=>build(map,[],[]),/映射/);
 assert.throws(()=>build([],[],[]),/映射/);
});

test('final local components reject traversal, Windows aliases, invalid characters and reserved names',()=>{
 for(const part of ['', '..', '.', 'a/b', 'a\\b', 'a:b', 'a?', 'a*', 'a|b', 'a<', 'a>', 'a"', 'a\0', 'x.', 'x ', 'CON', 'nul.txt', 'COM1', 'lpt9.log', 'COM¹']) {
  assert.throws(()=>build({},[obs('a',['folder_1'],[part])],[]),/本地目录路径/);
 }
 const next=build({},[obs('a',['folder_1'],['中文，空 格（2026）'])],[]);
 assert.deepEqual(resolve(next,['folder_1']),['中文，空 格（2026）']);
});

test('persisted mappings and observed names must match the full ID chain depth',()=>{
 assert.throws(()=>build({},[obs('a',['folder_1'],['父','子'])],[]),/层级/);
 assert.throws(()=>build({[key(['folder_1','folder_2'])]:['子']},[],[]),/层级/);
 const crossDepthMoved=build({},[obs('a',['folder_1'],['子'])],[old('a',['父','子'])]);
 assert.deepEqual(resolve(crossDepthMoved,['folder_1']),['子']);
});

test('root articles are mapped to the source root and missing identity never falls back to labels',()=>{
 const next=build(undefined,[obs('a',[],[])],[old('a',[])]);
 assert.deepEqual(resolve(next,[]),[]);
 assert.throws(()=>resolve(next,['folder_99']),/尚未关联/);
 assert.throws(()=>build({},[obs('',[],[])],[]),/来源 ID/);
});

test('returned paths and maps do not alias caller arrays or one another',()=>{
 const observations=[obs('a',['folder_1','folder_2'],['父','子'])], records=[old('a',['旧父','旧子'])], snapshot=clone({observations,records});
 const next=build({},observations,records), selected=resolve(next,['folder_1','folder_2']);selected[0]='被调用方修改';
 assert.deepEqual(resolve(next,['folder_1','folder_2']),['旧父','旧子']);
 next[key(['folder_1'])][0]='修改父映射';assert.deepEqual(next[key(['folder_1','folder_2'])],['旧父','旧子']);
 assert.deepEqual({observations,records},snapshot);
});
test('every explicit existing entry retains its spelling even if old prefix casing differs',()=>{
 const existing={[key(['folder_1','folder_2'])]:['reports','Child'],[key(['folder_1'])]:['Reports']};
 const next=build(existing,[],[]);
 for(const [id,path] of Object.entries(existing)) assert.deepEqual(next[id],path);
});