// Local-only settings preview: actual compiled plugin, synthetic host and in-memory data.
// Run `npm run build` first, then `node tests/preview-settings.cjs`.
// No vault is read or modified; no child process or IMA automation is available.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const routes = new Map([
  ['/', ['settings-fixture.html', 'text/html; charset=utf-8']],
  ['/plugin.js', ['../dist/main.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['../dist/styles.css', 'text/css; charset=utf-8']],
]);

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1:1432').pathname; }
  catch { res.writeHead(400); res.end(); return; }
  const route = routes.get(pathname);
  if (!route) { res.writeHead(404); res.end(); return; }
  try {
    const file = fs.readFileSync(path.resolve(__dirname, route[0]));
    const body = route[0] === 'settings-fixture.html'
      ? Buffer.from(file.toString('utf8').replaceAll('__PLUGIN_VERSION__', JSON.parse(fs.readFileSync(path.resolve(__dirname, '../dist/manifest.json'), 'utf8')).version))
      : file;
    res.writeHead(200, {
      'Content-Type': route[1],
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : `Settings fixture could not load its build output. Run npm run build first. (${error.code || 'read error'})`);
  }
});

server.on('error', (error) => {
  console.error(`Settings fixture failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(1432, '127.0.0.1', () => {
  console.log('Settings fixture: http://127.0.0.1:1432 (legacy settings)');
  console.log('New installation: http://127.0.0.1:1432/?new=1 (no vault or desktop automation)');
});
