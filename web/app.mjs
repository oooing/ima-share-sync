import { createScenario, scenarios, storageKey } from './scenarios.mjs';
import { installHost, requestNativeIdentity } from './obsidian-host.mjs';

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const scenarioId = scenarios.some(s => s.id === params.get('scenario')) ? params.get('scenario') : 'configured';
const scenario = createScenario(scenarioId);
if (scenarioId === 'live') {
 scenario.nativeIdentity = requestNativeIdentity;
 document.querySelector('.web-context').textContent='已连接真实 IMA 来源 · 设置保存在浏览器 · 同步在插件中执行';
}
const metadata = await fetch('/api/build').then(r => r.json());
const icons = await fetch('/web/icons.json').then(r => r.json());
let host;
$('#reset').addEventListener('click', () => { localStorage.removeItem(storageKey(scenarioId)); location.reload(); });

function showSurface(surface) {
  $('#settings').hidden = surface === 'home'; $('#home').hidden = surface !== 'home';
  $('#surface').textContent = surface === 'home' ? '设置' : '同步面板';
  $('#surface').dataset.surface = surface;
  sessionStorage.setItem('ima-web-surface', surface);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme !== 'dark');
  $('#theme').textContent = theme === 'dark' ? '浅色' : '深色';
  $('#theme').setAttribute('aria-label', theme === 'dark' ? '切换浅色外观' : '切换深色外观');
  localStorage.setItem('ima-web-theme', theme);
}

function showState() {
  const modal = new host.obsidian.Modal(host.plugin.app);
  modal.titleEl.textContent = '测试状态';
  const snapshot = host.snapshot();
  modal.contentEl.createEl('pre', { text: JSON.stringify({
    version: metadata.version, buildId: metadata.buildId, scenario: scenarioId,
    persistedSettings: snapshot.savedData, sourceCalls: snapshot.calls, errors: snapshot.errors,
  }, null, 2), cls: 'web-state' });
  const close = modal.contentEl.createEl('button', { text: '关闭', attr: { type: 'button' } });
  close.addEventListener('click', () => modal.close()); modal.open();
}

try {
  host = installHost({ scenario, metadata, icons, storage: localStorage });
  await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/plugin.js';
    script.onload = resolve; script.onerror = () => reject(new Error('插件界面加载失败')); document.head.append(script);
  });
  await host.start(() => showSurface('settings'));
  host.settingsTab.switchTab(['stats','scope','markdown','notifications','general'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'scope');
  $('#settings').addEventListener('click', event => {
    const button = event.target.closest('.ima-settings-tab-btn');
    if (button) {
      const tabs = [...document.querySelectorAll('.ima-settings-tab-btn')];
      history.replaceState(null, '', `${location.pathname}${location.search}#${['stats','scope','markdown','notifications','general'][tabs.indexOf(button)]}`);
    }
  });
  $('#scenario').replaceChildren(...scenarios.map(s => new Option(s.name, s.id, false, s.id === scenarioId)));
  $('#scenario').addEventListener('change', event => { location.href = `/?scenario=${event.target.value}${location.hash || '#scope'}`; });
  $('#surface').addEventListener('click', () => showSurface($('#surface').dataset.surface === 'home' ? 'settings' : 'home'));
  $('#theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#inspect').addEventListener('click', showState);
  $('#build-label').textContent = `v${metadata.version} · ${metadata.buildId}`;
  $('#build-label').dataset.buildId = metadata.buildId;
  $('#reload').addEventListener('click', () => location.reload());
  showSurface(sessionStorage.getItem('ima-web-surface') || 'settings');
  applyTheme(localStorage.getItem('ima-web-theme') || 'light');
  const stream = new EventSource('/events');
  stream.onmessage = event => {
    const next = JSON.parse(event.data);
    if (next.status === 'error') {
      $('#reload-banner').hidden = false;
      $('#reload-banner span').textContent = `构建失败，保留上一版：${next.error}`;
    } else if (next.revision !== metadata.revision) {
      const editing = document.querySelector('dialog[open]') || document.querySelector('.ima-scope-footer')?.textContent.includes('未保存');
      if (editing) { $('#reload-banner').hidden = false; $('#reload-banner span').textContent = '有新构建，完成当前编辑后刷新。'; }
      else location.reload();
    } else $('#reload-banner').hidden = true;
  };
  window.webPreview = Object.freeze({ snapshot: host.snapshot, build: Object.freeze(metadata) });
  document.documentElement.dataset.webReady = 'true';
} catch (error) {
  if (host) host.reportError(error);
  else { $('#fixture-error').hidden = false; $('#fixture-error').textContent = error.message; }
}
