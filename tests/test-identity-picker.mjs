import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

class Element {
  constructor(tag = 'div', options = {}) {
    this.tagName = tag.toUpperCase(); this.children = []; this.events = {};
    this.text = options.text ?? ''; this.cls = options.cls ?? ''; this.attrs = { ...options.attr };
  }
  createEl(tag, options) { const child = new Element(tag, options); child.parentElement = this; this.children.push(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addClass() {}
  addEventListener(name, action) { this.events[name] = action; }
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name]; }
  removeAttribute(name) { delete this.attrs[name]; }
  get id() { return this.attrs.id; }
  get childElementCount() { return this.children.length; }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll() { return this.all().filter(child => child.attrs['aria-label'] || child.attrs.title); }
}
class Modal {
  constructor() { this.modalEl = new Element(); this.contentEl = this.modalEl.createDiv(); this.titleEl = this.modalEl.createEl('h2'); }
  close() { this.onClose(); }
}
const code = buildSync({ entryPoints: ['src/identity-picker.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] }).outputFiles[0].text;
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(() => ({ Modal, setIcon() {} }), mod, mod.exports);
const { IdentityPicker } = mod.exports;
const base = { id: '10000001', name: '研报库' };
const folder = { id: 'folder_201', name: '十一月', path: [{ id: 'folder_201', name: '十一月' }] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides = {}) {
  let commits = 0, cacheReads = 0, verifies = 0;
  const provider = {
    cachedKnowledgeBases: async () => { cacheReads++; return [base]; },
    cachedFolders: async () => { cacheReads++; return [folder]; },
    listKnowledgeBases: async () => [base], listFolders: async () => [folder],
    resolve: async () => { verifies++; return { knowledgeBase: base, includeSubfolders: true }; },
    ...overrides,
  };
  const picker = new IdentityPicker({}, { provider, profiles: {}, mode: 'knowledge-bases', legacySourceIds: [], commit: async () => { commits++; } });
  return { picker, provider, counts: () => ({ commits, cacheReads, verifies }) };
}
const confirm = picker => picker.contentEl.all().find(el => el.cls === 'mod-cta');
const rows = picker => picker.contentEl.all().filter(el => el.cls === 'ima-picker-option');

test('reselect after source loss starts at library root, never the remembered missing folder', async () => {
  const { picker, provider } = fixture(); let parent = 'not-called';
  picker.options.startAtRoot = true;
  picker.options.profiles[base.id] = { knowledgeBaseId: base.id, folderId: 'folder_deleted', folderPath: ['旧月'], folderPathIds: ['folder_deleted'] };
  provider.listFolders = async (_kb, folderId) => { parent = folderId; return [folder]; };
  await picker.loadBases(); await picker.selectBase(base);
  assert.equal(parent, undefined); assert.equal(picker.folder, undefined);
  assert.deepEqual(picker.folders, [folder]);
});

test('fresh knowledge bases only; no cached rows during load or on failure', async () => {
  const gate = deferred(); const { picker, counts } = fixture({ listKnowledgeBases: () => gate.promise });
  picker.bases = [base];
  const loading = picker.loadBases();
  assert.equal(rows(picker).length, 0); assert.equal(confirm(picker).disabled, true);
  gate.reject(new Error('读取失败，请重试。')); await loading;
  assert.equal(rows(picker).length, 0); assert.equal(confirm(picker).disabled, true);
  assert.match(picker.error, /读取失败/); assert.equal(counts().cacheReads, 0);
});

test('folder load blocks both confirm button and handler until fresh result arrives', async () => {
  const gate = deferred(); const { picker, counts } = fixture({ listFolders: () => gate.promise });
  await picker.loadBases(); const loading = picker.selectBase(base);
  assert.equal(rows(picker).length, 0); assert.equal(confirm(picker).disabled, true);
  await picker.useSelection(); assert.deepEqual(counts(), { commits: 0, cacheReads: 0, verifies: 0 });
  gate.resolve([folder]); await loading;
  assert.equal(rows(picker).length, 1); assert.equal(confirm(picker).disabled, false);
  await picker.useSelection(); assert.deepEqual(counts(), { commits: 1, cacheReads: 0, verifies: 1 });
});

test('each revisit refreshes; failure hides old rows, blocks commit, and retry uses new rows', async () => {
  const { picker, provider, counts } = fixture();
  await picker.loadBases(); await picker.selectBase(base);
  provider.listFolders = async () => { throw new Error('网络不可用，请重试。'); };
  await picker.browse(); assert.equal(rows(picker).length, 0); assert.equal(confirm(picker).disabled, true);
  await picker.useSelection(); assert.equal(counts().commits, 0);
  const next = { id: 'folder_202', name: '十二月', path: [{ id: 'folder_202', name: '十二月' }] };
  provider.listFolders = async () => [next]; await picker.browse();
  assert.deepEqual(picker.folders, [next]); assert.equal(confirm(picker).disabled, false);
  assert.equal(counts().cacheReads, 0);
});

test('empty fresh folder is selectable but failed final verification never commits', async () => {
  const { picker, counts } = fixture({ listFolders: async () => [], resolve: async () => { throw new Error('来源已失效'); } });
  await picker.loadBases(); await picker.selectBase(base);
  assert.equal(confirm(picker).disabled, false);
  await picker.useSelection(); assert.equal(confirm(picker).disabled, true);
  assert.equal(counts().commits, 0); assert.match(picker.error, /来源已失效/);
});
