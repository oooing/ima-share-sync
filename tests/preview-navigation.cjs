// Local-only visual fixture: renders the actual compiled plugin with synthetic data.
// Never reads a vault or starts IMA. Run after npm run build.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const routes = {
  '/': ['navigation-fixture.html', 'text/html; charset=utf-8'],
  '/plugin.js': ['../dist/main.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['../dist/styles.css', 'text/css; charset=utf-8'],
};
http.createServer((req, res) => {
  const route = routes[req.url];
  if (!route) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(__dirname, route[0])));
}).listen(1429, '127.0.0.1', () => console.log('Navigation fixture: http://127.0.0.1:1429 (no desktop automation)'));
