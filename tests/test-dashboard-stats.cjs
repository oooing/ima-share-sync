const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const path = require('node:path');
process.env.TZ = 'Asia/Shanghai';
const m = new Module(path.resolve('tests/stats-memory.cjs'));
m.filename = path.resolve('tests/stats-memory.cjs');
m._compile(ts.transpileModule(fs.readFileSync('src/dashboard-stats.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, m.filename);
const { calculateDashboardStats, localDateKey, restoreMetrics } = m.exports;
const now = new Date('2026-10-10T00:30:00+08:00');
assert.equal(localDateKey(now), '2026-10-10');
const file = (p, size) => ({path:p, extension:p.split('.').pop(), stat:{size}});
const report = (status, checked, saved, date=now) => ({status, finishedAt:+date, destination:'A/B', metrics:{checked,saved}});
const records = [report('success',7,2),report('failed',5,0),report('canceled',0,0),
  {status:'success',finishedAt:+now},
  {...report('success',30,30),destination:'Elsewhere'},
  report('failed',2,1,new Date('2026-10-09T00:30:00+08:00'))];
const stats = calculateDashboardStats([file('A/B/a.md',1024),file('A/B/sub/b.pdf',2048),file('A/Backup/a.md',4096)], records, 'A\\B', now);
assert.equal(stats.files,2);
assert.equal(stats.markdown,1);
assert.equal(stats.bytes,3072);
assert.equal(stats.checked,14);
assert.equal(stats.saved,3);
assert.deepEqual(stats.dateMap,{'2026-10-10':2,'2026-10-09':1});
assert.equal(stats.streak,2);
assert.equal(stats.successRate,'33.3');
const noSaves = calculateDashboardStats([], [report('failed',7,0),report('canceled',0,0)], 'A/B', now);
assert.equal(noSaves.saved,0);
assert.equal(noSaves.streak,0);
assert.deepEqual(noSaves.dateMap,{});
assert.equal(calculateDashboardStats([],[], 'A/B').successRate,null);
assert.equal(restoreMetrics({checked:1,saved:2}),undefined);
assert.equal(calculateDashboardStats([file('A/B/a.md',1)],[], 'A/B',now).streak,0);
console.log('PASS: actual scoped file/count statistics, legacy records, failures, local dates and streaks');
