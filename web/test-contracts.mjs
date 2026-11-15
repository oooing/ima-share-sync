import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sha256 } from './sha256.mjs';
import { scenarios, createScenario, storageKey, loadPreviewData } from './scenarios.mjs';
import { assetIdentity } from './server.mjs';

test('browser source identity matches production Node crypto, including Unicode and long names', () => {
  for (const text of ['', 'abc', '机构研报', '知识库😀 / café', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), '文'.repeat(1000), randomBytes(200).toString('hex')]) {
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
  }
});
test('scenario storage survives reload and remains separate', () => {
  const map = new Map(); const storage = { getItem: key => map.get(key) ?? null };
  const a = createScenario('configured'), b = createScenario('renamed');
  const changed = loadPreviewData(storage, a); changed.knowledgeBaseName = '保存后的名称';
  map.set(storageKey(a.id), JSON.stringify(changed));
  assert.equal(loadPreviewData(storage, a).knowledgeBaseName, '保存后的名称');
  assert.equal(loadPreviewData(storage, b).knowledgeBaseName, '机构研报');
  map.delete(storageKey(a.id)); assert.equal(loadPreviewData(storage, a).knowledgeBaseName, '机构研报');
});
test('first installation stays unconfigured', () => {
  assert.equal(loadPreviewData({getItem: () => null}, createScenario('new')), null);
});
test('damaged preview data does not silently replace user choices', () => {
  assert.throws(() => loadPreviewData({getItem: () => '{'}, createScenario()), /重置场景/);
});
test('rename fixture preserves old local records while remote labels change', async () => {
  const a = createScenario('renamed');
  const result = await a.catalog('list-knowledge-bases', {});
  assert.ok(!result.sourceCatalog.names.includes(a.data.knowledgeBaseName));
  assert.equal(a.data.syncedAttachments.length, 3); assert.equal(a.data.syncReports.length, 4);
  await assert.rejects(a.catalog('inspect-source', {...a.data}), /原来源名称已变化/);
  const next = await a.catalog('inspect-source', {...a.data, knowledgeBaseName:'机构研报 · 新名称',folderName:'2026年10月 · 归档',sourceFolderPath:['2026年10月 · 归档']});
  assert.deepEqual(next.sourceInspection.folderPath, ['2026年10月 · 归档']);
});
test('folder catalogs keep the requested parent path', async () => {
  const result = await createScenario().catalog('list-source-folders', { knowledgeBaseName:'机构研报', sourceCatalogPath:['2026年10月','261031'] });
  assert.deepEqual(result.sourceCatalog.parentPath, ['2026年10月','261031']);
  assert.deepEqual(result.sourceCatalog.names, ['图表','附录']);
});
test('ambiguous folders are not selectable and inspection fails', async () => {
  const scenario = createScenario('ambiguous');
  const result = await scenario.catalog('list-source-folders', {sourceCatalogPath:[]});
  assert.ok(result.sourceCatalog.ambiguousNames.includes('重复文件夹'));
  assert.ok(!result.sourceCatalog.names.includes('重复文件夹'));
  await assert.rejects(scenario.catalog('inspect-source', {folderName:'重复文件夹'}), /无法唯一确认/);
});
test('source failures surface an actionable error', async () => {
  await assert.rejects(createScenario('offline').catalog('list-knowledge-bases', {}), /刷新/);
});
test('every Web scenario refuses real sync and download operations', async () => {
  for (const scenario of scenarios) await assert.rejects(createScenario(scenario.id).catalog('sync', {}));
});
test('build identity changes for script, style, or manifest changes', () => {
  const base = {'main.js':Buffer.from('a'),'styles.css':Buffer.from('b'),'manifest.json':Buffer.from('c')};
  const original = assetIdentity(base);
  for (const name of Object.keys(base)) assert.notEqual(assetIdentity({...base,[name]:Buffer.from('changed')}).buildId, original.buildId);
  assert.deepEqual(assetIdentity(base), original);
});
test('all runtime icon names in shared source are available in the browser host', async () => {
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const icons = JSON.parse(await readFile(new URL('./icons.json', import.meta.url), 'utf8'));
  const names = [...source.matchAll(/setIcon\([^\n]*?"([a-z0-9-]+)"\)|icon: "([a-z0-9-]+)"/g)].map(m => m[1] || m[2]);
  for (const name of names) assert.ok(icons[name], `Missing icon: ${name}`);
});

