import { sha256 } from './sha256.mjs';
import { loadPreviewData, storageKey } from './scenarios.mjs';
/** The live Web view uses the same native provider class as the installed plugin. */
export function configureIdentityProvider(plugin, scenario, calls) {
  if (scenario.id === 'live') {
    if (typeof scenario.nativeIdentity !== 'function') throw new Error('真实来源读取通道尚未连接。');
    plugin.runNativeIdentity = async request => {
      calls.push({ operation: 'identity.native', args: [structuredClone(request)] });
      return await scenario.nativeIdentity(request);
    };
    return;
  }
  plugin.identityProvider = Object.fromEntries(Object.entries(scenario.identityProvider).map(([operation, run]) => [operation, async (...args) => {
    calls.push({ operation: 'identity.' + operation, args: structuredClone(args) }); return await run(...args);
  }]));
}

export async function requestNativeIdentity(request, fetcher = globalThis.fetch) {
  const response = await fetcher('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'nativeIdentity', args: [request] }) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '读取来源失败');
    if (typeof result.code === 'string') error.code = result.code;
    throw error;
  }
  return result.value;
}

// Browser-only Obsidian adapter. Settings, pickers, binding and history are loaded
// from the actual dist/main.js. Nothing in this module is shipped in the plugin.
export function installHost({ scenario, metadata, icons, storage }) {
  const errors = [], calls = [];
  const clone = value => value == null ? value : structuredClone(value);
  const blocked = operation => () => { throw new Error(`Web preview blocks ${operation}`); };
  const reportError = error => {
    errors.push(String(error?.stack || error));
    const box = document.getElementById('fixture-error'); box.hidden = false;
    box.textContent = errors.at(-1); console.error(error);
  };
  const invoke = (callback, value) => { try { Promise.resolve(callback(value)).catch(reportError); } catch (error) { reportError(error); } };
  const initialData = loadPreviewData(storage, scenario);
  let allowFailureSimulation = false;
  let savedData = clone(initialData), saveCount = 0, nextControlId = 0, settingsTab, viewCreator, plugin;
  const leaf = {};
  const customIcons = new Map();
  document.getElementById('settings').addEventListener('submit', event => event.preventDefault());
  window.addEventListener('error', event => reportError(event.error || event.message));
  window.addEventListener('unhandledrejection', event => reportError(event.reason));

    HTMLElement.prototype.empty = function () { this.replaceChildren(); };
    HTMLElement.prototype.setText = function (value) { this.textContent = value; };
    HTMLElement.prototype.setAttr = function (key, value) { this.setAttribute(key, value); };
    HTMLElement.prototype.toggleClass = function (key, value) { this.classList.toggle(key, value); };
    HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
    HTMLElement.prototype.removeClass = function (...names) { this.classList.remove(...names); };
    HTMLElement.prototype.createEl = function (tag, options = {}) {
      const element = document.createElement(tag);
      if (typeof options === 'string') options = { cls: options };
      if (options.text !== undefined) element.textContent = options.text;
      if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
      for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
      this.append(element);
      return element;
    };
    HTMLElement.prototype.createDiv = function (options) { return this.createEl('div', options); };
    HTMLElement.prototype.createSpan = function (options) { return this.createEl('span', options); };

    class Setting {
      constructor(container) {
        this.settingEl = container.createDiv({ cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
        this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
        this.baseId = `fixture-setting-${++nextControlId}`;
        this.nameEl.id = `${this.baseId}-name`;
        this.descEl.id = `${this.baseId}-description`;
      }
      setName(value) { this.nameEl.textContent = value; return this; }
      setDesc(value) { this.descEl.replaceChildren(value instanceof Node ? value : document.createTextNode(value)); return this; }
      setHeading() {
        const heading = document.createElement('h2');
        heading.textContent = this.nameEl.textContent;
        heading.id = this.nameEl.id;
        heading.className = this.nameEl.className;
        this.nameEl.replaceWith(heading);
        this.nameEl = heading;
        this.settingEl.classList.add('mod-heading');
        return this;
      }
      bind(element) {
        element.id = `${this.baseId}-control-${this.controlEl.children.length}`;
        element.name = element.id;
        element.setAttribute('aria-describedby', this.descEl.id);
        if (element.tagName !== 'BUTTON') {
          if (this.nameEl.tagName !== 'LABEL') {
            const label = document.createElement('label');
            label.id = this.nameEl.id;
            label.className = this.nameEl.className;
            label.textContent = this.nameEl.textContent;
            this.nameEl.replaceWith(label);
            this.nameEl = label;
          }
          this.nameEl.htmlFor = element.id;
          element.setAttribute('aria-labelledby', this.nameEl.id);
        }
        return element;
      }
      addText(callback) {
        const input = this.bind(this.controlEl.createEl('input', { attr: { type: 'text', autocomplete: 'off' } }));
        const control = {
          inputEl: input,
          setPlaceholder(value) { input.placeholder = value; return this; },
          setValue(value) { input.value = value; return this; },
          setDisabled(value) { input.disabled = value; return this; },
          onChange(handler) { input.addEventListener('input', () => invoke(handler, input.value)); return this; },
        };
        callback(control); return this;
      }
      addTextArea(callback) {
        const input = this.bind(this.controlEl.createEl('textarea'));
        const control = {
          inputEl: input,
          setValue(value) { input.value = value; return this; },
          onChange(handler) { input.addEventListener('input', () => invoke(handler, input.value)); return this; },
        };
        callback(control); return this;
      }
      addDropdown(callback) {
        const select = this.bind(this.controlEl.createEl('select'));
        const control = {
          selectEl: select,
          addOption(value, text) { select.add(new Option(text, value)); return this; },
          setValue(value) { select.value = value; return this; },
          setDisabled(value) { select.disabled = value; return this; },
          onChange(handler) { select.addEventListener('change', () => invoke(handler, select.value)); return this; },
        };
        callback(control); return this;
      }
      addToggle(callback) {
        const input = this.bind(this.controlEl.createEl('input', { cls: 'web-toggle', attr: { type: 'checkbox', role: 'switch' } }));
        const control = {
          toggleEl: input,
          setValue(value) { input.checked = value; return this; },
          setDisabled(value) { input.disabled = value; return this; },
          onChange(handler) { input.addEventListener('change', () => invoke(handler, input.checked)); return this; },
        };
        callback(control); return this;
      }
      addSlider(callback) {
        const input = this.bind(this.controlEl.createEl('input', { attr: { type: 'range' } }));
        const control = {
          sliderEl: input,
          setLimits(min, max, step) { Object.assign(input, { min, max, step }); return this; },
          setValue(value) { input.value = String(value); return this; },
          setDisabled(value) { input.disabled = value; return this; },
          setDynamicTooltip() { return this; },
          onChange(handler) { input.addEventListener('input', () => invoke(handler, Number(input.value))); return this; },
        };
        callback(control); return this;
      }
      addButton(callback) {
        const button = this.bind(this.controlEl.createEl('button', { attr: { type: 'button' } }));
        const control = {
          buttonEl: button,
          setButtonText(value) { button.textContent = value; return this; },
          setCta() { button.classList.add('mod-cta'); return this; },
          setWarning() { button.classList.add('mod-warning'); return this; },
          setDisabled(value) { button.disabled = value; return this; },
          onClick(handler) { button.addEventListener('click', (event) => invoke(handler, event)); return this; },
        };
        callback(control); return this;
      }
    }
    class Modal {
      constructor(app) {
        this.app = app;
        this.modalEl = document.body.createEl('dialog');
        this.titleEl = this.modalEl.createEl('h2');
        this.titleEl.id = `fixture-dialog-${++nextControlId}`;
        this.modalEl.setAttribute('aria-labelledby', this.titleEl.id);
        this.contentEl = this.modalEl.createDiv();
        this.modalEl.addEventListener('close', () => { this.onClose?.(); this.modalEl.remove(); });
      }
      open() { this.onOpen?.(); this.modalEl.showModal(); }
      close() { this.modalEl.close(); }
    }
    class Notice {
      constructor(message, duration = 5000) {
        this.messageEl = document.getElementById('fixture-notices').createDiv({ cls: 'fixture-notice', text: message });
        if (duration > 0) this.timer = setTimeout(() => this.hide(), duration);
      }
      hide() { clearTimeout(this.timer); this.messageEl.remove(); }
    }
    class PluginSettingTab {
      constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.getElementById('settings'); }
    }


  class TFile {
    constructor(record) {
      Object.assign(this, record);
      this.name = this.path.split('/').at(-1); this.extension = this.name.split('.').at(-1);
      this.basename = this.name.slice(0, -this.extension.length - 1);
    }
  }
  class TFolder { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = []; } }
  const files = scenario.files.map(record => new TFile(record));
  const folders = scenario.destinationFolders.map(path => new TFolder(path));
  const entries = new Map([...folders, ...files].map(file => [file.path, file]));
  for (const file of [...folders, ...files]) {
    const parent = entries.get(file.path.split('/').slice(0, -1).join('/'));
    if (parent instanceof TFolder) { parent.children.push(file); file.parent = parent; }
  }
  class ItemView {
    constructor(viewLeaf) { this.leaf = viewLeaf; this.contentEl = document.getElementById('panel'); }
    registerEvent() {}
    addChild(child) { child.load?.(); return child; }
    removeChild(child) { child.unload?.(); }
  }
  class Menu {
    constructor() { this.items = []; }
    addItem(callback) {
      const item = { setTitle(value) { this.title = value; return this; }, setIcon() { return this; },
        setChecked(value) { this.checked = value; return this; }, onClick(callback) { this.callback = callback; return this; } };
      callback(item); this.items.push(item); return this;
    }
    showAtMouseEvent() {
      const dialog = new Modal(plugin.app); dialog.titleEl.setText('同名文件处理');
      for (const item of this.items) {
        const button = dialog.contentEl.createEl('button', { text: item.title, attr: { type: 'button', 'aria-pressed': String(item.checked) } });
        button.addEventListener('click', () => { invoke(item.callback); dialog.close(); });
      }
      dialog.open();
    }
  }
  class Plugin {
    constructor() {
      this.manifest = { id: 'ima-speed-sync', version: metadata.version };
      this.app = {
        vault: new Proxy({ configDir: '.obsidian', getName: () => 'Web 演示库',
          getFiles: () => files, getAllLoadedFiles: () => [...folders, ...files],
          getAbstractFileByPath: path => entries.get(path) || null, on: () => ({}),
        }, { get: (target, name) => name in target ? target[name] : blocked(`vault.${String(name)}`) }),
        workspace: { getLeavesOfType: () => leaf.view ? [leaf] : [], onLayoutReady() {},
          revealLeaf: async () => {}, getRightLeaf: () => leaf, getLeaf: () => ({
            async openFile(file) {
              const note = document.getElementById('note'); note.empty();
              note.createEl('h2', { text: file.basename });
              note.createEl('p', { text: '这是 Web 开发环境中的示例文章。' });
              note.createEl('p', { text: file.path }); note.focus();
            },
          }),
        },
      };
    }
    async loadData() { return clone(initialData); }
    async saveData(value) { if (allowFailureSimulation && scenario.failSaves) throw new Error('演示：浏览器存储暂不可用。可重试或恢复已保存设置。'); storage.setItem(storageKey(scenario.id), JSON.stringify(value)); savedData = clone(value); saveCount++; }
    addSettingTab(tab) { settingsTab = tab; }
    registerView(_type, creator) { viewCreator = creator; }
    addRibbonIcon() { return document.createElement('button'); }
    addCommand() {}
    registerDomEvent() {}
  }
  const obsidian = {
    Plugin, PluginSettingTab, Setting, Modal, Notice, ItemView, TFile, TFolder, Menu,
    FileSystemAdapter: class {}, Platform: { isWin: true },
    normalizePath: value => value.replaceAll('\\', '/'),
    addIcon(name, content) { customIcons.set(name, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${content}</svg>`); },
    setIcon(element, name) {
      const source = customIcons.get(name) || icons[name];
      if (!source) throw new Error(`Web host needs icon: ${name}`);
      const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
      svg.classList.add('svg-icon'); svg.setAttribute('aria-hidden', 'true'); element.replaceChildren(svg);
    },
  };

    window.module = { exports: {} };
    window.require = (name) => {
      if (name === 'worker_threads') return { Worker: class { constructor() { throw new Error('PDF workers are disabled in this settings-only fixture.'); } } };
      if (name === 'obsidian') return obsidian;
      if (name === 'crypto') return { randomUUID: () => crypto.randomUUID(), createHash: () => ({
        update(value) { this.value = (this.value || '') + value; return this; },
        digest() { return sha256(this.value || ''); },
      }) };
      if (name === 'child_process') return { spawn: blocked('child_process.spawn') };
      if (name === 'https') return { request: blocked('https.request') };
      if (name === 'node:timers') return { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) };
      if (name === 'buffer') return { Buffer: { from(value, encoding) {
        return encoding === 'base64' ? Uint8Array.from(atob(value), c => c.charCodeAt(0)) :
          typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
      } } };
      // PDF workers remain blocked; this settings-only host does not load WASM.
      if (name === 'zlib') return { gunzipSync: () => new Uint8Array(0), brotliDecompressSync: () => new Uint8Array(0) };
      if (name === 'fs' || name === 'electron') return new Proxy({}, { get: (_target, key) => blocked(`${name}.${String(key)}`) });
      if (name === 'fs/promises') return Object.fromEntries(['lstat', 'mkdir', 'mkdtemp', 'readFile', 'realpath', 'rm', 'writeFile', 'rename'].map((key) => [key, blocked(`fs.${key}`)]));
      if (name === 'os') return { tmpdir: blocked('os.tmpdir'), homedir: () => 'C:\\Fixture' };
      if (name === 'path') return { join: (...parts) => parts.join('\\'), resolve: blocked('path.resolve') };
      throw new Error(`Unmocked fixture module: ${name}`);
    };


  return {
    obsidian, reportError,
    get plugin() { return plugin; }, get settingsTab() { return settingsTab; },
    snapshot: () => clone({ savedData, saveCount, calls, errors, settings: plugin?.settings }),
    async start(openSettings) {
      const PluginExport = window.module.exports.default || window.module.exports;
      plugin = new PluginExport();
      await plugin.onload();
      configureIdentityProvider(plugin, scenario, calls);
      allowFailureSimulation = true;
      plugin.ensureConsent = async () => true;
      plugin.runPowerShell = async (_count, _skip, settings, _run, _ids, operation) => {
        calls.push({ operation, knowledgeBaseName: settings.knowledgeBaseName, path: settings.sourceCatalogPath ?? settings.sourceFolderPath ?? [] });
        return JSON.stringify(await scenario.catalog(operation, settings));
      };
      // Native effects are deliberately unavailable, including accidental button presses.
      plugin.sync = async () => { new Notice(plugin.settings.sourceIdentity?.rangeReviewRequired ? '请在“同步与保存”中确认同步范围，并关闭范围提醒。' : 'Web 预览不会启动 IMA。真实同步请在隔离插件中验收。'); };
      plugin.convertAllVaultPdfFiles = async () => { new Notice('Web 预览不会读取本地 PDF。转换功能请在隔离插件中验收。'); };
      plugin.app.setting = { open: openSettings, openTabById: () => settingsTab.switchTab('scope') };
      const definitions = settingsTab.getSettingDefinitions?.() ?? [];
      if (definitions.length) {
        settingsTab.containerEl.empty();
        for (const definition of definitions) {
          const row = new Setting(settingsTab.containerEl).setName(definition.name);
          definition.render?.(row);
        }
      } else settingsTab.display();
      leaf.view = viewCreator(leaf); leaf.setViewState = async () => {};
      await leaf.view.onOpen();
      if (scenario.id === 'renamed' && (plugin.settings.knowledgeBaseName === '机构研报' || plugin.settings.folderName === '2026年10月')) {
        plugin.sourceNeedsRebind = { reason: 'missing', expectedPath: ['2026年10月'], actualPath: [], message: '演示来源已改名' };
      }
    },
  };
}
