"use strict";
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const cardSource = fs.readFileSync(path.join(__dirname, "../src/operation-card.ps1"), "utf8");
const iconSource = fs.readFileSync(path.join(__dirname, "../src/icon.ts"), "utf8");
for (const [, geometry] of iconSource.matchAll(/<path d="([^"]+)"/g)) {
  assert.ok(cardSource.includes(`Data="${geometry}"`), "desktop card must reuse toolbar path geometry");
}
for (const [, x, y, rx, ry] of iconSource.matchAll(/<ellipse cx="([^"]+)" cy="([^"]+)" rx="([^"]+)" ry="([^"]+)"/g)) {
  assert.ok(cardSource.includes(`Center="${x},${y}" RadiusX="${rx}" RadiusY="${ry}"`), "desktop card must reuse panda facial proportions");
}
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ima-card-preview-"));
const script = path.join(outputDir, "card.ps1");
fs.writeFileSync(script, "\ufeff" + cardSource);
const result = execFileSync("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script,
  "-OwnerProcessId", String(process.pid), "-PreviewPath", outputDir], { encoding: "utf8", windowsHide: true, timeout: 30000 });
for (const state of ["before", "running", "stopping", "success", "failed", "failed-details"]) {
  const png = fs.readFileSync(path.join(outputDir, state + ".png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 340);
  assert.ok(png.readUInt32BE(20) >= 120 && png.readUInt32BE(20) < 320);
}
assert.ok(result.includes("PASS:"));
console.log(result.trim());
console.log("Native preview images: " + outputDir);

if (process.argv.includes("--live")) {
  const statePath = path.join(outputDir, "state.json");
  const update = (phase, text) => {
    const pending = statePath + ".pending";
    fs.writeFileSync(pending, JSON.stringify({ phase, text }));
    fs.renameSync(pending, statePath);
  };
  const manual = process.argv.includes("--manual");
  update(manual ? "running" : "before", "界面验收演示，不操作 IMA。");
  const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script,
    "-OwnerProcessId", String(process.pid), "-StatePath", statePath, "-SmokeTest"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let transcript = "";
  let errors = "";
  let readyAt = 0;
  let startedAt = 0;
  const guard = setTimeout(() => { child.kill(); console.error("FAIL: native window did not complete within 25 seconds"); process.exitCode = 1; }, 25000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    transcript += data;
    if (!readyAt && /(?:^|\r?\n)ready\r?\n/.test(transcript)) readyAt = Date.now();
    if (!startedAt && /(?:^|\r?\n)start\r?\n/.test(transcript)) {
      startedAt = Date.now();
      update("running", "界面验收演示：正在检查第 3 / 7 篇文章（模拟）。");
      setTimeout(() => update("success", "界面验收完成，没有操作 IMA 或修改文章。"), 1200);
    }
  });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  child.on("close", (code) => {
    clearTimeout(guard);
    try {
      assert.equal(code, 0, errors);
      assert.ok(transcript.includes("nonactivating"), "window must not take foreground focus");
      assert.ok(!transcript.includes("focus-stolen"));
      assert.ok(readyAt && startedAt, "window must acknowledge ready and start");
      if (manual) assert.ok(startedAt - readyAt < 1000, "manual sync starts without a countdown after the card is visible");
      else assert.ok(startedAt - readyAt >= 4700, "automatic countdown must start after the card becomes visible");
      assert.ok(Date.now() - startedAt >= 6000, "completion should remain visible for five seconds");
      console.log(`PASS: real desktop window, no focus steal, ${manual ? "immediate manual start" : "5-second automatic countdown"}, completion auto-close and clean process exit`);
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
