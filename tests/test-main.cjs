"use strict";

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const Module = require("node:module");
const nodePath = require("node:path");

let layoutReadyCallback;
let execCount = 0;
let extractedBody = "正文".repeat(600) + "\n一句话结论：结论\n• 一级\n◦ 二级";
let registeredView;
let ribbonCallback;
let ribbonTitle;
let ribbonIcon;
const registeredIcons = new Map();
let viewState;
let revealedLeaf;
let detachedViewType;
let settingsOpened = false;
let settingsTabId;
let lastMenu;
let lastRequestedMaxItems;
let lastSkippedTitles;
let lastSpawnArgs;
let lastInputPayload;
let nextSpawnBehavior;
let nextCardBehavior = "start";
const cardChildren = [];
let transientRenameFailures = 0;
let renameRetryCount = 0;
const notices = [];
const noticeInstances = [];
const openedModals = [];
const settingControls = new Map();
const commands = [];
const settingTabs = [];
const settingNames = [];
const settingDescriptions = [];
const contents = new Map();
const files = new Map();
const createdPaths = [];
const createFailures = new Set();
const vaultEventCallbacks = new Map();
const metadataCaches = new Map();
const readPaths = [];

global.window = global;

class TFile {
  constructor(path) {
    this.path = path;
    const name = path.split("/").pop();
    this.name = name;
    this.extension = name.includes(".") ? name.split(".").pop() : "";
    this.basename = name.replace(/\.[^.]+$/, "");
    const fullDate = this.basename.match(/(\d{4})-(\d{2})-(\d{2})/);
    const shortDate = this.basename.match(/(\d{2})(\d{2})$/);
    const ctime = fullDate
      ? Date.parse(`${fullDate[1]}-${fullDate[2]}-${fullDate[3]}T12:00:00Z`)
      : shortDate
        ? Date.parse(`2026-${shortDate[1]}-${shortDate[2]}T12:00:00Z`)
        : Date.now();
    this.stat = { ctime, mtime: ctime, size: 0 };
  }
}

class TFolder {
  constructor(path, children = []) {
    this.path = path;
    this.name = path.split("/").pop();
    this.children = children;
  }
}

class FileSystemAdapter {
  getBasePath() {
    return "D:\\Vault";
  }
}

const legacyFile = new TFile("Target/速看-0810.md");
const datedFile = new TFile("Target/速看-2026-08-09.md");
const targetFolder = new TFolder("Target", [legacyFile, datedFile]);
files.set("Target", targetFolder);
files.set(legacyFile.path, legacyFile);
files.set(datedFile.path, datedFile);

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.text = options.text || "";
    this.cls = options.cls || "";
    Object.assign(this, options.attr || {});
    this.children = [];
    this.disabled = false;
    this.listeners = new Map();
  }
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  createDiv(options = {}) {
    const child = new Element("div", options);
    this.children.push(child);
    return child;
  }
  createSpan(options = {}) {
    const child = new Element("span", options);
    this.children.push(child);
    return child;
  }
  createEl(tag, options = {}) {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  click() {
    for (const listener of this.listeners.get("click") || []) listener({});
  }
  setAttr(name, value) { this[name] = value; }
  toggleClass(name, enabled) {
    const classes = new Set(this.cls.split(" ").filter(Boolean));
    if (enabled) classes.add(name); else classes.delete(name);
    this.cls = [...classes].join(" ");
  }
}

class MenuItem {
  setTitle(title) { this.title = title; return this; }
  setIcon(icon) { this.icon = icon; return this; }
  setChecked(checked) { this.checked = checked; return this; }
  onClick(callback) { this.callback = callback; return this; }
  invoke() { return this.callback(); }
}

class Menu {
  constructor() { this.items = []; }
  addItem(configure) {
    const item = new MenuItem();
    configure(item);
    this.items.push(item);
    return this;
  }
  showAtMouseEvent() { lastMenu = this; }
}

class Plugin {
  constructor() {
    this.manifest = { id: "ima-speed-sync", dir: ".obsidian/plugins/ima-speed-sync" };
    this.app = {
      vault: {
        adapter: new FileSystemAdapter(),
        configDir: ".obsidian",
        getAbstractFileByPath: (path) => files.get(path) || null,
        on(name, callback) {
          vaultEventCallbacks.set(name, callback);
          return {};
        },
        async createFolder(path) {
          files.set(path, new TFolder(path));
        },
        async create(path, content) {
          if (createFailures.has(path)) throw new Error(`模拟写入失败：${path}`);
          const file = new TFile(path);
          files.set(path, file);
          contents.set(path, content);
          createdPaths.push(path);
          const parentPath = path.split("/").slice(0, -1).join("/");
          const parent = files.get(parentPath);
          if (parent instanceof TFolder) parent.children.push(file);
          return file;
        },
        async read(file) {
          readPaths.push(file.path);
          return contents.get(file.path) || "";
        },
        async process(file, callback) {
          contents.set(file.path, callback(contents.get(file.path) || ""));
        },
      },
      metadataCache: {
        getFileCache(file) { return metadataCaches.get(file.path) || null; },
      },
      workspace: {
        onLayoutReady: (callback) => { layoutReadyCallback = callback; },
        getLeavesOfType: () => [],
        detachLeavesOfType(type) { detachedViewType = type; },
        getRightLeaf: () => rightLeaf,
        async revealLeaf(leaf) { revealedLeaf = leaf; },
        getLeaf: () => ({ async openFile() {} }),
      },
      setting: {
        open() { settingsOpened = true; },
        openTabById(id) { settingsTabId = id; },
      },
    };
  }
  loadData() {
    return Promise.resolve({
      autoSync: false,
      hasConsented: true,
      knowledgeBaseName: "测试知识库",
      folderName: "测试文件夹",
      destinationPath: "Target",
      maxItems: 4,
    });
  }
  saveData(data) { this.savedData = JSON.parse(JSON.stringify(data)); return Promise.resolve(); }
  addCommand(command) { commands.push(command); }
  addSettingTab(tab) { settingTabs.push(tab); }
  addRibbonIcon(icon, title, callback) { assert.ok(registeredIcons.has(icon), "custom icon must be registered first"); ribbonIcon = icon; ribbonTitle = title; ribbonCallback = callback; this.ribbon = new Element(); return this.ribbon; }
  registerView(type, creator) { registeredView = { type, creator }; }
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = new Element();
  }
  registerEvent() {}
}

class Modal {
  constructor(app) {
    this.app = app;
    this.titleEl = new Element();
    this.contentEl = new Element();
  }
  open() { openedModals.push(this); this.onOpen(); }
  close() { this.onClose(); }
}

class PluginSettingTab {
  constructor(app) {
    this.app = app;
    this.containerEl = new Element();
  }
}

function chainComponent() {
  return {
    addOption() { return this; },
    setValue(value) { this.value = value; return this; },
    setDisabled(value) { this.disabled = value; return this; },
    setPlaceholder() { return this; },
    setLimits() { return this; },
    setDynamicTooltip() { return this; },
    setButtonText() { return this; },
    setCta() { return this; },
    onChange(callback) { this.change = callback; return this; },
    onClick() { return this; },
  };
}

class Setting {
  setName(name) { this.name = name; settingNames.push(name); return this; }
  setHeading() { return this; }
  setDesc(description) { settingDescriptions.push(description); return this; }
  addToggle(callback) { const control = chainComponent(); callback(control); settingControls.set(this.name, control); return this; }
  addText(callback) { callback(chainComponent()); return this; }
  addSlider(callback) { callback(chainComponent()); return this; }
  addButton(callback) { callback(chainComponent()); return this; }
  addDropdown(callback) { callback(chainComponent()); return this; }
}

class Notice {
  constructor(message) { notices.push(message); this.noticeEl = new Element(); this.messageEl = this.noticeEl; noticeInstances.push(this); }
  hide() { this.hidden = true; }
}

const rightLeaf = {
  view: {},
  async setViewState(state) { viewState = state; },
};

function findElements(root, predicate) {
  const matches = predicate(root) ? [root] : [];
  for (const child of root.children) matches.push(...findElements(child, predicate));
  return matches;
}

