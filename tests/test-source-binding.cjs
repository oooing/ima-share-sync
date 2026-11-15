"use strict";

// Load the real built plugin. Only Obsidian and the external process boundary
// are mocked; binding, persistence, source indexing and run coordination are real.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

global.window = global;
const clone = value => JSON.parse(JSON.stringify(value));
const normalizePath = value => value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
const modals = [];
let externalSpawnCount = 0;
let scenarioCount = 0;
let spawnFixture;

class Element {
  constructor() { this.children = []; this.listeners = new Map(); this.dataset = {}; this.disabled = false; }
  empty() { this.children = []; }
  createEl(tag, options = {}) { const child = new Element(); child.tag = tag; child.text = options.text; child.cls = options.cls; child.parentElement = this; Object.assign(child, options.attr); this.children.push(child); return child; }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  setText(value) { this.text = value; }
  setAttr(name, value) { this[name] = value; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  get tagName() { return (this.tag || "div").toUpperCase(); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === "[aria-label], [title]" && (child["aria-label"] || child.title) ? [child] : []), ...child.querySelectorAll(selector)]); }
  toggleClass() {}
  addClass() {}
  removeClass() {}
  focus() {}
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { if (!this.disabled) return this.listeners.get("click")?.(); }
}

class Setting {
  constructor(container) { this.settingEl = container.createDiv(); this.settingEl.setting = this; }
  setName(name) { this.name = name; return this; }
  setDesc(description) { this.description = description; return this; }
  addText(configure) {
    const control = {
      inputEl: this.settingEl.createEl("input"),
      setValue(value) { this.value = value; this.inputEl.value = value; return this; },
      setDisabled(value) { this.inputEl.disabled = value; return this; },
      onChange(callback) { this.callback = callback; return this; },
      async change(value) { if (this.inputEl.disabled) return; this.value = value; this.inputEl.value = value; await this.callback?.(value); },
    };
    this.control = control;
    configure(control);
    return this;
  }
  addButton(configure) {
    const buttonEl = this.settingEl.createEl("button");
    const control = { buttonEl, setButtonText(value) { buttonEl.text = value; return this; },
      setDisabled(value) { buttonEl.disabled = value; return this; },
      onClick(callback) { buttonEl.addEventListener("click", callback); return this; } };
    configure(control); return this;
  }
  addDropdown(configure) {
    const selectEl = this.settingEl.createEl("select");
    const control = { selectEl, options: {}, addOption(value, label) { this.options[value] = label; return this; },
      setValue(value) { this.value = value; return this; },
      setDisabled(value) { selectEl.disabled = value; return this; },
      onChange(callback) { this.callback = callback; return this; },
      async change(value) { if (!selectEl.disabled) { this.value = value; await this.callback?.(value); } } };
    this.dropdown = control; configure(control); return this;
  }
  addToggle(configure) {
    const toggleEl = this.settingEl.createEl("input");
    const control = { toggleEl, setValue(value) { this.value = value; return this; },
      setDisabled(value) { toggleEl.disabled = value; return this; },
      onChange(callback) { this.callback = callback; return this; },
      async change(value) { if (!toggleEl.disabled) { this.value = value; await this.callback?.(value); } } };
    this.toggle = control; configure(control); return this;
  }
}

class TFile {
  constructor(filePath) {
    this.path = filePath;
    this.name = path.posix.basename(filePath);
    this.extension = path.posix.extname(filePath).slice(1);
    this.basename = this.name.slice(0, -(this.extension.length + 1));
    this.stat = { ctime: Date.UTC(2026, 9, 31), mtime: Date.UTC(2026, 9, 31), size: 1 };
  }
}
class TFolder { constructor(folderPath) { this.path = folderPath; this.name = path.posix.basename(folderPath); this.children = []; } }
class FileSystemAdapter { getBasePath() { return "D:\\SourceBindingFixture"; } }
class StubBase {}
class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element(); this.contentEl = this.modalEl.createDiv(); this.titleEl = this.modalEl.createDiv(); }
  open() { modals.push(this); this.onOpen?.(); }
  close() { this.onClose?.(); }
}
class Notice { constructor() { this.messageEl = new Element(); } hide() {} }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new Element(); } }
class Plugin {
  constructor() {
    this.manifest = { id: "ima-speed-sync", name: "IMA Share Sync", version: "test", dir: ".obsidian/plugins/ima-speed-sync" };
    this.files = new Map();
    this.contents = new Map();
    this.created = [];
    this.modified = [];
    this.savedData = null;
    this.saveCalls = 0;
    this.app = {
      vault: {
        configDir: ".obsidian",
        adapter: new FileSystemAdapter(),
        getAbstractFileByPath: filePath => this.files.get(filePath) || null,
        getFiles: () => [...this.files.values()].filter(file => file instanceof TFile),
        createFolder: async folderPath => this.addFolder(folderPath),
        read: async file => this.contents.get(file.path) || "",
        cachedRead: async file => this.contents.get(file.path) || "",
        create: async (filePath, content) => { this.created.push(filePath); this.contents.set(filePath, content); return this.addFile(filePath); },
        process: async file => { this.modified.push(file.path); throw new Error("Fixture does not authorize overwrites"); },
        on() { return {}; },
      },
      metadataCache: { getFileCache() { return null; } },
      workspace: { onLayoutReady: callback => { this.layoutReady = callback; }, getLeavesOfType() { return []; } },
    };
  }
  addFolder(folderPath) {
    if (!folderPath) return null;
    if (this.files.has(folderPath)) return this.files.get(folderPath);
    const parent = this.addFolder(path.posix.dirname(folderPath) === "." ? "" : path.posix.dirname(folderPath));
    const folder = new TFolder(folderPath);
    this.files.set(folderPath, folder);
    parent?.children.push(folder);
    return folder;
  }
  addFile(filePath) {
    if (this.files.has(filePath)) return this.files.get(filePath);
    const parent = this.addFolder(path.posix.dirname(filePath));
    const file = new TFile(filePath);
    this.files.set(filePath, file);
    parent.children.push(file);
    return file;
  }
  async loadData() { return null; }
  async saveData(data) { this.saveCalls++; this.savedData = clone(data); }
  addCommand() {}
  addSettingTab(tab) { this.fixtureSettingsTab = tab; }
  addRibbonIcon() { return new Element(); }
  registerView() {}
  registerDomEvent(_target, name, callback) { (this.domCallbacks ??= new Map()).set(name, callback); }
}

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "obsidian") return {
    Plugin, PluginSettingTab, ItemView: StubBase, Modal, Menu: StubBase, Notice,
    Setting, WorkspaceLeaf: StubBase, FileSystemAdapter, Component: StubBase,
    TFile, TFolder, Platform: { isWin: true }, normalizePath,
    addIcon() {}, setIcon() {}, getLanguage() { return "zh"; },
  };
  if (name === "child_process") return { spawn(file, args) {
    if (spawnFixture) return spawnFixture(file, args);
    externalSpawnCount++;
    throw new Error("No real UI/process execution is allowed in source-binding tests");
  } };
  return originalLoad.call(this, name, parent, isMain);
};
let ImaPlugin;
const pluginPath = process.env.IMA_BINDING_TEST_PLUGIN || path.join(__dirname, "../dist/main.js");
try { const loaded = require(pluginPath); ImaPlugin = loaded.default || loaded; }
finally { Module._load = originalLoad; }

