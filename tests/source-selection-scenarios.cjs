"use strict";

module.exports = async function testSourceSelection(h) {
  const { assert, scenario, loadFixture, storedFixture, withPending, pendingRecord, knowledgeBaseName,
    renamedKnowledgeBase, oldFolder, newFolder, localDestination, sourceScope, fixtureEntries,
    emptyIndex, settingsSnapshot, clone, inspection, successOutput, modals, modalControl, modalButton,
    deferred, waitFor, createHash } = h;
  const rootInspection = (kb = knowledgeBaseName) => ({ ...inspection("", kb), targetKind: "knowledge-base", breadcrumb: ["内容(18692)"] });
  const output = sourceInspection => JSON.stringify({ items: [], errors: [], sourceInspection });
  const catalogOutput = sourceCatalog => JSON.stringify({ items: [], errors: [], sourceCatalog });
  function select(plugin, kind = "folder") { plugin.openSourceSelection(kind); return plugin.sourceRebindSession; }
  function dispose(plugin) { plugin.cancelSourceRebind(plugin.sourceRebindSession); plugin.onunload(); }

  await scenario("whole-knowledge-base selection preserves destination and all 67 IDs across reload", async () => {
    const plugin = await loadFixture();
    const before = settingsSnapshot(plugin);
    const session = select(plugin, "knowledge-base");
    plugin.runPowerShell = async (_max, _titles, settings, _run, ids, operation) => {
      assert.equal(operation, "inspect-source"); assert.equal(settings.sourceTargetKind, "knowledge-base");
      assert.equal(settings.folderName, ""); assert.deepEqual(ids, []); return output(rootInspection());
    };
    await plugin.inspectSourceFolder(session);
    assert.equal(settingsSnapshot(plugin), before);
    await plugin.confirmSourceBinding(session);
    assert.equal(plugin.settings.folderName, ""); assert.equal(plugin.getSourceBinding().targetKind, "knowledge-base");
    assert.equal(plugin.getEffectiveDestinationPath(), localDestination);
    assert.equal(plugin.createSourceScope(plugin.settings), sourceScope);
    assert.deepEqual(plugin.getExistingSourceIds(emptyIndex(), plugin.settings).sort(), fixtureEntries.slice(0, 67).map(x => x.sourceId).sort());
    const reloaded = await loadFixture(plugin.savedData);
    assert.deepEqual(reloaded.getSourceBinding(), plugin.getSourceBinding());
    assert.deepEqual(reloaded.syncedAttachments, plugin.syncedAttachments);
    plugin.onunload(); reloaded.onunload();
  });

  for (const preserve of [false, true]) await scenario(`choosing another knowledge-base label has explicit preserveIdentity=${preserve}`, async () => {
    const plugin = await loadFixture(); const session = select(plugin);
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase); plugin.setSourceRebindCandidate(session, newFolder);
    plugin.setSourceSelectionIdentity(session, preserve);
    plugin.runPowerShell = async () => successOutput(newFolder, renamedKnowledgeBase);
    await plugin.inspectSourceFolder(session); await plugin.confirmSourceBinding(session);
    assert.equal(plugin.getEffectiveDestinationPath(), localDestination);
    assert.deepEqual(plugin.syncedAttachments, fixtureEntries.slice(0, 67));
    assert.equal(plugin.createSourceScope(plugin.settings), preserve ? sourceScope : createHash("sha256").update(renamedKnowledgeBase).digest("hex"));
    assert.equal(plugin.getExistingSourceIds(emptyIndex(), plugin.settings).length, preserve ? 67 : 0);
    plugin.onunload();
  });

  await scenario("whole-base cancellation and failed persistence leave prior settings intact", async () => {
    const plugin = await loadFixture(); const before = settingsSnapshot(plugin);
    let session = select(plugin, "knowledge-base"); plugin.cancelSourceRebind(session);
    assert.equal(settingsSnapshot(plugin), before);
    session = select(plugin, "knowledge-base"); plugin.runPowerShell = async () => output(rootInspection());
    await plugin.inspectSourceFolder(session);
    plugin.saveData = async () => { throw new Error("fixture disk failure"); };
    await assert.rejects(plugin.confirmSourceBinding(session), /fixture disk failure/);
    assert.equal(settingsSnapshot(plugin), before); dispose(plugin);
  });

  await scenario("switching scope cannot detach a pending folder batch", async () => {
    const plugin = await loadFixture(withPending([pendingRecord(1)])); const before = settingsSnapshot(plugin);
    const session = select(plugin, "knowledge-base"); plugin.runPowerShell = async () => output(rootInspection());
    await plugin.inspectSourceFolder(session); await assert.rejects(plugin.confirmSourceBinding(session), /待续跑/);
    assert.equal(settingsSnapshot(plugin), before); dispose(plugin);
  });

  for (const bad of [
    { ...rootInspection(), breadcrumb: ["内容(18692)", "another folder"] },
    { ...rootInspection(), targetKind: "folder" },
    rootInspection("different knowledge base"),
  ]) await scenario("root inspection rejects mismatched scope, path or knowledge base", async () => {
    const plugin = await loadFixture(); const before = settingsSnapshot(plugin); const session = select(plugin, "knowledge-base");
    plugin.runPowerShell = async () => output(bad);
    await assert.rejects(plugin.inspectSourceFolder(session), /./);
    await assert.rejects(plugin.confirmSourceBinding(session), /./);
    assert.equal(settingsSnapshot(plugin), before); dispose(plugin);
  });

  await scenario("changing the selected range preserves no-ID content keys and stable source-ID keys", async () => {
    const plugin = await loadFixture();
    const folderSettings = clone(plugin.settings);
    const rootSettings = { ...folderSettings, sourceTargetKind: "knowledge-base", folderName: "",
      sourceBinding: { ...folderSettings.sourceBinding, targetKind: "knowledge-base", remoteFolderName: "" } };
    const article = { sourceTitle: "same note", relativeFolder: ["day"], body: "Same complete content" };
    assert.equal(plugin.createGeneralSourceKey(article, folderSettings),
      plugin.createGeneralSourceKey({ ...article, relativeFolder: [oldFolder, "day"] }, rootSettings));
    assert.equal(plugin.createGeneralSourceKey({ ...article, sourceId: fixtureEntries[0].sourceId }, folderSettings),
      plugin.createGeneralSourceKey({ ...article, sourceId: fixtureEntries[0].sourceId, relativeFolder: [oldFolder, "day"] }, rootSettings));
    plugin.onunload();
  });

  const folders = { kind: "folders", knowledgeBaseName, names: [newFolder], ambiguousNames: [], complete: true };
  for (const bad of [
    { ...folders, complete: false }, { ...folders, knowledgeBaseName: "wrong" },
    { ...folders, names: [newFolder, newFolder] }, { ...folders, ambiguousNames: [newFolder] },
  ]) await scenario("catalog rejects partial, foreign or ambiguous entries without committing", async () => {
    const plugin = await loadFixture(); const before = settingsSnapshot(plugin); const session = select(plugin);
    plugin.runPowerShell = async () => catalogOutput(bad);
    await assert.rejects(plugin.readSourceCatalog(session, "folders"), /./);
    assert.equal(settingsSnapshot(plugin), before); assert.equal(plugin.running, false); dispose(plugin);
  });

  await scenario("closed chooser rejects late catalog response and releases the run", async () => {
    const plugin = await loadFixture(); const before = settingsSnapshot(plugin); const session = select(plugin);
    const result = deferred(); plugin.runPowerShell = () => result.promise;
    const reading = plugin.readSourceCatalog(session, "folders");
    const rejected = assert.rejects(reading, /./);
    await waitFor(() => plugin.running); plugin.cancelSourceRebind(session); result.resolve(catalogOutput(folders));
    await rejected;
    assert.equal(settingsSnapshot(plugin), before); assert.equal(plugin.running, false);
    assert.equal(plugin.cancellationRequested, false); plugin.onunload();
  });

  await scenario("real chooser renders returned names, clears stale folder controls and confirms only after checking", async () => {
    const plugin = await loadFixture(); const before = settingsSnapshot(plugin); const session = select(plugin);
    const modal = modals.at(-1);
    const knowledgeBases = { kind: "knowledge-bases", knowledgeBaseName: "", names: [knowledgeBaseName, renamedKnowledgeBase], ambiguousNames: [], complete: false };
    plugin.runPowerShell = async (_n, _t, settings, _run, _ids, operation) => {
      if (operation === "list-knowledge-bases") return catalogOutput(knowledgeBases);
      if (operation === "list-source-folders") return catalogOutput(folders);
      return successOutput(settings.folderName, settings.knowledgeBaseName);
    };
    await modal.read("knowledge-bases");
    assert.deepEqual(Object.keys(modalControl(modal, "已读取的来源").dropdown.options), ["", knowledgeBaseName, renamedKnowledgeBase]);
    await modal.read("folders");
    const settings = h.descendants(modal.contentEl).filter(el => el.setting?.dropdown).map(el => el.setting);
    const folderChoice = settings.find(s => newFolder in s.dropdown.options).dropdown;
    await folderChoice.change(newFolder);
    assert.equal(session.candidateName, newFolder);
    await modal.check(); assert.equal(modalButton(modal, "确认来源").disabled, false);
    const oldFolderControl = modalControl(modal, "源文件夹").control;
    await modalControl(modal, "知识库").control.change(renamedKnowledgeBase);
    assert.equal(session.candidateName, ""); assert.equal(oldFolderControl.inputEl.value, "");
    assert.equal(modalButton(modal, "确认来源").disabled, true);
    assert.equal(settingsSnapshot(plugin), before); modal.close(); plugin.onunload();
  });

  await scenario("an unconfigured installation can confirm a whole knowledge base without inventing a folder", async () => {
    const stored = { ...storedFixture(0), knowledgeBaseName: "", folderName: "" };
    const plugin = await loadFixture(stored); const session = select(plugin, "knowledge-base");
    plugin.setSourceRebindKnowledgeBase(session, knowledgeBaseName); plugin.runPowerShell = async () => output(rootInspection());
    await plugin.inspectSourceFolder(session); await plugin.confirmSourceBinding(session);
    assert.equal(plugin.settings.sourceTargetKind, "knowledge-base"); assert.equal(plugin.settings.folderName, "");
    assert.equal(plugin.getEffectiveDestinationPath(), "Fixture/Reports"); plugin.onunload();
  });
};