import { buildSync } from 'esbuild';
const identityBundle = buildSync({ entryPoints: [new URL('../src/source-identity.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle:true, format:'cjs', platform:'node', write:false });
const identityModule = { exports:{} };
new Function('module','exports',identityBundle.outputFiles[0].text)(identityModule, identityModule.exports);
const { activeProfile, verifyIdentity, refreshIdentityLabels, chooseIdentity, updateIdentityOptions, acknowledgeIdentityRange } = identityModule.exports;

test('ID rename changes labels only, retaining destination, ledger, scope and folder identity', async () => {
  const scenario = createScenario('renamed'), before = structuredClone(scenario.data);
  const original = activeProfile(before);
  const remote = await verifyIdentity(scenario.identityProvider, original.knowledgeBaseId, original.folderId);
  const next = refreshIdentityLabels(before, remote);
  assert.notEqual(next.knowledgeBaseName,before.knowledgeBaseName);
  assert.notEqual(next.folderName,before.folderName);
  assert.equal(next.sourceBinding.sourceScope,before.sourceBinding.sourceScope);
  assert.equal(next.sourceBinding.localDestination,before.sourceBinding.localDestination);
  assert.deepEqual(next.syncedAttachments,before.syncedAttachments);
  assert.deepEqual(next.syncReports,before.syncReports);
  assert.equal(activeProfile(next).folderId,original.folderId);
  assert.deepEqual(scenario.data,before);
});
test('switching away and back restores identity, scope, range, child choice and save path without duplicate profiles', async () => {
  const scenario=createScenario(), original=structuredClone(scenario.data), provider=scenario.identityProvider;
  const learning=await verifyIdentity(provider,'demo-kb-learning','demo-kb-learning-root');
  learning.includeSubfolders=false;
  const away=chooseIdentity(original,learning,sha256);
  assert.notEqual(away.sourceBinding.sourceScope,original.sourceBinding.sourceScope);
  const remembered=activeProfile(away);
  const report=await verifyIdentity(provider,'demo-kb-reports','demo-folder-oct');
  const back=chooseIdentity(away,report,sha256);
  assert.equal(back.sourceBinding.sourceScope,original.sourceBinding.sourceScope);
  assert.equal(back.sourceBinding.localDestination,original.sourceBinding.localDestination);
  assert.deepEqual(back.syncedAttachments,original.syncedAttachments);
  const again=chooseIdentity(back,learning,sha256);
  assert.equal(activeProfile(again).sourceScope,remembered.sourceScope);
  assert.equal(activeProfile(again).includeSubfolders,false);
  assert.equal(Object.keys(again.sourceIdentity.profiles).length,2);
});
test('same-name recreated KB cannot pass availability by stale metadata and never inherits the old scope', async () => {
  const scenario=createScenario('recreated');
  const stale=await scenario.identityProvider.resolve('demo-kb-reports');
  assert.equal(stale.knowledgeBase.name,scenario.data.knowledgeBaseName);
  await assert.rejects(verifyIdentity(scenario.identityProvider,'demo-kb-reports','demo-folder-oct'),/暂不可用/);
  const recreated=await verifyIdentity(scenario.identityProvider,'demo-kb-reports-recreated');
  const next=chooseIdentity(scenario.data,recreated,sha256);
  assert.notEqual(next.sourceBinding.sourceScope,scenario.data.sourceBinding.sourceScope);
  assert.equal(Object.keys(next.sourceIdentity.profiles).length,2);
  assert.deepEqual(next.syncedAttachments,scenario.data.syncedAttachments);
});
test('legacy linking requires matching records and preserves original save location and ledger', async () => {
  const scenario=createScenario('legacy'), before=structuredClone(scenario.data);
  const choice=await verifyIdentity(scenario.identityProvider,'demo-kb-reports','demo-folder-oct');
  assert.throws(()=>chooseIdentity(before,choice,sha256,true,0),/没有找到/);
  const matched=await scenario.identityProvider.matchRecords(choice,before.syncedAttachments.map(x=>x.sourceId));
  assert.equal(matched,3);
  const linked=chooseIdentity(before,choice,sha256,true,matched);
  assert.equal(linked.sourceBinding.sourceScope,before.syncedAttachments[0].sourceScope);
  assert.equal(linked.sourceBinding.localDestination,'阅读/研报/2026年10月');
  assert.deepEqual(linked.syncedAttachments,before.syncedAttachments);
  assert.equal(linked.sourceIdentity.legacy,undefined);
});
test('changing ordinary options retains remote identity and save path unless destination was explicitly changed', () => {
  const before=createScenario().data;
  const next=updateIdentityOptions(before,{...before,maxItems:30,includeSubfolders:false,overwriteSameName:true});
  assert.equal(activeProfile(next).knowledgeBaseId,activeProfile(before).knowledgeBaseId);
  assert.equal(activeProfile(next).folderId,activeProfile(before).folderId);
  assert.equal(next.sourceBinding.localDestination,before.sourceBinding.localDestination);
  assert.equal(next.sourceBinding.sourceScope,before.sourceBinding.sourceScope);
  assert.deepEqual(next.syncedAttachments,before.syncedAttachments);
  assert.throws(()=>updateIdentityOptions(before,{...before,knowledgeBaseName:'别的库'}),/来源选择器/);
});
test('wrong ID returned by provider is rejected instead of trusted by name', async () => {
  const provider=createScenario().identityProvider;
  const wrong={...provider,resolve:async()=>({knowledgeBase:{id:'wrong',name:'机构研报'},includeSubfolders:true})};
  await assert.rejects(verifyIdentity(wrong,'demo-kb-reports'),/身份未能确认/);
});
test('same-name folders remain distinct using IDs', async () => {
  const provider=createScenario('ambiguous').identityProvider;
  const items=(await provider.listFolders('demo-kb-reports')).filter(x=>x.name==='重复文件夹');
  assert.equal(items.length,2); assert.notEqual(items[0].id,items[1].id);
  for(const item of items) assert.equal((await verifyIdentity(provider,'demo-kb-reports',item.id)).folder.id,item.id);
});

test('changing KB requires a saved range review; same-ID navigation and rename do not create a new review', async () => {
  const scenario=createScenario(), original=structuredClone(scenario.data);
  const choice=await verifyIdentity(scenario.identityProvider,'demo-kb-learning');
  const changed=chooseIdentity(original,choice,sha256);
  assert.equal(changed.sourceIdentity.rangeReviewRequired,true);
  const options=updateIdentityOptions(changed,{...changed,includeSubfolders:false,maxItems:30});
  assert.equal(options.sourceIdentity.rangeReviewRequired,true);
  const restored=JSON.parse(JSON.stringify(options));
  const acknowledged=acknowledgeIdentityRange(restored);
  assert.equal(acknowledged.sourceIdentity.rangeReviewRequired,false);
  assert.equal(acknowledged.sourceBinding.localDestination,restored.sourceBinding.localDestination);
  assert.deepEqual(acknowledged.syncedAttachments,original.syncedAttachments);
  assert.equal(activeProfile(acknowledged).includeSubfolders,false);
  const same=chooseIdentity(acknowledged,{...choice,includeSubfolders:false},sha256);
  assert.equal(same.sourceIdentity.rangeReviewRequired,false);
  const renamed=refreshIdentityLabels(same,{...choice,knowledgeBase:{...choice.knowledgeBase,name:'学习资料新名称'}});
  assert.equal(renamed.sourceIdentity.rangeReviewRequired,false);
  const back=chooseIdentity(renamed,await verifyIdentity(scenario.identityProvider,'demo-kb-reports','demo-folder-oct'),sha256);
  assert.equal(back.sourceIdentity.rangeReviewRequired,true);
  assert.equal(back.sourceBinding.localDestination,original.sourceBinding.localDestination);
  assert.equal(back.sourceBinding.sourceScope,original.sourceBinding.sourceScope);
});

test('legacy association is not treated as a new KB switch', async () => {
  const scenario=createScenario('legacy');
  const choice=await verifyIdentity(scenario.identityProvider,'demo-kb-reports','demo-folder-oct');
  const linked=chooseIdentity(scenario.data,choice,sha256,true,3);
  assert.equal(linked.sourceIdentity.rangeReviewRequired,false);
  assert.deepEqual(linked.syncedAttachments,scenario.data.syncedAttachments);
});