const knowledgeBaseName = "Binding fixture knowledge base";
const renamedKnowledgeBase = "Binding fixture knowledge base renamed";
const oldFolder = "2026年10月【最新】";
const newFolder = "2026年10月";
const destinationPath = "Fixture\\Reports";
const localDestination = `Fixture/Reports/${oldFolder}`;
const sourceScope = createHash("sha256").update(knowledgeBaseName).digest("hex");
const fixtureEntries = Array.from({ length: 100 }, (_, index) => ({
  path: `${localDestination}/day/report-${String(index + 1).padStart(3, "0")}.pdf`,
  sourceId: `knowledge-pdf_binding-fixture-${String(index + 1).padStart(3, "0")}`,
  sourceScope,
}));

function storedFixture(count = 67) {
  return {
    autoSync: false, hasConsented: true, knowledgeBaseName, folderName: oldFolder,
    destinationPath, includeSourceFolder: true, overwriteSameName: false,
    maxItems: 100, syncScopeMode: "recent", contentMode: "general",
    includeSubfolders: true, maxFolders: 1, maxFolderDepth: 1,
    generalSelectionMode: "total", titleFilterMode: "all", titleFilter: "",
    allowForeground: false, notificationsEnabled: false, showOperationBefore: false,
    showOperationAfter: false, enableMarkdownConversion: false,
    syncedAttachments: clone(fixtureEntries.slice(0, count)), syncReports: [],
  };
}

function pendingRecord(index, overrides = {}) {
  return {
    sourceTitle: `Pending source ${index}`,
    sourceId: `knowledge-note_pending_fixture_${String(index).padStart(3, "0")}`,
    kind: "note", relativeFolder: ["day"], scrollPercent: 85 + index, scrollStep: index,
    ...overrides,
  };
}
function withPending(records, unresumableCount = 0) {
  return { ...storedFixture(), pendingSourceResume: {
    version: 1, sourceScope, localDestination, knowledgeBaseName, folderName: oldFolder,
    records: clone(records), unresumableCount,
  } };
}
function completedItem(record) {
  return { sourceTitle: record.sourceTitle, sourceId: record.sourceId, relativeFolder: record.relativeFolder,
    body: `Completed content for ${record.sourceId}.`, complete: true };
}
function copyFixtureFiles(from, to) {
  for (const file of from.files.values()) if (file instanceof TFile) to.addFile(file.path);
  for (const [filePath, content] of from.contents) to.contents.set(filePath, content);
}

async function loadFixture(stored = storedFixture()) {
  const plugin = new ImaPlugin();
  plugin.loadData = async () => clone(stored);
  for (const entry of stored.syncedAttachments || []) plugin.addFile(entry.path);
  await plugin.onload();
  // This suite exercises the historical explicit-binding protocol in isolation.
  // Native ID startup/migration and the no-profile safety gate are covered by
  // test-native-integration.cjs; never permit a real desktop worker in this fixture.
  plugin.identityProvider = undefined;
  plugin.openOperationCard = async () => null;
  plugin.settingsTab.display = () => {};
  return plugin;
}

function inspection(folderName = newFolder, selectedKnowledgeBase = knowledgeBaseName) {
  return { knowledgeBaseName: selectedKnowledgeBase, folderName, breadcrumb: [folderName], stableFolderId: null, identityMode: "explicit-confirmation" };
}
function successOutput(folderName = newFolder, selectedKnowledgeBase = knowledgeBaseName) {
  return JSON.stringify({ items: [], errors: [], skippedTitles: [], sourceInspection: inspection(folderName, selectedKnowledgeBase) });
}
function emptyIndex() { return { metadataByPath: new Map() }; }
function settingsSnapshot(plugin) { return JSON.stringify({ settings: plugin.settings, attachments: plugin.syncedAttachments }); }
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "modal fixture did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
function modalControl(modal, name) {
  const setting = descendants(modal.contentEl).find(element => element.setting?.name === name)?.setting;
  assert.ok(setting, `missing modal setting: ${name}`);
  return setting;
}
function modalButton(modal, text) {
  const button = descendants(modal.contentEl).find(element => element.tag === "button" && element.text === text);
  assert.ok(button, `missing modal button: ${text}`);
  return button;
}
async function scenario(name, run) { await run(); scenarioCount++; console.log(`PASS: ${name}`); }

