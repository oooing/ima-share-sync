const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const tempTasksFile = 'C:/Users/oooin/AppData/Local/Temp/test_runner_tasks.json';
const outDir = 'C:/Users/oooin/AppData/Local/Temp/test_md_output';

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const tasks = [
  {
    pdfPath: 'C:/Users/oooin/AppData/Local/Temp/ima-e2e-test/downloads/file-62aa0aebcfe54cdc8660537a465b5dd4.pdf',
    mdPath: path.join(outDir, 'Morgan Stanley-Samsung Electronics More Than Memory-261005.md'),
    title: 'Morgan Stanley-Samsung Electronics More Than Memory-261005',
    embedPdfLink: true,
    scope: 'all'
  },
  {
    pdfPath: 'D:/005OneDrive/OneDrive/FileLibraries/Obsidian_vault/obsidian01/03投资/投资资料收集/机构研报/2026年10月【最新】/261008【更新中】/Goldman Sachs-Yum China Holdings （YUMC.US）： 3Q26 preview： Softer SSSG but store expansion and PH license fee savings sup.pdf',
    mdPath: path.join(outDir, 'Goldman Sachs-Yum China Holdings.md'),
    title: 'Goldman Sachs-Yum China Holdings (YUMC.US)',
    embedPdfLink: true,
    scope: 'all'
  }
];

fs.writeFileSync(tempTasksFile, JSON.stringify(tasks, null, 2), 'utf8');

const runnerPath = 'd:/001oooing/WorkPitt/001AIcoding/037ima-share-sync/code/src/pdf-markdown-runner.cjs';
const start = Date.now();
const output = execSync(`node "${runnerPath}" "${tempTasksFile}"`, { encoding: 'utf8' });
console.log(`Executed in ${Date.now() - start}ms! Output:`);
console.log(output);

// 验证输出的 md
const md1 = fs.readFileSync(tasks[0].mdPath, 'utf8');
console.log('--- Sample MD 1 snippet ---\n', md1.slice(0, 500));

const md2 = fs.readFileSync(tasks[1].mdPath, 'utf8');
console.log('--- Sample MD 2 snippet ---\n', md2.slice(0, 500));