async function waitForFixture(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture timed out waiting for expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "fs/promises") return {
    ...fsPromises,
    async rename(from, to) {
      if (String(from).endsWith("state.pending") && transientRenameFailures > 0) {
        transientRenameFailures--;
        renameRetryCount++;
        throw Object.assign(new Error("模拟 Windows 暂时占用状态文件"), { code: "EPERM" });
      }
      return fsPromises.rename(from, to);
    },
  };
  if (request === "obsidian") {
    return {
      FileSystemAdapter,
      ItemView,
      Menu,
      Modal,
      Notice,
      Platform: { isWin: true },
      Plugin,
      PluginSettingTab,
      Setting,
      TFile,
      TFolder,
      WorkspaceLeaf: class {},
      normalizePath,
      addIcon(id, svg) { registeredIcons.set(id, svg); },
      setIcon(element, icon) { element.icon = icon; },
    };
  }
  if (request === "child_process") {
    return {
      spawn(file, args) {
        if (args.includes("-StatePath")) {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.statePath = args[args.indexOf("-StatePath") + 1];
          child.initialState = JSON.parse(fs.readFileSync(child.statePath, "utf8"));
          child.killed = false;
          child.kill = function () { if (this.killed) return; this.killed = true; queueMicrotask(() => this.emit("close", 0)); };
          child.command = (value) => child.stdout.emit("data", value + "\n");
          cardChildren.push(child);
          const behavior = nextCardBehavior;
          nextCardBehavior = "start";
          queueMicrotask(() => {
            if (behavior === "error") { child.emit("error", new Error("mock card unavailable")); return; }
            child.command("ready");
            if (behavior !== "wait") child.command(behavior);
          });
          return child;
        }
        execCount++;
        lastSpawnArgs = [...args];
        const inputPath = args[args.indexOf("-InputPath") + 1];
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        lastInputPayload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
        const behavior = nextSpawnBehavior || {};
        nextSpawnBehavior = undefined;
        if (!behavior.omitOutput) {
          const output = behavior.outputText ?? JSON.stringify({
            busy: false,
            items: [{ sourceTitle: "速看-0810", updatedDate: "2026-08-10", body: extractedBody }],
            errors: [],
          });
          fs.writeFileSync(outputPath, output, "utf8");
        }
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout = new EventEmitter();
        child.killed = false;
        child.kill = function () {
          this.killed = true;
          queueMicrotask(() => this.emit("close", null, "SIGTERM"));
        };
        queueMicrotask(() => {
          for (const chunk of behavior.progressChunks || []) child.stdout.emit("data", chunk);
          if (behavior.stderr) child.stderr.emit("data", behavior.stderr);
          child.emit("close", behavior.exitCode ?? 0, behavior.signal ?? null);
        });
        return child;
      },
    };
  }
  if (request === "path") return nodePath;
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const sourceManifest = JSON.parse(fs.readFileSync(nodePath.join(__dirname, "../manifest.json"), "utf8"));
  const builtManifest = JSON.parse(fs.readFileSync(nodePath.join(__dirname, "../dist/manifest.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(nodePath.join(__dirname, "../package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(nodePath.join(__dirname, "../package-lock.json"), "utf8"));
  assert.strictEqual(sourceManifest.name, "IMA Share Sync");
  assert.strictEqual(sourceManifest.id, "ima-speed-sync", "renaming must preserve the installed plugin identity");
  assert.deepStrictEqual(builtManifest, sourceManifest, "release metadata must carry the new display name");
  assert.strictEqual(packageJson.name, "ima-share-sync");
  assert.strictEqual(packageLock.name, packageJson.name);
  assert.strictEqual(packageLock.packages[""].name, packageJson.name);

  const builtSource = fs.readFileSync(nodePath.join(__dirname, "../dist/main.js"), "utf8");
  assert.ok(!builtSource.includes("IMA 分享同步"), "the release must not retain the old display name");
  assert.ok(!builtSource.includes('import("node:crypto")'), "Node built-ins must not use browser dynamic imports");
  assert.ok(!builtSource.includes('require("node:crypto")'), "Obsidian-compatible builds must not use the node: scheme");
  assert.ok(builtSource.includes('require("crypto")'), "Node built-ins must load through compatible CommonJS module names");

  const loaded = require("../dist/main.js");
  const ImaSpeedSyncPlugin = loaded.default || loaded;
  const plugin = new ImaSpeedSyncPlugin();
  const nativeOpenOperationCard = ImaSpeedSyncPlugin.prototype.openOperationCard;
  // Legacy sync fixtures test extraction/notifications separately from native desktop UI.
  ImaSpeedSyncPlugin.prototype.openOperationCard = async () => null;
  assert.strictEqual(plugin.settings.destinationPath, "IMA Share Sync", "new installs should use the new default folder name");
  await plugin.onload();
  assert.strictEqual(plugin.settings.contentMode, "speed-reader", "existing installs must retain the old title scope");
  assert.strictEqual(plugin.settings.allowForeground, false, "foreground fallback must be opt-in");
  assert.strictEqual(plugin.settings.destinationPath, "Target", "renaming must not replace an existing saved destination");
  assert.strictEqual(ribbonTitle, "打开 IMA Share Sync");
  assert.strictEqual(ribbonIcon, "ima-share-sync-panda-book");
  assert.strictEqual(registeredView.creator(rightLeaf).getIcon(), ribbonIcon, "ribbon and view tab must share the selected logo");
  const logo = registeredIcons.get(ribbonIcon);
  assert.ok(logo.includes('scale(0.390625)'), "256-grid artwork must fit Obsidian 100-grid icons");
  assert.strictEqual((logo.match(/<ellipse /g) || []).length, 5, "preserve panda facial geometry");
  assert.ok(logo.includes('d="M128 188V241"'), "simplified book retains its center spine");
  assert.strictEqual((logo.match(/<path /g) || []).length, 3, "only head outline, book outline and spine remain");
  assert.ok(!logo.includes('M43 181'), "small toolbar logo omits page text lines");
  assert.strictEqual(registeredView.type, "ima-speed-sync-view", "existing workspace views must remain compatible");

  const runtimePath = await plugin.writeRuntimeScript();
  const runtimeBytes = fs.readFileSync(runtimePath);
  assert.deepStrictEqual([...runtimeBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const embeddedScript = runtimeBytes.toString("utf8");
  assert.ok(embeddedScript.includes("function Invoke-ImaSync"));
  assert.ok(embeddedScript.includes("SkipTitlesBase64"));
  assert.ok(embeddedScript.includes("InputPath"));
  assert.ok(embeddedScript.includes("OutputPath"));
  assert.ok(embeddedScript.includes("function Get-ImaHorizontalRuleAnchors"));
  assert.ok(!embeddedScript.includes("https://ima.qq.com"));
  const escapedRuntimePath = runtimePath.replace(/'/g, "''");
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${escapedRuntimePath}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object Message;exit 1}`,
  ], { encoding: "utf8", windowsHide: true });
  fs.unlinkSync(runtimePath);

  await plugin.sync(true);
  assert.ok(lastSpawnArgs.includes("-InputPath"), "skip titles must be passed through an input JSON file");
  assert.ok(lastSpawnArgs.includes("-OutputPath"), "extraction results must be returned through an output JSON file");
  assert.strictEqual(lastSpawnArgs.includes("-SkipTitlesBase64"), false, "titles must not inflate argv");
  assert.ok(lastInputPayload.skipTitles.includes("速看-0810"));
  execCount = 0;
  const nativeRunPowerShell = plugin.runPowerShell;

  let syncItems = [{ sourceTitle: "速看-0810", updatedDate: "2026-08-10" }];
  plugin.runPowerShell = async (maxItems, skipTitles) => {
    lastRequestedMaxItems = maxItems;
    lastSkippedTitles = skipTitles;
    execCount++;
    return JSON.stringify({
      busy: false,
      items: syncItems.map(({ sourceTitle, updatedDate }) => ({
        sourceTitle,
        updatedDate,
        body: extractedBody,
      })),
      errors: [],
    });
  };

  assert.strictEqual(typeof ribbonCallback, "function");
  assert.ok(registeredView);
  assert.strictEqual(plugin.settings.autoSync, false);
  assert.strictEqual(plugin.settings.hasConsented, true);
  assert.strictEqual(plugin.settings.overwriteSameName, false);
  assert.deepStrictEqual(commands.map((command) => command.id), ["sync-now", "cancel-sync"]);
  layoutReadyCallback();
  assert.strictEqual(execCount, 0, "startup sync must remain disabled by default");

  let releaseConsent;
  plugin.settings.hasConsented = false;
  plugin.ensureConsent = () => new Promise((resolve) => { releaseConsent = resolve; });
  const firstConcurrentSync = plugin.sync(true);
  const secondConcurrentSync = plugin.sync(true);
  assert.strictEqual(plugin.isRunning, true, "the sync gate must close before consent awaits");
  assert.strictEqual(execCount, 0);
  releaseConsent(true);
  await Promise.all([firstConcurrentSync, secondConcurrentSync]);
  assert.strictEqual(execCount, 1, "two immediate sync calls must start only one extractor");
  plugin.ensureConsent = async () => true;
  plugin.settings.hasConsented = true;
  execCount = 0;

  legacyFile.stat.ctime = Date.parse("2026-08-01T12:00:00Z");
  datedFile.stat.ctime = Date.parse("2026-08-31T12:00:00Z");
  assert.deepStrictEqual(
    plugin.getSortedArticles().map((file) => file.basename),
    ["速看-0810", "速看-2026-08-09"],
    "title dates must take precedence over conflicting file creation times",
  );
  const duplicateTitleFile = new TFile("Target/速看-0823 (2).md");
  const genericDateFile = new TFile("Target/会议纪要.md");
  metadataCaches.set(genericDateFile.path, { frontmatter: { ima_sync_plugin: 'ima-speed-sync', ima_updated: '2026-09-01' } });
  assert.strictEqual(plugin.getArticleSourceTimestamp(genericDateFile), Date.parse('2026-09-01T00:00:00Z'), 'undated title uses a verified source date');
  metadataCaches.set(genericDateFile.path, { frontmatter: { ima_sync_plugin: 'ima-speed-sync', ima_updated: '2026-02-31' } });
  assert.strictEqual(plugin.getArticleSourceTimestamp(genericDateFile), genericDateFile.stat.ctime, 'invalid source date falls back to file creation');
  metadataCaches.delete(genericDateFile.path);
  assert.strictEqual(
    plugin.getArticleTitleTimestamp(duplicateTitleFile),
    Date.parse("2026-08-23T00:00:00Z"),
    "numbered duplicate titles must retain their date sort key",
  );
  assert.strictEqual(
    plugin.getArticleTitleTimestamp(new TFile("Target/速看-0231.md")),
    null,
    "invalid title dates must fall back to creation-time sorting",
  );
  const oldShortDateFile = new TFile("Target/速看-0101.md");
  oldShortDateFile.stat.ctime = Date.parse("2026-09-04T12:00:00+08:00");
  assert.strictEqual(
    plugin.getArticleTitleTimestamp(oldShortDateFile),
    Date.parse("2026-01-01T00:00:00Z"),
    "a past MMDD title must not be inferred into the next year",
  );
  const nextCalendarDateFile = new TFile("Target/速看-1231.md");
  nextCalendarDateFile.stat.ctime = Date.parse("2026-02-01T12:00:00+08:00");
  assert.strictEqual(
    plugin.getArticleTitleTimestamp(nextCalendarDateFile),
    Date.parse("2025-12-31T00:00:00Z"),
    "an MMDD later than its creation calendar date must use the previous year",
  );

  for (let day = 1; day <= 23; day++) {
    const file = new TFile(`Target/速看-2026-07-${String(day).padStart(2, "0")}.md`);
    targetFolder.children.push(file);
    files.set(file.path, file);
  }
  const view = registeredView.creator({});
  assert.strictEqual(view.getDisplayText(), sourceManifest.name, "the sidebar tab must match the manifest display name");
  const renderView = view.render.bind(view);
  let scheduledRenderCount = 0;
  view.render = () => {
    scheduledRenderCount++;
    renderView();
  };
  await view.onOpen();
  assert.deepStrictEqual(
    findElements(view.contentEl, (element) => element.tag === "h3").map((element) => element.text),
    [sourceManifest.name],
    "the rendered sidebar heading must use the new display name",
  );
  scheduledRenderCount = 0;
  vaultEventCallbacks.get("modify")(new TFile("Other/无关.md"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(scheduledRenderCount, 0, "unrelated vault events must not redraw the sync view");
  vaultEventCallbacks.get("modify")(legacyFile);
  vaultEventCallbacks.get("modify")(datedFile);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(scheduledRenderCount, 1, "bursts of destination changes must be debounced");
  let articleLists = findElements(view.contentEl, (element) => element.cls === "ima-speed-sync-list");
  assert.strictEqual(articleLists.length, 1);
  assert.strictEqual(articleLists[0].children.length, 20, "the first page must contain 20 articles");
  let pageStatuses = findElements(view.contentEl, (element) => element.cls === "ima-speed-sync-page-status");
  assert.strictEqual(pageStatuses[0].text, "第 1 / 2 页 · 共 25 篇");
  const settingsButton = findElements(
    view.contentEl,
    (element) => element.tag === "button" && element.text === "设置",
  )[0];
  assert.ok(settingsButton);
  settingsButton.click();
  assert.strictEqual(settingsOpened, true);
  assert.strictEqual(settingsTabId, "ima-speed-sync");
  const syncButton = findElements(
    view.contentEl,
    (element) => element.tag === "button" && element.text === "立即同步",
  )[0];
  assert.ok(syncButton);
  assert.strictEqual(
    findElements(
      view.contentEl,
      (element) => element.tag === "button" && element.text === "重新同步全部文章",
    ).length,
    0,
  );
  plugin.running = true;
  plugin.activeRun = {
    id: 999,
    cancellationPath: null,
    cancellationRequested: false,
    process: null,
  };
  view.render();
  const cancelButton = findElements(
    view.contentEl,
    (element) => element.tag === "button" && element.text === "取消同步",
  )[0];
  assert.ok(cancelButton);
  cancelButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(plugin.cancellationRequested, true);
  plugin.running = false;
  plugin.activeRun = null;
  plugin.cancellationRequested = false;
  view.render();
  const modeButton = findElements(
    view.contentEl,
    (element) => element.cls === "ima-speed-sync-mode-button",
  )[0];
  assert.ok(modeButton);
  modeButton.click();
  assert.deepStrictEqual(lastMenu.items.map((item) => item.title), [
    "同名不覆盖",
    "同名覆盖",
  ]);
  assert.deepStrictEqual(lastMenu.items.map((item) => item.checked), [true, false]);
  await lastMenu.items[1].invoke();
  assert.strictEqual(plugin.settings.overwriteSameName, true);
  modeButton.click();
  assert.deepStrictEqual(lastMenu.items.map((item) => item.checked), [false, true]);
  await lastMenu.items[0].invoke();
  assert.strictEqual(plugin.settings.overwriteSameName, false);
  const nextButton = findElements(
    view.contentEl,
    (element) => element.tag === "button" && element.text === "下一页",
  )[0];
  assert.ok(nextButton);
  nextButton.click();
  articleLists = findElements(view.contentEl, (element) => element.cls === "ima-speed-sync-list");
  assert.strictEqual(articleLists[0].children.length, 5, "the second page must contain the remainder");
  pageStatuses = findElements(view.contentEl, (element) => element.cls === "ima-speed-sync-page-status");
  assert.strictEqual(pageStatuses[0].text, "第 2 / 2 页 · 共 25 篇");

  const cachedMetadataFile = new TFile("Target/缓存元数据文章.md");
  targetFolder.children.push(cachedMetadataFile);
  files.set(cachedMetadataFile.path, cachedMetadataFile);
  metadataCaches.set(cachedMetadataFile.path, {
    frontmatter: {
      ima_sync_plugin: "ima-speed-sync",
      ima_source_key: "sha256:cached",
      ima_source_title: "缓存元数据文章",
    },
  });
  readPaths.length = 0;
  const cachedIndex = await plugin.buildArticleIndex("Target");
  assert.strictEqual(
    readPaths.includes(cachedMetadataFile.path),
    false,
    "cached frontmatter must avoid reading the complete Markdown body",
  );
  assert.strictEqual(cachedIndex.bySourceKey.get("sha256:cached"), cachedMetadataFile);

  await ribbonCallback();
  assert.strictEqual(detachedViewType, registeredView.type);
  assert.strictEqual(revealedLeaf, rightLeaf);
  assert.strictEqual(viewState.type, registeredView.type);

  settingTabs[0].display();
  const settingsContainer = settingTabs[0].containerEl;
  const supportCards = findElements(settingsContainer, (el) => el.cls === "ima-share-sync-support");
  assert.strictEqual(supportCards.length, 1, "settings should contain one GitHub support card");
  assert.strictEqual(settingsContainer.children[0], supportCards[0], "support card should appear at the top");
  const starLinks = findElements(supportCards[0], (el) => el.tag === "a");
  assert.strictEqual(starLinks.length, 1);
  assert.strictEqual(starLinks[0].text, "去 GitHub 点星");
  assert.strictEqual(starLinks[0].href, "https://github.com/oooing/ima-share-sync");
  assert.strictEqual(starLinks[0].target, "_blank");
  assert.strictEqual(starLinks[0].rel, "noopener noreferrer");
  assert.ok(starLinks[0]["aria-label"].includes("手动点星"));
  assert.strictEqual(starLinks[0].listeners.size, 0, "use native link navigation, not an automatic Star API");
  assert.strictEqual(findElements(supportCards[0], (el) => el.icon === "star")[0]["aria-hidden"], "true");
  assert.strictEqual(execCount, 0, "opening settings must not start sync or an external process");
  assert.deepStrictEqual(settingNames, [
    "Obsidian 启动时同步",
    "内容模式",
    "允许短时前台操作",
    "知识库名称",
    "IMA 文件夹名称",
    "保存文件夹",
    "覆盖同名文件",
    "检查最近文章数",
    "外部应用访问授权",
    "同步提醒",
    "启用同步提醒",
    "自动同步成功提醒",
    "自动同步失败提醒",
    "手动同步结果提醒",
    "图标异常标记",
    "操作前提示",
    "操作结束提示",
  ]);
  assert.ok(
    settingDescriptions.includes("每次从 IMA 文件夹顶部检查的文章数量，可设置为 1–30 篇。"),
    "the recent-count setting must describe top-of-folder candidate semantics",
  );
  settingTabs[0].display();
  assert.strictEqual(
    findElements(settingsContainer, (el) => el.cls === "ima-share-sync-support").length,
    1,
    "redisplaying settings must not duplicate the support card",
  );

  syncItems = [
    { sourceTitle: "速看-0810", updatedDate: "2026-08-10" },
    { sourceTitle: "速看-0808", updatedDate: "2026-08-08" },
    { sourceTitle: "速看-0807", updatedDate: "2026-08-07" },
  ];
  plugin.settings.overwriteSameName = true;
  const createdBeforeSync = createdPaths.length;
  await plugin.sync(true);
  assert.strictEqual(execCount, 1);
  assert.strictEqual(lastRequestedMaxItems, 4);
  assert.deepStrictEqual(
    createdPaths.slice(createdBeforeSync),
    [
      "Target/速看-0807.md",
      "Target/速看-0808.md",
    ],
    "new files must keep their source titles while an existing same-name file is overwritten",
  );

  const outputPath = "Target/速看-0810.md";
  assert.ok(files.get(outputPath) instanceof TFile);
  const firstOutput = contents.get(outputPath);
  assert.ok(firstOutput.startsWith("---\nima_source_key: \"sha256:"));
  assert.ok(firstOutput.includes("ima_source_title: \"速看-0810\"\nima_updated: 2026-08-10"));
  assert.ok(firstOutput.includes("# 速看-0810"));
  assert.ok(firstOutput.includes("**一句话结论：** 结论"));
  assert.ok(firstOutput.includes("- 一级\n  - 二级"));

  await plugin.sync(true);
  assert.strictEqual(contents.get(outputPath), firstOutput, "unchanged content must not be rewritten");

  extractedBody += "\n更新内容";
  await plugin.sync(true);
  assert.ok(contents.get(outputPath).endsWith("更新内容\n"), "changed content must update the existing file");

  plugin.settings.overwriteSameName = false;
  const beforeSkippedSync = contents.get(outputPath);
  extractedBody += "\n不应写入的内容";
  await plugin.sync(true);
  assert.ok(lastSkippedTitles.includes("速看-0810"), "no-overwrite mode must pass existing titles to PowerShell");
  assert.strictEqual(contents.get(outputPath), beforeSkippedSync, "no-overwrite mode must preserve existing content");

  const occupiedGenericPath = "Target/市场／复盘.md";
  const occupiedGenericFile = new TFile(occupiedGenericPath);
  targetFolder.children.push(occupiedGenericFile);
  files.set(occupiedGenericPath, occupiedGenericFile);
  contents.set(occupiedGenericPath, "用户原文件");
  syncItems = [{ sourceTitle: "市场/复盘", updatedDate: "2026-08-11" }];
  const createdBeforeCollision = createdPaths.length;
  await plugin.sync(true);
  assert.strictEqual(contents.get(occupiedGenericPath), "用户原文件", "disabled overwrite must preserve the original file");
  assert.deepStrictEqual(createdPaths.slice(createdBeforeCollision), []);
  assert.strictEqual(files.has("Target/市场／复盘 (1).md"), false, "disabled overwrite must not create a numbered copy");
  await plugin.sync(true);
  assert.deepStrictEqual(
    createdPaths.slice(createdBeforeCollision),
    [],
    "repeated collisions must continue to be skipped",
  );

  const snapshotFolder = new TFolder("SnapshotTarget", []);
  files.set(snapshotFolder.path, snapshotFolder);
  plugin.settings.knowledgeBaseName = "快照知识库";
  plugin.settings.folderName = "快照文件夹";
  plugin.settings.destinationPath = "SnapshotTarget";
  plugin.settings.overwriteSameName = true;
  plugin.settings.maxItems = 3;
  const immediateRunPowerShell = plugin.runPowerShell;
  let extractionStartedResolve;
  const extractionStarted = new Promise((resolve) => { extractionStartedResolve = resolve; });
  let finishExtraction;
  let capturedSettings;
  plugin.runPowerShell = (maxItems, skipTitles, settings) => {
    capturedSettings = settings;
    extractionStartedResolve();
    return new Promise((resolve) => { finishExtraction = resolve; });
  };
  const snapshotSync = plugin.sync(true);
  await extractionStarted;
  plugin.settings.knowledgeBaseName = "同步中被修改的知识库";
  plugin.settings.folderName = "同步中被修改的文件夹";
  plugin.settings.destinationPath = "ChangedTarget";
  plugin.settings.overwriteSameName = false;
  finishExtraction(JSON.stringify({
    items: [{ sourceTitle: "快照文章", updatedDate: "2026-08-12", body: extractedBody }],
    errors: [],
  }));
  await snapshotSync;
  assert.strictEqual(Object.isFrozen(capturedSettings), true, "a run must use an immutable settings snapshot");
  assert.strictEqual(capturedSettings.destinationPath, "SnapshotTarget");
  assert.strictEqual(capturedSettings.overwriteSameName, true);
  const snapshotOutputPath = "SnapshotTarget/快照文章.md";
  assert.ok(files.has(snapshotOutputPath), "mid-run setting changes must not redirect the output");
  assert.strictEqual(files.has("ChangedTarget/快照文章.md"), false);
  const expectedSnapshotKey = `sha256:${createHash("sha256")
    .update(JSON.stringify(["快照知识库", "快照文件夹", "快照文章"]), "utf8")
    .digest("hex")}`;
  assert.ok(
    contents.get(snapshotOutputPath).includes(`ima_source_key: "${expectedSnapshotKey}"`),
    "source keys must be derived from the run snapshot",
  );

  plugin.runPowerShell = immediateRunPowerShell;
  plugin.settings.knowledgeBaseName = "测试知识库";
  plugin.settings.folderName = "测试文件夹";
  plugin.settings.destinationPath = "Target";
  plugin.settings.overwriteSameName = true;
  plugin.settings.maxItems = 4;
  syncItems = [
    { sourceTitle: "模拟失败文章", updatedDate: "2026-08-12" },
    { sourceTitle: "失败后仍保存", updatedDate: "2026-08-13" },
  ];
  createFailures.add("Target/模拟失败文章.md");
  await plugin.sync(true);
  createFailures.delete("Target/模拟失败文章.md");
  assert.strictEqual(files.has("Target/模拟失败文章.md"), false);
  assert.ok(files.has("Target/失败后仍保存.md"), "one article failure must not stop later saves");
  assert.ok(notices.some((message) => message.includes("失败 1 篇")));

  const successfulRunPowerShell = plugin.runPowerShell;
  plugin.runPowerShell = async (maxItems, skipTitles, settings, run) => {
    run.cancellationRequested = true;
    plugin.cancellationRequested = true;
    return JSON.stringify({
      canceled: true,
      items: [{ sourceTitle: "取消前已提取", updatedDate: "2026-08-14", body: extractedBody }],
      errors: [],
    });
  };
  await plugin.sync(true);
  assert.ok(files.has("Target/取消前已提取.md"), "canceling must preserve already extracted articles");
  assert.ok(notices.some((message) => message.includes("同步已取消：已保留 1 篇")));
  plugin.runPowerShell = successfulRunPowerShell;

  plugin.runPowerShell = nativeRunPowerShell;
  nextSpawnBehavior = {
    exitCode: 1,
    stderr: "模拟 PowerShell 局部失败",
    outputText: JSON.stringify({
      items: [{ sourceTitle: "非零退出前已提取", updatedDate: "2026-08-15", body: extractedBody }],
      errors: [{ title: "后续文章", message: "模拟提取失败" }],
    }),
  };
  await plugin.sync(true);
  assert.ok(
    files.has("Target/非零退出前已提取.md"),
    "a valid partial output file must be consumed even when PowerShell exits with code 1",
  );

  const noticesBeforeInvalidOutput = notices.length;
  nextSpawnBehavior = {
    exitCode: 1,
    stderr: "invalid-output-stderr",
    outputText: "{invalid-json",
  };
  await plugin.sync(true);
  assert.ok(
    notices.slice(noticesBeforeInvalidOutput).some(
      (message) => message === "同步失败，请查看原因。",
    ),
    "invalid output must still surface the process failure",
  );
  assert.ok(plugin.syncReports[0].errors.some(error => error.message.includes("invalid-output-stderr") && error.message.includes("结果文件缺失或无效")), "full process failure stays available in history");

  const noticesBeforeMissingOutput = notices.length;
  nextSpawnBehavior = {
    exitCode: 1,
    stderr: "missing-output-stderr",
    omitOutput: true,
  };
  await plugin.sync(true);
  assert.ok(
    notices.slice(noticesBeforeMissingOutput).some(
      (message) => message === "同步失败，请查看原因。",
    ),
    "missing output must still surface the process failure",
  );
  assert.ok(plugin.syncReports[0].errors.some(error => error.message.includes("missing-output-stderr") && error.message.includes("结果文件缺失或无效")), "missing-output diagnostics stay available in history");
  plugin.runPowerShell = successfulRunPowerShell;

  const countBeforeInvalidPath = execCount;
  plugin.settings.destinationPath = "../outside";
  await plugin.sync(true);
  assert.strictEqual(execCount, countBeforeInvalidPath, "path traversal must be rejected before PowerShell runs");
  assert.ok(notices.some((message) => message.includes("不能位于当前仓库之外")));

  const workingSaveSettings = plugin.saveSettings;
  let failedConsentResolution;
  plugin.consentPromise = Promise.resolve(true);
  plugin.saveSettings = async () => { throw new Error("模拟配置保存失败"); };
  await plugin.completeConsent(true, (allowed) => { failedConsentResolution = allowed; });
  assert.strictEqual(failedConsentResolution, false);
  assert.strictEqual(plugin.consentPromise, null, "a failed consent save must release the shared promise");
  assert.strictEqual(plugin.settings.hasConsented, false);
  plugin.saveSettings = workingSaveSettings;

  const unloadPlugin = new ImaSpeedSyncPlugin();
  await unloadPlugin.onload();
  unloadPlugin.ensureConsent = async () => true;
  let unloadExtractionStartedResolve;
  const unloadExtractionStarted = new Promise((resolve) => { unloadExtractionStartedResolve = resolve; });
  let finishUnloadExtraction;
  unloadPlugin.runPowerShell = () => {
    unloadExtractionStartedResolve();
    return new Promise((resolve) => { finishUnloadExtraction = resolve; });
  };
  const createdBeforeUnload = createdPaths.length;
  const unloadingSync = unloadPlugin.sync(true);
  await unloadExtractionStarted;
  unloadPlugin.onunload();
  finishUnloadExtraction(JSON.stringify({
    items: [{ sourceTitle: "卸载后禁止写入", updatedDate: "2026-08-14", body: extractedBody }],
    errors: [],
  }));
  await unloadingSync;
  assert.deepStrictEqual(
    createdPaths.slice(createdBeforeUnload),
    [],
    "unloading the plugin must prevent all later article writes",
  );

  const generalPlugin = new ImaSpeedSyncPlugin();
  generalPlugin.loadData = async () => null;
  await generalPlugin.onload();
  assert.strictEqual(generalPlugin.settings.contentMode, "general", "new installs default to general text");
  assert.strictEqual(generalPlugin.settings.titleFilterMode, "all");
  assert.strictEqual(generalPlugin.settings.allowForeground, false);
  Object.assign(generalPlugin.settings, {
    hasConsented: true, knowledgeBaseName: "通用测试库", folderName: "普通文章", destinationPath: "General", overwriteSameName: false,
  });
  generalPlugin.ensureConsent = async () => true;
  let generalItems = [{ sourceTitle: "会议纪要", body: "明天下午三点开会。", complete: true, sourceId: "knowledge-note_abcdefghijklmnop" }];
  let generalSkips;
  generalPlugin.runPowerShell = async (_count, skipTitles, _settings, _run, skipIds) => {
    assert.deepStrictEqual(skipTitles, [], "general mode must not skip distinct articles by title alone");
    generalSkips = skipIds;
    return JSON.stringify({ items: generalItems, errors: [] });
  };
  await generalPlugin.sync(true);
  const firstGeneral = contents.get("General/会议纪要.md");
  assert.ok(firstGeneral.includes("明天下午三点开会。"), "short notes without dates must save");
  assert.ok(!firstGeneral.includes("ima_updated:"), "missing source dates must not be invented");
  assert.ok(firstGeneral.includes("ima_source_id:"));
  await generalPlugin.sync(true);
  assert.deepStrictEqual(generalSkips, ["knowledge-note_abcdefghijklmnop"], "known source IDs can skip before opening");
  assert.strictEqual(contents.get("General/会议纪要.md"), firstGeneral);

  generalPlugin.settings.overwriteSameName = true;
  generalItems = [{ sourceTitle: "会议纪要", body: "另一篇同名文章", complete: true, sourceId: "knowledge-note_ponmlkjihgfedcba" }];
  await generalPlugin.sync(true);
  assert.strictEqual(contents.get("General/会议纪要.md"), firstGeneral, "different IDs must never overwrite a same-name note");
  assert.ok(notices.at(-1).includes("同名冲突"));

  generalItems = [{ sourceTitle: "改名后的会议纪要", body: "会议改为四点。", complete: true, sourceId: "knowledge-note_abcdefghijklmnop" }];
  await generalPlugin.sync(true);
  assert.ok(contents.get("General/会议纪要.md").includes("会议改为四点。"), "same source updates in place after title changes");
  assert.strictEqual(files.has("General/改名后的会议纪要.md"), false, "renaming the source must not create a duplicate or break local links");

  generalItems = [{ sourceTitle: "短学习笔记", body: "利好/利空：原文格式不应被速看模板改写。\n-----\n\uFFFC\n结尾", complete: true }];
  await generalPlugin.sync(true);
  const shortNote = contents.get("General/短学习笔记.md");
  assert.ok(shortNote.includes("利好/利空："));
  assert.ok(!shortNote.includes("**利好/利空：**"));
  assert.ok(shortNote.includes("-----"));
  assert.ok(shortNote.includes("[内嵌内容：图片或附件暂未同步]"), "unexported embedded objects are explicitly marked");
  contents.set("General/短学习笔记.md", shortNote + "\n用户的本地补充");
  await generalPlugin.sync(true);
  assert.ok(contents.get("General/短学习笔记.md").endsWith("用户的本地补充"), "weak identity must not overwrite local changes");

  generalItems = [
    { sourceTitle: "未确认完整", body: "不是空字符串", complete: false },
    { sourceTitle: "非法日期", body: "完整短文", complete: true, updatedDate: "2026-02-31" },
    { sourceTitle: "空白正文", body: "  ", complete: true },
    { sourceTitle: "合法日期", body: "原文日期保留", complete: true, updatedDate: "2026-09-07" },
  ];
  await generalPlugin.sync(true);
  for (const title of ["未确认完整", "非法日期", "空白正文"]) assert.strictEqual(files.has(`General/${title}.md`), false);
  assert.ok(contents.get("General/合法日期.md").includes("ima_updated: 2026-09-07"));
  generalPlugin.settings.titleFilterMode = "contains";
  generalPlugin.settings.titleFilter = "";
  assert.throws(() => generalPlugin.validateSettings(generalPlugin.settings), /标题筛选内容/);
  generalPlugin.settings.titleFilter = "会议";
  assert.strictEqual(generalPlugin.validateSettings(generalPlugin.settings), "General");
  generalPlugin.runPowerShell = nativeRunPowerShell;
  nextSpawnBehavior = { outputText: JSON.stringify({ items: [], skippedTitles: [], errors: [] }) };
  await generalPlugin.sync(true);
  assert.strictEqual(lastInputPayload.contentMode, "general");
  assert.strictEqual(lastInputPayload.titleFilterMode, "contains");
  assert.strictEqual(lastInputPayload.titleFilter, "会议");
  assert.strictEqual(lastInputPayload.allowForeground, false);
  assert.ok(Array.isArray(lastInputPayload.skipSourceIds));

  // Exercise notification policy against the built plugin without operating the desktop.
  const notificationPlugin = new ImaSpeedSyncPlugin();
  await notificationPlugin.onload();
  notificationPlugin.renderSyncStatus(new Element());
  const notificationTab = settingTabs.at(-1);
  assert.deepStrictEqual([
    notificationPlugin.settings.notificationsEnabled,
    notificationPlugin.settings.notifyAutoSuccess,
    notificationPlugin.settings.notifyAutoFailure,
    notificationPlugin.settings.notifyManualResult,
    notificationPlugin.settings.showErrorBadge,
  ], [true, false, true, true, true], "existing installs receive quiet defaults without losing settings");
  assert.strictEqual(notificationPlugin.settings.destinationPath, "Target");
  assert.strictEqual(notificationPlugin.settings.contentMode, "speed-reader");
  let notificationResult = { items: [], skippedTitles: ["速看-0917", "速看-0916"], errors: [] };
  notificationPlugin.runPowerShell = async () => JSON.stringify(notificationResult);
  let noticeBaseline = notices.length;
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline, "automatic unchanged success is silent by default");
  assert.strictEqual(notificationPlugin.syncReports.length, 1);
  assert.ok(notificationPlugin.syncReports[0].summary.includes("跳过 2 篇"));
  notificationResult = { items: [{ sourceTitle: "速看-0918", body: extractedBody, updatedDate: "2026-09-18" }], errors: [] };
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline, "newly saved automatic articles must also remain quiet");
  assert.ok(files.has("Target/速看-0918.md"));
  notificationResult = { items: [], errors: [{ title: "速看-0913", message: "未读取到正文底部" }, { title: "速看-0912", message: "模拟第二篇失败" }] };
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline + 1, "multiple failures generate exactly one summary");
  assert.ok(notices.at(-1).includes("失败 2 篇"));
  assert.ok(notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"));
  const failureNotice = noticeInstances.at(-1);
  findElements(failureNotice.messageEl, (el) => el.tag === "button")[0].click();
  assert.ok(failureNotice.hidden);
  assert.ok(!notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"), "viewing toast details immediately acknowledges the failed run");
  const failureModal = notificationPlugin.historyPanel;
  assert.ok(findElements(failureModal.contentEl, (el) => el.text.includes("速看-0913：未读取到正文底部")).length);
  failureModal.close();

  notificationTab.display();
  await settingControls.get("启用同步提醒").change(false);
  assert.strictEqual(settingControls.get("自动同步失败提醒").disabled, true);
  assert.strictEqual(notificationPlugin.savedData.notificationsEnabled, false);
  assert.strictEqual(notificationPlugin.savedData.notifyAutoFailure, true, "master switch preserves individual preferences");
  assert.ok(!notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"));
  noticeBaseline = notices.length;
  await notificationPlugin.sync(false);
  await notificationPlugin.sync(true);
  await notificationPlugin.cancelSync();
  const previousSettingController = notificationPlugin.app.setting;
  delete notificationPlugin.app.setting;
  notificationPlugin.openSettings();
  notificationPlugin.app.setting = previousSettingController;
  assert.strictEqual(notices.length, noticeBaseline, "master-off mutes errors, manual results and operation notices");
  assert.ok(notificationPlugin.syncReports[0].errors.length === 2, "muting never erases diagnostics");
  const statusContainer = new Element();
  notificationPlugin.renderSyncStatus(statusContainer);
  findElements(statusContainer, (el) => el.text.startsWith("同步日志（"))[0].click();
  assert.ok(findElements(notificationPlugin.historyPanel.contentEl, el => el.tag === "h4" && el.text === "同步日志").length);
  await notificationPlugin.saveQueue;
  const savedNotificationData = JSON.parse(JSON.stringify(notificationPlugin.savedData));
  const reloadedPlugin = new ImaSpeedSyncPlugin();
  reloadedPlugin.loadData = async () => savedNotificationData;
  await reloadedPlugin.onload();
  assert.strictEqual(reloadedPlugin.settings.notificationsEnabled, false);
  assert.deepStrictEqual(reloadedPlugin.syncReports, notificationPlugin.syncReports);
  assert.strictEqual(notices.length, noticeBaseline, "loading history never replays a toast");
  reloadedPlugin.settings.notificationsEnabled = true;
  reloadedPlugin.updateNotificationPreferences();
  assert.ok(!reloadedPlugin.ribbon.cls.includes("ima-share-sync-has-warning"), "read warnings stay cleared after plugin reload");
  assert.ok(reloadedPlugin.syncReports.some((report) => report.status === "failed" && report.read), "read does not erase errors");

  await settingControls.get("启用同步提醒").change(true);
  await settingControls.get("自动同步失败提醒").change(false);
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline, "auto error switch is independent of badge");
  assert.ok(notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"));
  await settingControls.get("图标异常标记").change(false);
  assert.ok(!notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"));
  await notificationPlugin.sync(true);
  assert.strictEqual(notices.length, ++noticeBaseline, "manual failures obey the manual switch, not the auto switch");
  const visibleNotice = noticeInstances.at(-1);
  await settingControls.get("手动同步结果提醒").change(false);
  assert.ok(visibleNotice.hidden, "turning off the applicable switch dismisses an active toast");
  await notificationPlugin.sync(true);
  assert.strictEqual(notices.length, noticeBaseline);
  await settingControls.get("自动同步成功提醒").change(true);
  notificationResult = { items: [], errors: [], skippedTitles: [] };
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, ++noticeBaseline, "automatic success is opt-in");
  await settingControls.get("图标异常标记").change(true);
  assert.ok(!notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"), "successful run clears the previous warning");

  await settingControls.get("自动同步失败提醒").change(true);
  notificationPlugin.runPowerShell = async () => { throw new Error("模拟 IMA 未启动"); };
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, ++noticeBaseline, "whole-run failure notifies once");
  assert.ok(notices.at(-1).includes("模拟 IMA 未启动"));
  const beforeCancel = notificationPlugin.syncReports.length;
  notificationPlugin.runPowerShell = async () => JSON.stringify({ canceled: true, items: [], errors: [] });
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline, "automatic cancellation is not success/failure spam");
  assert.strictEqual(notificationPlugin.syncReports.length, beforeCancel + 1);
  assert.ok(notificationPlugin.ribbon.cls.includes("ima-share-sync-has-warning"), "cancel does not clear an earlier error");
  notificationPlugin.runPowerShell = async () => JSON.stringify({ busy: true });
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline);
  assert.strictEqual(notificationPlugin.syncReports.length, beforeCancel + 2, "mutex busy is recorded as an unstarted run, not a false success");
  assert.equal(notificationPlugin.syncReports[0].status, "canceled");

  notificationPlugin.runPowerShell = async () => {
    notificationPlugin.settings.notificationsEnabled = false;
    notificationPlugin.updateNotificationPreferences();
    return JSON.stringify({ items: [], errors: [{ title: "测试", message: "运行中静音" }] });
  };
  await notificationPlugin.sync(false);
  assert.strictEqual(notices.length, noticeBaseline, "result uses live preferences if muted during a run");
  notificationPlugin.runPowerShell = async () => JSON.stringify({ items: [], errors: [] });
  const historyBeforeBatch = notificationPlugin.syncReports.length;
  const oldestBeforeBatch = notificationPlugin.syncReports.at(-1).id;
  for (let i = 0; i < 25; i++) await notificationPlugin.sync(false);
  assert.strictEqual(notificationPlugin.syncReports.length, historyBeforeBatch + 25);
  assert.strictEqual(notificationPlugin.savedData.syncReports.length, historyBeforeBatch + 25, "all local reports persist beyond one page");
  assert.equal(notificationPlugin.syncReports.at(-1).id, oldestBeforeBatch, "new runs never evict old records");
  const successfulSaveData = notificationPlugin.saveData;
  notificationPlugin.saveData = async () => { throw new Error("模拟配置文件不可写"); };
  await notificationPlugin.sync(false);
  assert.strictEqual(notificationPlugin.isRunning, false, "history save failure must release the sync gate");
  assert.strictEqual(notificationPlugin.syncReports[0].status, "success", "report persistence failure must not mislabel saved articles");
  assert.strictEqual(notificationPlugin.reportSaveFailed, true);
  notificationPlugin.saveData = successfulSaveData;
  await notificationPlugin.sync(false);
  assert.strictEqual(notificationPlugin.reportSaveFailed, false, "save queue recovers after rejection");

  let releaseSave;
  const writeSnapshots = [];
  notificationPlugin.saveData = async (data) => {
    writeSnapshots.push(JSON.parse(JSON.stringify(data)));
    if (writeSnapshots.length === 1) await new Promise((resolve) => { releaseSave = resolve; });
  };
  const firstSave = notificationPlugin.saveSettings();
  await waitForFixture(() => releaseSave);
  notificationPlugin.settings.notifyAutoFailure = false;
  const nextSave = notificationPlugin.saveSettings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(writeSnapshots.length, 1, "settings and result persistence must not write concurrently");
  releaseSave();
  await Promise.all([firstSave, nextSave]);
  assert.strictEqual(writeSnapshots[1].notifyAutoFailure, false);
  notificationPlugin.saveData = successfulSaveData;

  const malformedPlugin = new ImaSpeedSyncPlugin();
  malformedPlugin.loadData = async () => ({ ...savedNotificationData, notificationsEnabled: "false", syncReports: [null, { status: "other" }, { ...savedNotificationData.syncReports[0], errors: [null, {}, { title: "<script>", message: "<b>plain text</b>" }] }] });
  await malformedPlugin.onload();
  assert.strictEqual(malformedPlugin.settings.notificationsEnabled, true, "invalid toggle values recover to safe defaults");
  assert.strictEqual(malformedPlugin.syncReports.length, 1);
  assert.deepStrictEqual(malformedPlugin.syncReports[0].errors, [{ title: "<script>", message: "<b>plain text</b>" }]);
  const malformedStatus = new Element();
  malformedPlugin.renderSyncStatus(malformedStatus);
  findElements(malformedStatus, (el) => el.tag === "button")[0].click();
  assert.ok(findElements(malformedPlugin.historyPanel.contentEl, (el) => el.tag === "p" && el.text === "<script>：<b>plain text</b>").length, "error text is rendered as text, never HTML");
  notificationPlugin.settings.notificationsEnabled = true;
  notificationPlugin.settings.notifyManualResult = true;
  notificationPlugin.notifyManual("卸载前提示");
  const unloadingNotice = noticeInstances.at(-1);
  notificationPlugin.onunload();
  assert.ok(unloadingNotice.hidden);
  noticeBaseline = notices.length;
  notificationPlugin.notifyManual("卸载后禁止提示");
  assert.strictEqual(notices.length, noticeBaseline);
  console.log("PASS: notification toggles, aggregate results, badge, details, persisted history, mute and save concurrency");

  const cardPlugin = new ImaSpeedSyncPlugin();
  await cardPlugin.onload();
  cardPlugin.openOperationCard = nativeOpenOperationCard;
  let workerStarts = 0;
  cardPlugin.runPowerShell = async () => { workerStarts++; return JSON.stringify({ items: [], skippedTitles: ["已存文章"], errors: [] }); };
  noticeBaseline = notices.length;
  transientRenameFailures = 3;
  await cardPlugin.sync(false);
  assert.equal(renameRetryCount, 3, "transient Windows file locks retry without silently operating or failing sync");
  assert.equal(workerStarts, 1);
  assert.equal(notices.length, noticeBaseline, "native completion card does not duplicate a toast");
  let childCard = cardChildren.at(-1);
  let cardState = JSON.parse(fs.readFileSync(childCard.statePath, "utf8"));
  assert.equal(cardState.phase, "success");
  assert.ok(cardState.text.includes("跳过 1 篇"));
  childCard.command("details");
  assert.equal(cardPlugin.hasUnreadSyncFailure(), false);

  nextCardBehavior = "wait";
  const waitingSync = cardPlugin.sync(false);
  await waitForFixture(() => cardChildren.at(-1) !== childCard);
  childCard = cardChildren.at(-1);
  assert.equal(JSON.parse(fs.readFileSync(childCard.statePath, "utf8")).phase, "before");
  assert.equal(workerStarts, 1, "extractor cannot start until the displayed countdown/action resolves");
  await cardPlugin.cancelSync();
  await waitingSync;
  assert.equal(workerStarts, 1, "canceling preflight never operates IMA");
  assert.equal(cardPlugin.isRunning, false);
  nextCardBehavior = "cancel";
  await cardPlugin.sync(false);
  assert.equal(workerStarts, 1);
  nextCardBehavior = "later";
  await cardPlugin.sync(false);
  assert.equal(workerStarts, 1);
  assert.ok(cardPlugin.deferredSyncTimer, "later schedules one retry");
  const deferredTimer = cardPlugin.deferredSyncTimer;
  nextCardBehavior = "cancel";
  await cardPlugin.sync(true);
  assert.equal(cardPlugin.deferredSyncTimer, null, "manual action cancels deferred retry");
  assert.ok(deferredTimer._destroyed, "no unexpected duplicate later run");
  assert.equal(cardChildren.at(-1).initialState.phase, "running", "manual request skips preflight even with the before prompt enabled");
  const startsBeforeManual = workerStarts;
  await cardPlugin.sync(true);
  assert.equal(cardChildren.at(-1).initialState.phase, "running");
  assert.equal(workerStarts, startsBeforeManual + 1, "manual sync starts on the native ready/start handshake without a countdown");

  let releaseWorker;
  cardPlugin.runPowerShell = async () => {
    workerStarts++;
    return new Promise((resolve) => { releaseWorker = resolve; });
  };
  const stoppingSync = cardPlugin.sync(false);
  await waitForFixture(() => releaseWorker);
  childCard = cardChildren.at(-1);
  childCard.command("stop");
  await waitForFixture(() => JSON.parse(fs.readFileSync(childCard.statePath, "utf8")).phase === "stopping");
  assert.equal(cardPlugin.isRunning, true, "stop button waits for worker termination");
  assert.equal(JSON.parse(fs.readFileSync(childCard.statePath, "utf8")).phase, "stopping");
  releaseWorker(JSON.stringify({ canceled: true, items: [], errors: [] }));
  await stoppingSync;
  assert.equal(JSON.parse(fs.readFileSync(childCard.statePath, "utf8")).phase, "canceled");

  cardPlugin.runPowerShell = async () => { workerStarts++; return JSON.stringify({ items: [], errors: [{ title: "测试文章", message: "正文未完整读取" }] }); };
  await cardPlugin.sync(false);
  childCard = cardChildren.at(-1);
  assert.equal(JSON.parse(fs.readFileSync(childCard.statePath, "utf8")).phase, "failed");
  const compactFailure = JSON.parse(fs.readFileSync(childCard.statePath, "utf8"));
  assert.equal(compactFailure.text, "失败 1 篇", "omit zero counts and duplicated status headings");
  assert.equal(compactFailure.details, "测试文章：正文未读取完整，请重试。", "details contain only the actionable error, without repeating results or timestamps");
  assert.equal(cardPlugin.syncReports[0].errors[0].message, "正文未完整读取", "retain the original diagnostic in history");
  assert.ok(cardPlugin.hasUnreadSyncFailure());
  childCard.command("details");
  assert.equal(cardPlugin.hasUnreadSyncFailure(), false, "inline desktop details mark only this run as read");
  await cardPlugin.saveQueue;
  assert.equal(cardPlugin.savedData.syncReports[0].read, true);
  assert.equal(notices.length, noticeBaseline, "failed card replaces, rather than adds, the error toast");
  const previousStarts = workerStarts;
  nextCardBehavior = "error";
  await cardPlugin.sync(false);
  assert.equal(workerStarts, previousStarts, "UI startup failure is fail-closed");
  assert.equal(notices.length, noticeBaseline + 1, "if the card cannot open, report through the configured error toast");

  cardPlugin.settings.notificationsEnabled = false;
  let activeCardDuringMutedRun;
  cardPlugin.runPowerShell = async () => {
    activeCardDuringMutedRun = JSON.parse(fs.readFileSync(cardChildren.at(-1).statePath, "utf8"));
    return JSON.stringify({ items: [], errors: [] });
  };
  await cardPlugin.sync(false);
  assert.equal(activeCardDuringMutedRun.phase, "running", "master-off still exposes the stop control, without pre/post prompts");
  assert.ok(cardChildren.at(-1).killed, "master-off closes the card immediately after completion");

  cardPlugin.settings.notificationsEnabled = true;
  cardPlugin.settings.showOperationBefore = false;
  cardPlugin.settings.showOperationAfter = true;
  const observedProgress = [];
  const updateCard = cardPlugin.updateOperationCard.bind(cardPlugin);
  cardPlugin.updateOperationCard = (run, text) => { observedProgress.push(text); updateCard(run, text); };
  cardPlugin.runPowerShell = nativeRunPowerShell;
  nextSpawnBehavior = { outputText: JSON.stringify({ items: [], errors: [] }), progressChunks: ["IMA_PRO", "GRESS:{\"text\":\"正在检查第 3 / 7 篇文章\"}\n", "IMA_PROGRESS:{bad}\n"] };
  await cardPlugin.sync(false);
  assert.ok(observedProgress.includes("正在检查第 3 / 7 篇文章"), "use real extractor progress; tolerate fragmented/malformed lines");
  childCard = cardChildren.at(-1);
  cardPlugin.settings.showOperationAfter = false;
  cardPlugin.updateNotificationPreferences();
  assert.ok(childCard.killed, "turning off end prompts dismisses existing completion card");
  nextCardBehavior = "later";
  await cardPlugin.sync(false);
  assert.ok(cardPlugin.deferredSyncTimer);
  cardPlugin.onunload();
  assert.equal(cardPlugin.deferredSyncTimer, null);
  assert.equal(cardPlugin.operationCards.size, 0);
  assert.ok(cardChildren.every((child) => child.killed), "unload/new run clean up all owned helper processes");

  const unreadPlugin = new ImaSpeedSyncPlugin();
  await unreadPlugin.onload();
  unreadPlugin.renderSyncStatus(new Element());
  const failedReport = () => ({ finishedAt: 1234567890, interactive: false, status: "failed", summary: "同一异常", errors: [{ title: "测试", message: "未读取完整" }] });
  await unreadPlugin.recordSyncReport(failedReport());
  const oldReport = unreadPlugin.syncReports[0];
  assert.ok(unreadPlugin.hasUnreadSyncFailure());
  ribbonCallback();
  assert.ok(findElements(unreadPlugin.historyPanel.contentEl, el => el.tag === "h4" && el.text === "同步日志").length);
  assert.equal(unreadPlugin.hasUnreadSyncFailure(), false, "clicking the warning icon opens history and clears the dot");
  await unreadPlugin.saveQueue;
  await unreadPlugin.recordSyncReport(failedReport());
  assert.notEqual(unreadPlugin.syncReports[0].id, oldReport.id, "even equal timestamp/content runs have separate read identities");
  await unreadPlugin.markSyncReportsRead([oldReport]);
  assert.ok(unreadPlugin.hasUnreadSyncFailure(), "viewing an older toast cannot clear a newer failure");
  const unreadReload = new ImaSpeedSyncPlugin();
  unreadReload.loadData = async () => unreadPlugin.savedData;
  await unreadReload.onload();
  assert.ok(unreadReload.hasUnreadSyncFailure(), "unread errors still survive reload");
  const legacyUnread = new ImaSpeedSyncPlugin();
  legacyUnread.loadData = async () => ({ syncReports: [failedReport()] });
  await legacyUnread.onload();
  assert.ok(legacyUnread.hasUnreadSyncFailure(), "old records without read metadata migrate as unread");
  await legacyUnread.markSyncReportsRead(legacyUnread.syncReports);
  const migratedReload = new ImaSpeedSyncPlugin();
  migratedReload.loadData = async () => legacyUnread.savedData;
  await migratedReload.onload();
  assert.equal(migratedReload.hasUnreadSyncFailure(), false, "legacy read acknowledgment persists too");
  console.log("PASS: per-run unread badges, icon/history/toast/native acknowledgment, migration, persistence and newer-error isolation");
  const historyPlugin = new ImaSpeedSyncPlugin();
  const historyFixtures = Array.from({ length: 45 }, (_, index) => ({
    id: `history-${index}`, finishedAt: 2000000000000 - index * 60000,
    interactive: index % 2 === 0, status: "failed", read: false,
    summary: `第 ${index} 次同步`, errors: [{ title: `文章 ${index}`, message: `错误原因 ${index}` }],
  }));
  historyPlugin.loadData = async () => ({ syncReports: historyFixtures, notificationsEnabled: false });
  await historyPlugin.onload();
  const inlineHistoryContainer = new Element();
  historyPlugin.renderSyncStatus(inlineHistoryContainer);
  const modalCountBeforeHistory = openedModals.length;
  const existingHistoryLeaf = { view: {} };
  historyPlugin.app.workspace.getLeavesOfType = () => [existingHistoryLeaf];
  historyPlugin.app.workspace.detachLeavesOfType = () => { throw new Error("opening inline history must reuse the existing sidebar"); };
  assert.equal(historyPlugin.syncReports.length, 45, "loading no longer truncates full history");
  historyPlugin.openSyncHistory();
  let historyModal = historyPlugin.historyPanel;
  assert.equal(openedModals.length, modalCountBeforeHistory, "viewing logs must never create a modal");
  assert.equal(revealedLeaf, existingHistoryLeaf, "error/history links reveal the existing plugin sidebar");
  assert.ok(findElements(inlineHistoryContainer, el => el.tag === "h4" && el.text === "同步日志").length, "history is mounted inside the plugin panel");
  const recordsOnPage = () => findElements(historyModal.contentEl, el => el.tag === "details");
  const historyButton = (text) => findElements(historyModal.contentEl, el => el.tag === "button" && el.text === text)[0];
  assert.equal(recordsOnPage().length, 20);
  assert.ok(recordsOnPage().every(el => !el.open), "history details start collapsed");
  assert.equal(historyButton("上一页").disabled, true);
  assert.equal(historyPlugin.syncReports[20].read, false, "unseen pages remain unread");
  historyButton("下一页").click();
  assert.equal(recordsOnPage().length, 20);
  assert.ok(findElements(historyModal.contentEl, el => el.text === "第 2 / 3 页 · 共 45 次").length);
  const refreshedHistoryContainer = new Element();
  historyPlugin.renderSyncStatus(refreshedHistoryContainer);
  assert.ok(findElements(refreshedHistoryContainer, el => el.text === "第 2 / 3 页 · 共 45 次").length, "sidebar refresh preserves the history page");
  historyButton("下一页").click();
  assert.equal(recordsOnPage().length, 5);
  assert.equal(historyButton("下一页").disabled, true);
  historyButton("下一页").click();
  assert.equal(recordsOnPage().length, 5, "last-page guard prevents blank extra pages");
  historyButton("上一页").click();
  assert.equal(recordsOnPage().length, 20);
  historyButton("收起").click();
  assert.equal(historyModal.contentEl.children.length, 0);
  assert.equal(historyPlugin.historyPanel, null, "collapse removes the inline log without removing history");
  assert.equal(findElements(refreshedHistoryContainer, el => el.text === "同步日志（45）")[0]["aria-expanded"], "false");
  assert.equal(historyPlugin.syncReports.length, 45, "closing history never removes records");
  await historyPlugin.saveQueue;
  const historyReload = new ImaSpeedSyncPlugin();
  historyReload.loadData = async () => JSON.parse(JSON.stringify(historyPlugin.savedData));
  await historyReload.onload();
  historyReload.renderSyncStatus(new Element());
  assert.equal(historyReload.syncReports.length, 45, "all pages survive restart");
  await historyReload.recordSyncReport({ finishedAt: 2100000000000, interactive: false, status: "failed", summary: "新错误", errors: [{ title: "新文章", message: "新的原因" }] });
  historyReload.openSyncHistory([historyReload.syncReports.find(report => report.id === "history-24")]);
  historyModal = historyReload.historyPanel;
  assert.equal(recordsOnPage().length, 20, "error link still opens the full paginated history");
  assert.equal(recordsOnPage().filter(el => el.open).length, 1, "only the linked error expands");
  assert.ok(findElements(recordsOnPage().find(el => el.open), el => el.text === "文章 24：错误原因 24").length);
  assert.ok(findElements(historyModal.contentEl, el => el.text === "第 2 / 3 页 · 共 46 次").length);
  assert.equal(historyReload.syncReports[0].read, false, "viewing an old error does not acknowledge newer errors");
  historyButton("收起").click();
  historyReload.openSyncHistory();
  historyModal = historyReload.historyPanel;
  assert.equal(recordsOnPage().length, 20);
  assert.ok(recordsOnPage().every(el => !el.open), "reopening regular history starts collapsed on page one");
  const emptyHistory = new ImaSpeedSyncPlugin();
  emptyHistory.loadData = async () => null;
  await emptyHistory.onload();
  const emptyStatus = new Element();
  emptyHistory.renderSyncStatus(emptyStatus);
  findElements(emptyStatus, el => el.text === "同步日志（0）")[0].click();
  historyModal = emptyHistory.historyPanel;
  assert.equal(recordsOnPage().length, 0);
  assert.equal(historyButton("下一页").disabled, true);
  assert.equal(historyButton("上一页").disabled, true);
  const emptyToggle = findElements(emptyStatus, el => el.text === "同步日志（0）")[0];
  emptyToggle.click();
  assert.equal(emptyHistory.historyPanel, null, "the same entry toggles inline history closed");
  emptyToggle.click();
  assert.ok(emptyHistory.historyPanel);
  assert.equal(openedModals.length, modalCountBeforeHistory, "pagination, collapse and error jumps do not open any modal");
  console.log("PASS: complete persistent history, 20-row pagination, collapsed default, focused errors, close/reopen, restart and empty state");
  console.log("PASS: native-card IPC, preflight cancellation, defer, stop acknowledgment, progress, mute, fail-closed and teardown");

  Module._load = originalLoad;
  console.log("PASS: plugin build, platform-safe execution, general text, identity conflicts, embedded script, and vault writes");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