function powershellGeneralResults() {
  const sourcePath = path.join(__dirname, "../src/sync.ps1").replace(/'/g, "''");
  const script = `
$ErrorActionPreference='Stop'
$ImaSpeedSyncSkipMain=$true
$source=[IO.File]::ReadAllText('${sourcePath}',[Text.Encoding]::UTF8)
. ([scriptblock]::Create($source.Replace('[Windows.Automation.AutomationElement]$', '[object]$')))
function Get-ImaRoot { throw 'OFFLINE CONTRACT: real desktop access is forbidden' }
function Get-ImaWindowRoots { throw 'OFFLINE CONTRACT: real windows are forbidden' }
function Open-ImaGeneralPath { throw 'OFFLINE CONTRACT: unexpected folder navigation' }
function Save-ImaOriginalFile { throw 'OFFLINE CONTRACT: downloads are forbidden' }
function Test-ImaCancellation {}
function Write-SyncLog {}
function Write-ImaProgress {}
function Get-ImaGeneralCandidates { return $script:FixtureRecords }
function Get-ImaLocalRelativePath { param($Record) return 'day/PowerShell contract note.md' }
function Invoke-ImaArticleRecord { param($Record) }
function Read-ImaGeneralArticle { param($Name) return [pscustomobject]@{updatedDate='2026-11-01';body='Complete text emitted by the production PowerShell serializer.';complete=$true} }
function Close-ImaCurrentArticle {}
function Reset-Contract {
  $script:SourceNeedsRebind=$null
  $script:SourcePathGuard=$null
  $script:ResumeRecords=@()
  $script:GeneralFolderPath=@('day')
  $script:SkipSourceIds=@{}
  $script:ExistingFiles=@{}
  $script:CompletedItems=New-Object Collections.Generic.List[object]
  $script:CompletedErrors=New-Object Collections.Generic.List[object]
  $script:CompletedSkippedTitles=New-Object Collections.Generic.List[string]
}
Reset-Contract
$script:FixtureRecords=@()
$empty=Invoke-ImaGeneralSync $null
Reset-Contract
$script:FixtureRecords=@([pscustomobject]@{Name='PowerShell contract note';SourceId='knowledge-note_powershell_contract_001';Key='knowledge-note_powershell_contract_001';Kind='note';RelativeFolder=@('day');ScrollPercent=0;ScrollStep=0})
$single=Invoke-ImaGeneralSync $null
[pscustomobject]@{emptyJson=($empty|ConvertTo-Json -Depth 20 -Compress);singleJson=($single|ConvertTo-Json -Depth 20 -Compress)}|ConvertTo-Json -Depth 3 -Compress
`;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  }).replace(/^\uFEFF/, "").trim());
}

