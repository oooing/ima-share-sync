import http from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleIdentity, invalidateLiveIdentity } from './live-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.IMA_WEB_PORT || 17664);
const clients = new Set();
let snapshot = new Map();
let info = { status: 'building' };
let busy = false;
let queued = false;
let timer;
let server;
const watchers = [];

function announce() {
  for (const client of clients) client.write(`data: ${JSON.stringify(info)}\n\n`);
}

export function assetIdentity(files) {
  const hashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  return { hashes, buildId: createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0, 12) };
}

async function refreshSnapshot() {
  const files = Object.fromEntries(await Promise.all(['main.js', 'styles.css', 'manifest.json'].map(async name => [name, await readFile(path.join(root, 'dist', name))])));
  const identity = assetIdentity(files);
  const next = new Map([
    ['/plugin.js', [files['main.js'], 'text/javascript; charset=utf-8']],
    ['/styles.css', [files['styles.css'], 'text/css; charset=utf-8']],
  ]);
  for (const entry of await readdir(path.join(root, 'web'), { withFileTypes: true })) {
    if (!entry.isFile() || /^(server|package|test-)/.test(entry.name) || entry.name.endsWith('.ps1')) continue;
    const type = entry.name.endsWith('.html') ? 'text/html' : entry.name.endsWith('.css') ? 'text/css' : entry.name.endsWith('.json') ? 'application/json' : /\.(md|txt)$/.test(entry.name) ? 'text/plain' : 'text/javascript';
    next.set(`/web/${entry.name}`, [await readFile(path.join(root, 'web', entry.name)), `${type}; charset=utf-8`]);
  }
  next.set('/', next.get('/web/index.html'));
  const revision = createHash('sha256');
  for (const [url, [bytes]] of next) revision.update(url).update(bytes);
  snapshot = next;
  info = { status: 'ready', version: JSON.parse(files['manifest.json']).version,
    ...identity, revision: revision.digest('hex').slice(0, 12), builtAt: new Date().toISOString() };
  await mkdir(path.join(root, '.web'), { recursive: true });
  await writeFile(path.join(root, '.web', 'build.json'), JSON.stringify(info, null, 2));
  announce();
  console.log(`Web ready: http://127.0.0.1:${port} · v${info.version} · ${info.buildId}`);
}

async function build() {
  if (busy) { queued = true; return; }
  busy = true;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['esbuild.config.mjs', 'production'], { cwd: root, stdio: 'inherit', windowsHide: true });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build exited with ${code}`)));
    });
    await refreshSnapshot();
    invalidateLiveIdentity();
  } catch (error) {
    info = { ...info, status: 'error', error: error.message }; announce();
    console.error(error.message);
    if (!snapshot.size) throw error;
  } finally {
    busy = false;
    if (queued) { queued = false; scheduleBuild(); }
  }
}

function scheduleBuild() { clearTimeout(timer); timer = setTimeout(() => void build(), 180); }

async function start() {
  await build();
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (pathname === '/api/identity') { void handleIdentity(req,res); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (pathname === '/api/build') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(info)); return; }
    if (pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      clients.add(res); res.write(`data: ${JSON.stringify(info)}\n\n`);
      req.on('close', () => clients.delete(res)); return;
    }
    const file = snapshot.get(pathname);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    res.writeHead(200, { 'Content-Type': file[1] }); res.end(req.method === 'HEAD' ? undefined : file[0]);
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; shutdown(); });
  server.listen(port, '127.0.0.1');
  for (const folder of ['src', 'scripts', 'web']) watchers.push(watch(path.join(root, folder), { recursive: true }, (_type, file) => {
    if (file && !file.endsWith('.tmp')) scheduleBuild();
  }));
  watchers.push(watch(root, (_type, file) => { if (['styles.css', 'manifest.json', 'esbuild.config.mjs'].includes(file)) scheduleBuild(); }));
}

function shutdown() { clearTimeout(timer); for (const watcher of watchers) watcher.close(); for (const client of clients) client.end(); server?.close(); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  await start().catch(error => { console.error(error); process.exitCode = 1; });
}
