"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");
const compiled = esbuild.transformSync(fs.readFileSync(path.join(__dirname, "../src/scope-draft.ts"), "utf8"), {loader:"ts",format:"cjs"}).code;
const moduleFixture = {exports:{}};
vm.runInNewContext(compiled, {module:moduleFixture,exports:moduleFixture.exports});
const {createScopeDraft} = moduleFixture.exports;

module.exports = async ({assert,scenario,loadFixture,storedFixture,withPending,pendingRecord,clone,localDestination,sourceScope,fixtureEntries,emptyIndex}) => {
  const inspected = settings => JSON.stringify({items:[],errors:[],sourceInspection:{
    knowledgeBaseName:settings.knowledgeBaseName,folderName:settings.folderName,targetKind:settings.sourceTargetKind,
    folderPath: settings.sourceTargetKind === "knowledge-base" ? [] : settings.sourceFolderPath ?? [settings.folderName],
    breadcrumb:["内容(100)",...(settings.sourceTargetKind === "knowledge-base" ? [] : settings.sourceFolderPath ?? [settings.folderName])],
    stableFolderId:null,identityMode:"explicit-confirmation",
  }});
  await scenario("scope save is one commit, keeps pinned destination, history and all 100 identities", async () => {
    const plugin = await loadFixture(storedFixture(100));
    const draft = createScopeDraft(plugin.settings);
    const before = clone(plugin.settings);
    draft.values.maxItems = 200; draft.values.includeSubfolders = false;
    assert.deepEqual(clone(plugin.settings), before, "draft is detached");
    const report = {finishedAt:1,interactive:true,status:"success",summary:"existing",errors:[]};
    plugin.syncReports.push(report);
    plugin.runPowerShell = async () => {throw new Error("unchanged source needs no IMA request")};
    let writes=0; const save=plugin.saveData.bind(plugin); plugin.saveData=async data => {writes++;return save(data)};
    await plugin.saveScopeDraft(draft);
    assert.equal(writes,1); assert.equal(plugin.settings.maxItems,200);
    assert.equal(plugin.getEffectiveDestinationPath(),localDestination);
    assert.equal(plugin.createSourceScope(plugin.settings),sourceScope);
    assert.deepEqual(plugin.savedData.syncReports,[report]);
    assert.deepEqual(plugin.syncedAttachments,fixtureEntries);
    assert.equal(plugin.getExistingSourceIds(emptyIndex(),plugin.settings).length,100);
    assert.equal(plugin.created.length,0); assert.equal(plugin.modified.length,0);
    plugin.onunload();
  });
  await scenario("scope disk failure restores every staged field and releases the selection lock", async () => {
    const plugin=await loadFixture(); const before=clone(plugin.settings); const persisted=clone(plugin.savedData);
    const draft=createScopeDraft(plugin.settings); draft.values.maxItems=500;draft.values.destinationPath="Other";
    plugin.saveData=async()=>{throw new Error("draft disk failure")};
    await assert.rejects(plugin.saveScopeDraft(draft),/draft disk failure/);
    assert.deepEqual(clone(plugin.settings),before);assert.deepEqual(plugin.savedData,persisted);
    assert.equal(plugin.sourceRebindSession,null);assert.equal(plugin.isRunning,false);
    plugin.onunload();
  });
  for(const preserve of [true,false]) await scenario(`B chooser changes both names with explicit rename=${preserve}, destination stays pinned`,async()=>{
    const plugin=await loadFixture(storedFixture(100));const draft=createScopeDraft(plugin.settings);
    Object.assign(draft.values,{knowledgeBaseName:"New knowledge base",folderName:"Daily",sourceFolderPath:["October","Daily"]});
    draft.preserveIdentity=preserve;const calls=[];
    plugin.runPowerShell=async(_n,_skip,settings,_run,_ids,op)=>{calls.push(op);return inspected(settings)};
    await plugin.saveScopeDraft(draft);
    assert.deepEqual(calls,["inspect-source"]);assert.equal(plugin.getEffectiveDestinationPath(),localDestination);
    assert.deepEqual(plugin.settings.sourceFolderPath,["October","Daily"]);
    assert.equal(plugin.createSourceScope(plugin.settings)===sourceScope,preserve);
    assert.deepEqual(plugin.syncedAttachments,fixtureEntries);assert.equal(plugin.created.length,0);
    assert.equal(plugin.getExistingSourceIds(emptyIndex(),plugin.settings).length,preserve?100:0);
    const reloaded=await loadFixture(plugin.savedData);
    assert.deepEqual(reloaded.settings.sourceBinding.folderPath,["October","Daily"]);
    assert.equal(reloaded.getEffectiveDestinationPath(),localDestination);
    plugin.onunload();reloaded.onunload();
  });
  await scenario("same leaf in another parent cannot pass nested source inspection",async()=>{
    const plugin=await loadFixture();const before=clone(plugin.settings);const draft=createScopeDraft(plugin.settings);
    Object.assign(draft.values,{folderName:"Daily",sourceFolderPath:["October","Daily"]});
    plugin.runPowerShell=async(_n,_skip,settings)=>inspected({...settings,sourceFolderPath:["September","Daily"]});
    await assert.rejects(plugin.saveScopeDraft(draft));assert.deepEqual(clone(plugin.settings),before);
    assert.equal(plugin.created.length,0);plugin.onunload();
  });
  await scenario("pending records survive an explicitly confirmed rename; scope expansion is blocked",async()=>{
    const plugin=await loadFixture(withPending([pendingRecord(1)]));const draft=createScopeDraft(plugin.settings);
    draft.values.folderName="Renamed";draft.values.sourceFolderPath=["Renamed"];draft.preserveIdentity=true;
    plugin.runPowerShell=async(_n,_skip,settings)=>inspected(settings);
    await plugin.saveScopeDraft(draft);
    assert.equal(plugin.settings.pendingSourceResume.folderName,"Renamed");
    assert.deepEqual(plugin.settings.pendingSourceResume.records,[pendingRecord(1)]);
    plugin.assertPendingSourceContext(plugin.getPendingSourceResume(),plugin.settings);
    const root=createScopeDraft(plugin.settings);root.values.sourceTargetKind="knowledge-base";
    await assert.rejects(plugin.saveScopeDraft(root));
    assert.equal(plugin.settings.sourceTargetKind,"folder");plugin.onunload();
  });
  await scenario("stale page drafts never overwrite source changes saved elsewhere",async()=>{
    const plugin=await loadFixture();const draft=createScopeDraft(plugin.settings);draft.values.maxItems=200;
    plugin.settings.maxItems=300;await assert.rejects(plugin.saveScopeDraft(draft),/设置已在其他位置更改/);
    assert.equal(plugin.settings.maxItems,300);plugin.onunload();
  });
  await scenario("nested catalogs are read-only and reject a response from a different parent",async()=>{
    const plugin=await loadFixture();const before=clone(plugin.settings);const session=plugin.beginScopeSelection(plugin.settings);
    plugin.runPowerShell=async(_n,_skip,settings,_run,_ids,op)=>{
      assert.equal(op,"list-source-folders");assert.deepEqual(settings.sourceCatalogPath,["October"]);
      return JSON.stringify({items:[],errors:[],sourceCatalog:{kind:"folders",knowledgeBaseName:settings.knowledgeBaseName,names:["Daily"],ambiguousNames:[],complete:true,parentPath:["September"]}});
    };
    await assert.rejects(plugin.readSourceCatalog(session,"folders",["October"]));
    assert.deepEqual(clone(plugin.settings),before);plugin.cancelSourceRebind(session);plugin.onunload();
  });
  await scenario("nested selection keeps both SourceId and full-path fallback dedup keys",async()=>{
    const plugin=await loadFixture();const item={sourceTitle:"same",body:"same content",relativeFolder:["Daily"]};
    const root={...plugin.settings,folderName:"October",sourceFolderPath:["October"]};
    const child={...root,folderName:"Daily",sourceFolderPath:["October","Daily"]};
    assert.equal(plugin.createGeneralSourceKey(item,root),plugin.createGeneralSourceKey({...item,relativeFolder:[]},child));
    assert.notEqual(plugin.createGeneralSourceKey({...item,relativeFolder:[]},child),plugin.createGeneralSourceKey({...item,relativeFolder:[]},{...child,sourceFolderPath:["September","Daily"]}));
    plugin.onunload();
  });
};
