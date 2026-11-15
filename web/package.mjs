import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assetIdentity } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const info = JSON.parse(await readFile(path.join(root, '.web', 'build.json'), 'utf8').catch(() => { throw new Error('先运行 npm run dev:web 并验收当前 Web 构建。'); }));
const files = Object.fromEntries(await Promise.all(['main.js','styles.css','manifest.json'].map(async name => [name, await readFile(path.join(root,'dist',name))])));
const identity = assetIdentity(files);
if (info.status !== 'ready' || identity.buildId !== info.buildId) throw new Error('dist 与 Web 已加载的构建不一致，请重新验收当前 Web 构建。');
const folder = path.join(root, 'artifacts', `ima-share-sync-${info.version}-${info.buildId}`);
await mkdir(folder, {recursive:true});
for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(folder,name), bytes);
await writeFile(`${folder}.json`, JSON.stringify({version:info.version,buildId:info.buildId,hashes:identity.hashes,packagedAt:new Date().toISOString(),note:'Same assets served by Web preview. Native Obsidian and IMA acceptance is separate.'},null,2));
if (process.platform === 'win32') {
  await new Promise((resolve,reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'web','pack.ps1'),'-Source',folder,'-Destination',`${folder}.zip`],{stdio:'inherit',windowsHide:true});
    child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error(`Archive failed: ${code}`)));
  });
}
console.log(`Plugin package: ${folder}${process.platform==='win32'?'.zip':''}`);
console.log('Existing Obsidian installation and data.json were not touched.');