(async () => {
  await scenario("real PowerShell success JSON with explicit null parses and imports through the real sync coordinator", async () => {
    const output = powershellGeneralResults();
    const empty = JSON.parse(output.emptyJson);
    assert.equal(Object.hasOwn(empty, "sourceNeedsRebind"), true, "the fixture must retain PowerShell's explicit null field");
    assert.equal(empty.sourceNeedsRebind, null);
    assert.deepEqual(empty.sourcePendingRecords, []);
    assert.equal(empty.sourcePendingUnresumableCount, 0);
    assert.deepEqual(empty.items, []);
    const plugin = await loadFixture(storedFixture(0));
    const parsed = plugin.parseExtractionResult(output.emptyJson);
    assert.equal(parsed.sourceNeedsRebind, undefined);
    assert.deepEqual(parsed.sourcePendingRecords, []);
    assert.equal(parsed.sourcePendingUnresumableCount, 0);
    const single = JSON.parse(output.singleJson);
    assert.equal(single.sourceNeedsRebind, null);
    assert.equal(single.items.length, 1);
    assert.equal(single.sourcePendingRecords.length, 1, "downloaded/extracted candidates retain their identity until imported");
    plugin.runPowerShell = async () => output.singleJson;
    await plugin.sync(true);
    assert.equal(plugin.created.length, 1, "a real PowerShell null field must not prevent a completed item from being saved");
    assert.equal(plugin.syncReports[0].status, "success");
    assert.equal(plugin.getPendingSourceResume(), undefined, "a normal success does not create a rebind queue");
    const saved = plugin.contents.get(plugin.created[0]);
    assert.ok(saved.includes("knowledge-note_powershell_contract_001"));
    assert.ok(saved.includes("Complete text emitted by the production PowerShell serializer."));
    assert.throws(() => plugin.parseExtractionResult(JSON.stringify({ ...empty, sourceNeedsRebind: "invalid" })), /./,
      "null compatibility must not weaken non-null source-rebind validation");
    plugin.onunload();
  });

  await scenario("legacy migration fixes the local destination and keeps all 67 source identities", async () => {
    const plugin = await loadFixture();
    assert.equal(plugin.getEffectiveDestinationPath({ ...plugin.settings, folderName: newFolder }), localDestination,
      "remote renaming must not redirect local files away from their existing directory");
    assert.equal(typeof plugin.getSourceBinding, "function", "the built plugin must expose source binding migration");
    const binding = plugin.getSourceBinding();
    assert.equal(binding.version, 1);
    assert.equal(binding.knowledgeBaseName, knowledgeBaseName);
    assert.equal(binding.remoteFolderName, oldFolder);
    assert.equal(binding.localDestination, localDestination);
    assert.equal(binding.sourceScope, sourceScope);
    assert.equal(plugin.getEffectiveDestinationPath(), localDestination);
    assert.deepEqual(plugin.getExistingSourceIds(emptyIndex(), plugin.settings).sort(), fixtureEntries.slice(0, 67).map(entry => entry.sourceId).sort());
    const before = clone(plugin.syncedAttachments);
    await plugin.saveSettings();
    const reloaded = await loadFixture(plugin.savedData);
    assert.deepEqual(reloaded.getSourceBinding(), binding);
    assert.deepEqual(reloaded.syncedAttachments, before);
    assert.equal(reloaded.getEffectiveDestinationPath(), localDestination);
    reloaded.onunload();
    plugin.onunload();
  });

  await scenario("migration preserves an explicit base-only destination", async () => {
    const stored = storedFixture(0);
    stored.includeSourceFolder = false;
    const plugin = await loadFixture(stored);
    assert.equal(plugin.getEffectiveDestinationPath(), "Fixture/Reports");
    assert.equal(plugin.getSourceBinding().localDestination, "Fixture/Reports");
    assert.equal(plugin.getSourceBinding().sourceScope, sourceScope);
    plugin.onunload();
  });

  await scenario("inspection alone cannot rebind; explicit confirmation preserves path, scope and all 67 skips", async () => {
    const plugin = await loadFixture();
    const initial = settingsSnapshot(plugin);
    const saves = plugin.saveCalls;
    const operations = [];
    plugin.runPowerShell = async (...args) => {
      operations.push(args[5] || "sync");
      assert.equal(args[5], "inspect-source", "rebind must use the non-downloading inspection operation");
      assert.equal(args[2].folderName, newFolder);
      return successOutput();
    };
    const session = plugin.beginSourceRebind();
    assert.equal(session.localDestination, localDestination);
    assert.equal(session.sourceScope, sourceScope);
    plugin.setSourceRebindCandidate(session, newFolder);
    await assert.rejects(plugin.confirmSourceBinding(session), /./, "confirmation without a successful inspection must fail");
    assert.equal(settingsSnapshot(plugin), initial);
    const verified = await plugin.inspectSourceFolder(session);
    assert.deepEqual(verified, inspection());
    assert.equal(settingsSnapshot(plugin), initial, "a successful inspection alone does not change settings or the ledger");
    assert.equal(plugin.saveCalls, saves);
    await plugin.sync(true);
    assert.deepEqual(operations, ["inspect-source"], "sync must not start while a rebind session awaits confirmation");
    await plugin.confirmSourceBinding(session);
    assert.equal(plugin.settings.folderName, newFolder);
    assert.equal(plugin.getSourceBinding().remoteFolderName, newFolder);
    assert.equal(plugin.getSourceBinding().localDestination, localDestination);
    assert.equal(plugin.getSourceBinding().sourceScope, sourceScope);
    assert.deepEqual(plugin.getSourceBinding().verifiedBreadcrumb, [newFolder]);
    assert.deepEqual(plugin.syncedAttachments, fixtureEntries.slice(0, 67));
    assert.deepEqual(plugin.getExistingSourceIds(emptyIndex(), plugin.settings).sort(), fixtureEntries.slice(0, 67).map(entry => entry.sourceId).sort());
    assert.equal(plugin.saveCalls, saves + 1, "only the confirmed rebind writes settings");
    const reloaded = await loadFixture(plugin.savedData);
    assert.equal(reloaded.settings.folderName, newFolder);
    assert.equal(reloaded.getEffectiveDestinationPath(), localDestination);
    assert.deepEqual(reloaded.getSourceBinding(), plugin.getSourceBinding());
    assert.deepEqual(reloaded.syncedAttachments, plugin.syncedAttachments);
    reloaded.onunload();
    plugin.onunload();
  });

  await scenario("cancel after successful inspection leaves settings and persisted data unchanged", async () => {
    const plugin = await loadFixture();
    await plugin.saveSettings();
    const initial = settingsSnapshot(plugin);
    const saved = clone(plugin.savedData);
    const saves = plugin.saveCalls;
    plugin.runPowerShell = async () => successOutput();
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    plugin.cancelSourceRebind(session);
    await assert.rejects(plugin.confirmSourceBinding(session), /./);
    assert.equal(settingsSnapshot(plugin), initial);
    assert.deepEqual(plugin.savedData, saved);
    assert.equal(plugin.saveCalls, saves);
    plugin.onunload();
  });

  await scenario("explicitly confirming both renamed remote names preserves the old scope and all 67 identities", async () => {
    const plugin = await loadFixture();
    const initial = settingsSnapshot(plugin);
    const saves = plugin.saveCalls;
    plugin.runPowerShell = async (_max, _titles, settings, _run, _ids, operation) => {
      assert.equal(operation, "inspect-source");
      assert.equal(settings.knowledgeBaseName, renamedKnowledgeBase);
      assert.equal(settings.folderName, newFolder);
      return successOutput(newFolder, renamedKnowledgeBase);
    };
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    assert.equal(settingsSnapshot(plugin), initial, "inspection cannot change either stored remote name or the original source scope");
    assert.equal(plugin.saveCalls, saves);
    await plugin.confirmSourceBinding(session);
    assert.equal(plugin.settings.knowledgeBaseName, renamedKnowledgeBase);
    assert.equal(plugin.settings.folderName, newFolder);
    assert.equal(plugin.getSourceBinding().knowledgeBaseName, renamedKnowledgeBase);
    assert.equal(plugin.getSourceBinding().remoteFolderName, newFolder);
    assert.equal(plugin.getSourceBinding().sourceScope, sourceScope);
    assert.notEqual(sourceScope, createHash("sha256").update(renamedKnowledgeBase).digest("hex"), "fixture must distinguish preserved identity from a new-name hash");
    assert.equal(plugin.getEffectiveDestinationPath(), localDestination);
    assert.deepEqual(plugin.getExistingSourceIds(emptyIndex(), plugin.settings).sort(), fixtureEntries.slice(0, 67).map(entry => entry.sourceId).sort());
    const reloaded = await loadFixture(plugin.savedData);
    assert.equal(reloaded.settings.knowledgeBaseName, renamedKnowledgeBase);
    assert.equal(reloaded.settings.folderName, newFolder);
    assert.equal(reloaded.getSourceBinding().sourceScope, sourceScope);
    assert.equal(reloaded.getEffectiveDestinationPath(), localDestination);
    assert.deepEqual(reloaded.syncedAttachments, fixtureEntries.slice(0, 67));
    reloaded.onunload();
    plugin.onunload();
  });

  for (const [label, response] of [
    ["failed", { items: [], errors: [{ title: newFolder, message: "inspection failed" }] }],
    ["ambiguous", { items: [], errors: [], sourceNeedsRebind: { reason: "ambiguous", expectedPath: [newFolder], actualPath: [], message: "multiple exact folder matches" } }],
    ["wrong path", { items: [], errors: [], sourceInspection: { ...inspection(), breadcrumb: ["different folder"] } }],
    ["wrong knowledge base", { items: [], errors: [], sourceInspection: { ...inspection(), knowledgeBaseName: "other KB" } }],
    ["wrong folder", { items: [], errors: [], sourceInspection: inspection("2026年11月") }],
  ]) {
    await scenario(`${label} inspection never commits settings`, async () => {
      const plugin = await loadFixture();
      const initial = settingsSnapshot(plugin);
      const saves = plugin.saveCalls;
      plugin.runPowerShell = async () => JSON.stringify(response);
      const session = plugin.beginSourceRebind();
      plugin.setSourceRebindCandidate(session, newFolder);
      await assert.rejects(plugin.inspectSourceFolder(session), /./);
      await assert.rejects(plugin.confirmSourceBinding(session), /./);
      assert.equal(settingsSnapshot(plugin), initial);
      assert.equal(plugin.saveCalls, saves);
      plugin.cancelSourceRebind(session);
      plugin.onunload();
    });
  }

  await scenario("rebind sessions are exclusive and cannot overlap an active sync", async () => {
    const plugin = await loadFixture();
    const session = plugin.beginSourceRebind();
    assert.throws(() => plugin.beginSourceRebind(), /./);
    plugin.cancelSourceRebind(session);
    plugin.running = true;
    assert.throws(() => plugin.beginSourceRebind(), /./);
    plugin.running = false;
    plugin.onunload();
  });

  await scenario("changing a candidate invalidates a completed inspection", async () => {
    const plugin = await loadFixture();
    const initial = settingsSnapshot(plugin);
    plugin.runPowerShell = async () => successOutput();
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    plugin.setSourceRebindCandidate(session, "2026年11月");
    await assert.rejects(plugin.confirmSourceBinding(session), /./);
    assert.equal(settingsSnapshot(plugin), initial);
    plugin.cancelSourceRebind(session);
    plugin.onunload();
  });

  await scenario("changing the knowledge-base candidate invalidates a completed inspection", async () => {
    const plugin = await loadFixture();
    const initial = settingsSnapshot(plugin);
    plugin.runPowerShell = async () => successOutput();
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
    await assert.rejects(plugin.confirmSourceBinding(session), /./);
    assert.equal(settingsSnapshot(plugin), initial);
    plugin.cancelSourceRebind(session);
    plugin.onunload();
  });

  for (const action of ["cancel", "candidate-change", "knowledge-base-change", "unload"]) {
    await scenario(`${action} discards an in-flight inspection reply`, async () => {
      const plugin = await loadFixture();
      const initial = settingsSnapshot(plugin);
      const saves = plugin.saveCalls;
      const pending = deferred();
      let invoked = false;
      plugin.runPowerShell = async () => { invoked = true; return pending.promise; };
      const session = plugin.beginSourceRebind();
      plugin.setSourceRebindCandidate(session, newFolder);
      const result = plugin.inspectSourceFolder(session);
      const rejection = assert.rejects(result, /./);
      await flush();
      assert.equal(invoked, true, "fixture must cancel a genuinely started inspection");
      if (action === "cancel") plugin.cancelSourceRebind(session);
      if (action === "candidate-change") plugin.setSourceRebindCandidate(session, "2026年11月");
      if (action === "knowledge-base-change") plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
      if (action === "unload") plugin.onunload();
      pending.resolve(successOutput());
      await rejection;
      await assert.rejects(plugin.confirmSourceBinding(session), /./);
      assert.equal(settingsSnapshot(plugin), initial);
      assert.equal(plugin.saveCalls, saves);
      if (action !== "unload") { plugin.cancelSourceRebind(session); plugin.onunload(); }
    });
  }

  await scenario("failed settings persistence rolls the confirmed binding back", async () => {
    const plugin = await loadFixture();
    await plugin.saveSettings();
    const initial = settingsSnapshot(plugin);
    const saved = clone(plugin.savedData);
    plugin.runPowerShell = async () => successOutput(newFolder, renamedKnowledgeBase);
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    plugin.saveData = async () => { throw new Error("fixture disk write failed"); };
    await assert.rejects(plugin.confirmSourceBinding(session), /fixture disk write failed/);
    assert.equal(settingsSnapshot(plugin), initial);
    assert.deepEqual(plugin.savedData, saved);
    plugin.cancelSourceRebind(session);
    plugin.onunload();
  });

  await scenario("completed 67 + 33 identities survive rebinding and both repeat runs request zero downloads", async () => {
    const plugin = await loadFixture(storedFixture(100));
    plugin.runPowerShell = async () => successOutput(newFolder, renamedKnowledgeBase);
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    await plugin.confirmSourceBinding(session);
    let syncCalls = 0;
    let wouldDownload = 0;
    plugin.runPowerShell = async (_max, skipTitles, settings, _run, skipSourceIds, operation = "sync") => {
      assert.equal(operation, "sync");
      assert.equal(settings.knowledgeBaseName, renamedKnowledgeBase);
      assert.equal(settings.folderName, newFolder);
      assert.equal(plugin.getEffectiveDestinationPath(settings), localDestination);
      assert.deepEqual(skipTitles, [], "general-mode identity skipping must not fall back to titles");
      assert.deepEqual([...skipSourceIds].sort(), fixtureEntries.map(entry => entry.sourceId).sort());
      syncCalls++;
      wouldDownload += fixtureEntries.filter(entry => !skipSourceIds.includes(entry.sourceId)).length;
      return JSON.stringify({ items: [], skippedTitles: fixtureEntries.map(entry => path.posix.basename(entry.path)), errors: [] });
    };
    await plugin.sync(true);
    await plugin.sync(true);
    assert.equal(syncCalls, 2, "both repeats must reach the real sync coordinator's runner boundary");
    assert.equal(wouldDownload, 0);
    assert.equal(plugin.created.length, 0);
    assert.equal(plugin.modified.length, 0);
    assert.deepEqual(plugin.syncedAttachments, fixtureEntries);
    const reloaded = await loadFixture(plugin.savedData);
    let reloadedCalls = 0;
    reloaded.runPowerShell = async (_max, _titles, settings, _run, skipSourceIds) => {
      reloadedCalls++;
      assert.equal(settings.knowledgeBaseName, renamedKnowledgeBase);
      assert.equal(settings.folderName, newFolder);
      assert.equal(reloaded.getSourceBinding(settings).sourceScope, sourceScope);
      assert.deepEqual([...skipSourceIds].sort(), fixtureEntries.map(entry => entry.sourceId).sort());
      return JSON.stringify({ items: [], skippedTitles: fixtureEntries.map(entry => path.posix.basename(entry.path)), errors: [] });
    };
    await reloaded.sync(true);
    assert.equal(reloadedCalls, 1);
    assert.equal(reloaded.created.length, 0);
    assert.equal(reloaded.modified.length, 0);
    reloaded.onunload();
    plugin.onunload();
  });

  await scenario("mid-run rename preserves completed output without silently rebinding or starting another run", async () => {
    const plugin = await loadFixture();
    const binding = clone(plugin.getSourceBinding());
    let syncCalls = 0;
    plugin.runPowerShell = async () => {
      syncCalls++;
      return JSON.stringify({
        items: [{ sourceTitle: "Completed before rename", sourceId: "knowledge-note_binding-completed", body: "This completed item must be preserved.", complete: true }],
        errors: [{ title: oldFolder, message: "directory changed after the first item" }],
        sourceNeedsRebind: { reason: "path-changed", expectedPath: [oldFolder], actualPath: [newFolder], message: "directory changed after the first item" },
      });
    };
    await plugin.sync(true);
    assert.equal(syncCalls, 1, "a directory change must not silently start a new extraction");
    assert.deepEqual(plugin.getSourceBinding(), binding);
    assert.equal(plugin.settings.folderName, oldFolder);
    assert.equal(plugin.created.length, 1);
    assert.ok(plugin.created[0].startsWith(`${localDestination}/`));
    assert.equal(plugin.modified.length, 0);
    assert.equal(plugin.syncReports[0].status, "failed");
    assert.ok(plugin.syncReports[0].errors.some(error => error.message.includes("directory changed")));
    plugin.onunload();
  });

  await scenario("real rebind modal requires a fresh inspection and saves only the explicitly confirmed names", async () => {
    const plugin = await loadFixture();
    const before = settingsSnapshot(plugin);
    const saves = plugin.saveCalls;
    const modalCount = modals.length;
    let inspectionCalls = 0;
    plugin.runPowerShell = async (_max, _titles, settings, _run, _ids, operation) => {
      assert.equal(operation, "inspect-source");
      inspectionCalls++;
      return successOutput(settings.folderName, settings.knowledgeBaseName);
    };
    plugin.openSourceRebind();
    assert.equal(modals.length, modalCount + 1, "the user entry point must open the actual SourceRebindModal");
    const modal = modals.at(-1);
    assert.equal(modal.titleEl.text, "重新绑定");
    assert.equal(modalControl(modal, "继续保存到").description, localDestination);
    const kb = modalControl(modal, "新的知识库名称").control;
    const folder = modalControl(modal, "新文件夹名称").control;
    const check = modalButton(modal, "检查来源");
    const confirm = modalButton(modal, "确认重新绑定");
    const status = descendants(modal.contentEl).find(element => element.role === "status");
    assert.ok(status);
    assert.equal(confirm.disabled, true);
    confirm.click();
    assert.equal(plugin.saveCalls, saves, "a disabled confirm cannot commit");
    await kb.change(renamedKnowledgeBase);
    await folder.change(newFolder);
    assert.equal(settingsSnapshot(plugin), before);
    check.click();
    assert.equal(check.disabled, true);
    await waitFor(() => !check.disabled);
    assert.equal(confirm.disabled, false);
    assert.ok(status.text.includes(renamedKnowledgeBase));
    assert.ok(status.text.includes(newFolder));
    assert.ok(status.text.includes("已验证路径"));
    assert.equal(modalControl(modal, "继续保存到").description, localDestination);
    assert.equal(plugin.saveCalls, saves, "checking must not persist the pending candidate");
    await folder.change("2026年11月");
    assert.equal(confirm.disabled, true);
    assert.equal(status.text, "");
    await folder.change(newFolder);
    check.click();
    await waitFor(() => !check.disabled);
    assert.equal(confirm.disabled, false);
    assert.equal(inspectionCalls, 2);
    confirm.click();
    await waitFor(() => modal.closed === true);
    assert.equal(plugin.saveCalls, saves + 1);
    assert.equal(plugin.savedData.knowledgeBaseName, renamedKnowledgeBase);
    assert.equal(plugin.savedData.folderName, newFolder);
    assert.equal(plugin.savedData.sourceBinding.localDestination, localDestination);
    assert.equal(plugin.savedData.sourceBinding.sourceScope, sourceScope);
    assert.deepEqual(plugin.syncedAttachments, fixtureEntries.slice(0, 67));
    plugin.onunload();
  });

  await scenario("closing the real modal during inspection discards the reply without saving", async () => {
    const plugin = await loadFixture();
    const before = settingsSnapshot(plugin);
    const saves = plugin.saveCalls;
    const pending = deferred();
    let invoked = false;
    plugin.runPowerShell = async () => { invoked = true; return pending.promise; };
    plugin.openSourceRebind();
    const modal = modals.at(-1);
    await modalControl(modal, "新的知识库名称").control.change(renamedKnowledgeBase);
    await modalControl(modal, "新文件夹名称").control.change(newFolder);
    modalButton(modal, "检查来源").click();
    await waitFor(() => invoked);
    modalButton(modal, "取消").click();
    assert.equal(modal.closed, true);
    pending.resolve(successOutput(newFolder, renamedKnowledgeBase));
    await waitFor(() => !plugin.isRunning);
    assert.equal(settingsSnapshot(plugin), before);
    assert.equal(plugin.saveCalls, saves);
    assert.equal(modal.contentEl.children.length, 0);
    plugin.onunload();
  });

  await scenario("only a source interruption creates a pending queue and completed IDs are removed after saving", async () => {
    const plugin = await loadFixture();
    const first = pendingRecord(1);
    const second = pendingRecord(2);
    plugin.runPowerShell = async () => JSON.stringify({
      items: [completedItem(first)], errors: [], sourcePendingRecords: [first, second], sourcePendingUnresumableCount: 2,
      sourceNeedsRebind: { reason: "path-changed", expectedPath: [oldFolder], actualPath: [newFolder], message: "source changed after one completed item" },
    });
    await plugin.sync(true);
    assert.equal(plugin.created.length, 1);
    const pending = plugin.getPendingSourceResume();
    assert.equal(pending.sourceScope, sourceScope);
    assert.equal(pending.localDestination, localDestination);
    assert.equal(pending.knowledgeBaseName, knowledgeBaseName);
    assert.equal(pending.folderName, oldFolder);
    assert.deepEqual(pending.records, [second], "a completed file must be excluded by its persisted source ID");
    assert.equal(pending.unresumableCount, 2);
    assert.deepEqual(plugin.savedData.pendingSourceResume, pending);
    plugin.onunload();

    const ordinaryFailure = await loadFixture();
    ordinaryFailure.runPowerShell = async () => JSON.stringify({
      items: [], errors: [{ title: second.sourceTitle, message: "ordinary extraction failure" }],
      sourcePendingRecords: [second], sourcePendingUnresumableCount: 0,
    });
    await ordinaryFailure.sync(true);
    assert.equal(ordinaryFailure.getPendingSourceResume(), undefined, "ordinary errors do not create an implicit retry queue");
    ordinaryFailure.onunload();
  });

  await scenario("manual resume sends only the original remaining records while automatic sync leaves the queue untouched", async () => {
    const known = pendingRecord(1, { sourceTitle: "report-001.pdf", sourceId: fixtureEntries[0].sourceId, kind: "pdf" });
    const remaining = pendingRecord(2, { sourceTitle: "report-001.pdf" });
    const plugin = await loadFixture(withPending([known, remaining]));
    const pendingBefore = clone(plugin.getPendingSourceResume());
    const savesBefore = plugin.saveCalls;
    const newlyAppeared = pendingRecord(3, { sourceTitle: "A new source added after interruption" });
    let calls = 0;
    let request;
    plugin.runPowerShell = async (_max, skipTitles, _settings, _run, skipIds, operation, resumeRecords) => {
      calls++;
      request = clone({ skipTitles, skipIds, operation, resumeRecords });
      return JSON.stringify({ items: [], errors: [{ title: remaining.sourceTitle, message: "fixture leaves this record pending" }] });
    };
    await plugin.sync(false);
    assert.equal(calls, 0);
    assert.deepEqual(plugin.getPendingSourceResume(), pendingBefore);
    assert.equal(plugin.saveCalls, savesBefore, "automatic sync does not consume or rewrite the queue");
    await plugin.sync(true);
    assert.equal(calls, 1, "one manual click performs one bounded resume request");
    assert.equal(request.operation, "sync");
    assert.deepEqual(request.skipTitles, []);
    assert.ok(request.skipIds.includes(known.sourceId));
    assert.deepEqual(request.resumeRecords, [remaining], "saved identities are removed, but an unsaved item with the same title remains");
    assert.ok(!request.resumeRecords.some(record => record.sourceId === newlyAppeared.sourceId), "new candidates must not enter a resume request");
    assert.deepEqual(plugin.getPendingSourceResume().records, [remaining]);
    assert.equal(plugin.created.length, 0);
    assert.equal(plugin.modified.length, 0);
    plugin.onunload();
  });

  await scenario("partial resume persists only the remaining records and reload continues them without a new scan", async () => {
    const records = [pendingRecord(1), pendingRecord(2), pendingRecord(3)];
    const plugin = await loadFixture(withPending(records));
    const requests = [];
    plugin.runPowerShell = async (_max, _titles, _settings, _run, _ids, operation, resumeRecords) => {
      assert.equal(operation, "sync");
      requests.push(clone(resumeRecords));
      return JSON.stringify({ items: [completedItem(records[0])], errors: [{ title: records[1].sourceTitle, message: "partial completion" }] });
    };
    await plugin.sync(true);
    assert.deepEqual(requests, [records]);
    assert.deepEqual(plugin.getPendingSourceResume().records, records.slice(1));
    assert.equal(plugin.created.length, 1);
    const reloaded = await loadFixture(plugin.savedData);
    copyFixtureFiles(plugin, reloaded);
    assert.deepEqual(reloaded.getPendingSourceResume().records, records.slice(1));
    let call = 0;
    reloaded.runPowerShell = async (_max, _titles, _settings, _run, skipIds, operation, resumeRecords) => {
      assert.equal(operation, "sync");
      assert.ok(skipIds.includes(records[0].sourceId), "the completed item remains in the source index after reload");
      const expected = call === 0 ? records.slice(1) : records.slice(2);
      assert.deepEqual(resumeRecords, expected);
      call++;
      return JSON.stringify({ items: [completedItem(expected[0])], errors: [] });
    };
    await reloaded.sync(true);
    assert.deepEqual(reloaded.getPendingSourceResume().records, records.slice(2));
    await reloaded.sync(true);
    assert.equal(call, 2);
    assert.equal(reloaded.getPendingSourceResume(), undefined);
    assert.equal(reloaded.created.length, 2);
    assert.equal(reloaded.modified.length, 0);
    assert.deepEqual(reloaded.syncedAttachments, fixtureEntries.slice(0, 67));
    reloaded.onunload();
    plugin.onunload();
  });

  await scenario("a complete extraction that fails to save remains queued until a real file is persisted", async () => {
    const record = pendingRecord(1);
    const plugin = await loadFixture(withPending([record]));
    const create = plugin.app.vault.create;
    plugin.app.vault.create = async () => { throw new Error("fixture vault write failed"); };
    plugin.runPowerShell = async () => JSON.stringify({ items: [completedItem(record)], errors: [] });
    await plugin.sync(true);
    assert.deepEqual(plugin.getPendingSourceResume().records, [record], "complete=true is not evidence of a persisted file");
    assert.equal(plugin.created.length, 0);
    assert.equal(plugin.syncReports[0].status, "failed");
    plugin.app.vault.create = create;
    await plugin.sync(true);
    assert.equal(plugin.created.length, 1);
    assert.equal(plugin.getPendingSourceResume(), undefined);
    plugin.onunload();
  });

  await scenario("the native runner serializes the manual queue into input JSON without a real process", async () => {
    const records = [pendingRecord(1), pendingRecord(2)];
    const plugin = await loadFixture(withPending(records));
    let input;
    let calls = 0;
    spawnFixture = (_file, args) => {
      calls++;
      const inputPath = args[args.indexOf("-InputPath") + 1];
      const outputPath = args[args.indexOf("-OutputPath") + 1];
      input = JSON.parse(fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, ""));
      fs.writeFileSync(outputPath, JSON.stringify({ items: [], errors: [{ title: records[0].sourceTitle, message: "fixture does not extract" }] }), "utf8");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    };
    try { await plugin.sync(true); }
    finally { spawnFixture = undefined; }
    assert.equal(calls, 1);
    assert.equal(input.operation, "sync");
    assert.deepEqual(input.resumeRecords, records);
    assert.equal(input.skipSourceIds.length, 67);
    assert.deepEqual(plugin.getPendingSourceResume().records, records);
    assert.equal(plugin.created.length, 0);
    plugin.onunload();
  });

  await scenario("confirmed rebinding atomically carries the pending queue to both new names and reload preserves it", async () => {
    const records = [pendingRecord(1), pendingRecord(2)];
    const plugin = await loadFixture(withPending(records, 1));
    const initial = settingsSnapshot(plugin);
    plugin.runPowerShell = async () => successOutput(newFolder, renamedKnowledgeBase);
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    assert.equal(settingsSnapshot(plugin), initial);
    await plugin.confirmSourceBinding(session);
    const pending = plugin.getPendingSourceResume();
    assert.equal(pending.knowledgeBaseName, renamedKnowledgeBase);
    assert.equal(pending.folderName, newFolder);
    assert.equal(pending.sourceScope, sourceScope);
    assert.equal(pending.localDestination, localDestination);
    assert.equal(pending.unresumableCount, 1);
    assert.deepEqual(pending.records, records);
    assert.deepEqual(plugin.savedData.pendingSourceResume, pending);
    const reloaded = await loadFixture(plugin.savedData);
    assert.deepEqual(reloaded.getPendingSourceResume(), pending);
    reloaded.onunload();
    plugin.onunload();
  });

  await scenario("failed rebind persistence restores the pending queue together with both names and binding", async () => {
    const plugin = await loadFixture(withPending([pendingRecord(1)], 1));
    await plugin.saveSettings();
    const initial = settingsSnapshot(plugin);
    const persisted = clone(plugin.savedData);
    plugin.runPowerShell = async () => successOutput(newFolder, renamedKnowledgeBase);
    const session = plugin.beginSourceRebind();
    plugin.setSourceRebindKnowledgeBase(session, renamedKnowledgeBase);
    plugin.setSourceRebindCandidate(session, newFolder);
    await plugin.inspectSourceFolder(session);
    plugin.saveData = async () => { throw new Error("pending queue disk failure"); };
    await assert.rejects(plugin.confirmSourceBinding(session), /pending queue disk failure/);
    assert.equal(settingsSnapshot(plugin), initial);
    assert.deepEqual(plugin.savedData, persisted);
    plugin.cancelSourceRebind(session);
    plugin.onunload();
  });

  for (const [field, value] of [
    ["sourceScope", "a".repeat(64)], ["localDestination", "Other/Destination"],
    ["knowledgeBaseName", "An unrelated knowledge base"], ["folderName", "An unrelated folder"],
  ]) {
    await scenario(`resume rejects a mismatched ${field} without scanning or losing the queue`, async () => {
      const stored = withPending([pendingRecord(1)]);
      stored.pendingSourceResume[field] = value;
      const plugin = await loadFixture(stored);
      const before = clone(plugin.settings.pendingSourceResume);
      let calls = 0;
      plugin.runPowerShell = async () => { calls++; throw new Error("mismatched resume must not reach extraction"); };
      await plugin.sync(true);
      assert.equal(calls, 0);
      assert.deepEqual(plugin.settings.pendingSourceResume, before);
      assert.equal(plugin.syncReports[0].status, "failed");
      assert.equal(plugin.created.length, 0);
      plugin.onunload();
    });
  }

  await scenario("a queue without recoverable IDs never falls through to an empty-array full scan", async () => {
    const plugin = await loadFixture(withPending([], 2));
    const before = clone(plugin.getPendingSourceResume());
    let calls = 0;
    plugin.runPowerShell = async () => { calls++; throw new Error("empty resume queue must not cause a new scan"); };
    await plugin.sync(true);
    assert.equal(calls, 0);
    assert.deepEqual(plugin.getPendingSourceResume(), before);
    plugin.onunload();

    const known = pendingRecord(1, { sourceId: fixtureEntries[0].sourceId, kind: "pdf" });
    for (const unresumableCount of [0, 2]) {
      const stored = withPending([known], unresumableCount);
      stored.overwriteSameName = true;
      const alreadyCompleted = await loadFixture(stored);
      alreadyCompleted.runPowerShell = async () => { calls++; throw new Error("fully completed queue must not invoke extraction"); };
      await alreadyCompleted.sync(true);
      assert.equal(calls, 0, "resume never reopens a completed identity, including overwrite mode");
      if (unresumableCount) {
        assert.deepEqual(alreadyCompleted.getPendingSourceResume().records, []);
        assert.equal(alreadyCompleted.getPendingSourceResume().unresumableCount, unresumableCount);
      } else assert.equal(alreadyCompleted.getPendingSourceResume(), undefined);
      alreadyCompleted.onunload();
    }
  });

  await scenario("discard removes only the pending queue and refuses busy or failed persistence", async () => {
    const plugin = await loadFixture(withPending([pendingRecord(1)], 2));
    await plugin.saveSettings();
    const before = JSON.parse(settingsSnapshot(plugin));
    const persisted = clone(plugin.savedData);
    const persist = plugin.saveData.bind(plugin);
    plugin.running = true;
    await assert.rejects(plugin.discardPendingSourceResume(), /./);
    plugin.running = false;
    assert.deepEqual(JSON.parse(settingsSnapshot(plugin)), before);
    plugin.saveData = async () => { throw new Error("discard disk failure"); };
    await assert.rejects(plugin.discardPendingSourceResume(), /discard disk failure/);
    assert.deepEqual(JSON.parse(settingsSnapshot(plugin)), before);
    assert.deepEqual(plugin.savedData, persisted);
    plugin.saveData = persist;
    const expected = clone(plugin.settings);
    delete expected.pendingSourceResume;
    await plugin.discardPendingSourceResume();
    assert.equal(plugin.getPendingSourceResume(), undefined);
    assert.deepEqual(plugin.settings, expected);
    assert.deepEqual(plugin.syncedAttachments, fixtureEntries.slice(0, 67));
    assert.equal(plugin.created.length, 0);
    assert.equal(plugin.modified.length, 0);
    plugin.onunload();
  });

  await require("./source-selection-scenarios.cjs")({ assert, scenario, loadFixture, storedFixture, withPending, pendingRecord,
    knowledgeBaseName, renamedKnowledgeBase, oldFolder, newFolder, localDestination, sourceScope, fixtureEntries,
    emptyIndex, settingsSnapshot, clone, inspection, successOutput, modals, modalControl, modalButton,
    deferred, waitFor, createHash, descendants });
  await require("./scope-draft-scenarios.cjs")({assert,scenario,loadFixture,storedFixture,withPending,pendingRecord,clone,localDestination,sourceScope,fixtureEntries,emptyIndex});
  await require("./startup-readiness-scenarios.cjs")({assert,scenario,loadFixture,storedFixture,clone,deferred,flush,EventEmitter,
    setSpawnFixture: fixture => { spawnFixture = fixture; }});
  assert.equal(externalSpawnCount, 0, "the suite must never invoke a real desktop process");
  console.log(`PASS: ${scenarioCount} source-binding scenarios against ${path.basename(pluginPath)}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
