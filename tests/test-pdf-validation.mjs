import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import { pdfWorkerPlugin } from "../scripts/pdf-worker-build.mjs";
const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFRef } = require("pdf-lib");

const root = fileURLToPath(new URL("..", import.meta.url));
const built = await esbuild.build({
  entryPoints: [path.join(root, "src/pdf-validation.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", target: "node20", external: ["worker_threads"],
  plugins: [pdfWorkerPlugin()],
});
const workers = [];
let workerFault;
let afterConstruct;
class TrackedWorker extends Worker {
  constructor(...args) {
    if (workerFault) args[0] = workerFault;
    super(...args);
    workers.push(this);
    afterConstruct?.();
  }
}
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  if (name === "worker_threads") return { Worker: TrackedWorker };
  return originalLoad.call(this, name, ...rest);
};
const compiled = new Module(path.join(root, "tests/pdf-validation-test-bundle.cjs"));
compiled.filename = path.join(root, "tests/pdf-validation-test-bundle.cjs");
compiled.paths = Module._nodeModulePaths(root);
try { compiled._compile(built.outputFiles[0].text, compiled.filename); }
finally { Module._load = originalLoad; }
const { validatePdfStructure } = compiled.exports;
const checkStopped = () => assert.ok(workers.every(worker => worker.threadId === -1), "every completed, rejected, canceled or timed-out worker is terminated");

async function fixture(pages = 1, options = {}) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) doc.addPage([600, 800]).drawText(`IMA validation fixture ${index + 1}`);
  return doc.save(options);
}

const valid = await fixture(2);
assert.equal(await validatePdfStructure(valid), 2);
checkStopped();
assert.equal(await validatePdfStructure(await fixture(1, { useObjectStreams: false })), 1);
checkStopped();

const fake = Buffer.alloc(53, 32);
fake.write("%PDF-1.4\n");
fake.write("%%EOF\n", fake.length - 6);
await assert.rejects(validatePdfStructure(fake), /结构校验失败/);
await assert.rejects(validatePdfStructure(Buffer.from("<html>error</html>")), /结构校验失败/);
await assert.rejects(validatePdfStructure(await fixture(0, { addDefaultPage: false })), /没有可读取的页面/);
await assert.rejects(validatePdfStructure(valid.subarray(0, Math.floor(valid.length / 2))), /结构校验失败/);
checkStopped();

const broken = await PDFDocument.create();
broken.addPage();
broken.catalog.Pages().Kids().push(PDFRef.of(999999));
await assert.rejects(validatePdfStructure(await broken.save()), /页面树引用缺失或无效/);
const cyclic = await PDFDocument.create();
cyclic.addPage();
cyclic.catalog.Pages().Kids().push(cyclic.catalog.get(PDFName.of("Pages")));
await assert.rejects(validatePdfStructure(await cyclic.save()), /页面树循环/);
const encrypted = await PDFDocument.create();
encrypted.addPage();
encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: "Standard" }));
await assert.rejects(validatePdfStructure(await encrypted.save()), /encrypted/);
checkStopped();

const alreadyAborted = new AbortController();
alreadyAborted.abort();
const beforeAbort = workers.length;
await assert.rejects(validatePdfStructure(valid, { signal: alreadyAborted.signal }), /已取消/);
assert.equal(workers.length, beforeAbort, "already-aborted validation does not start a worker");
const controller = new AbortController();
const pending = validatePdfStructure(valid, { signal: controller.signal });
controller.abort();
await assert.rejects(pending, /已取消/);
await assert.rejects(validatePdfStructure(valid, { timeoutMs: 0 }), /超时/);
checkStopped();
workerFault = "throw new Error('fixture worker error')";
await assert.rejects(validatePdfStructure(valid), /进程异常/);
workerFault = "process.exit(0)";
await assert.rejects(validatePdfStructure(valid), /提前退出/);
const racingController = new AbortController();
workerFault = "throw new Error('fixture worker error after cancellation')";
afterConstruct = () => racingController.abort();
await assert.rejects(validatePdfStructure(valid, { signal: racingController.signal }), /已取消/);
workerFault = undefined;
afterConstruct = undefined;
checkStopped();

// Electron renderer fallback tests (process.type === 'renderer')
process.type = "renderer";
const rendererWorkersCount = workers.length;
assert.equal(await validatePdfStructure(valid), 2, "renderer fallback correctly inspects valid PDF");
assert.equal(workers.length, rendererWorkersCount, "renderer mode does not launch Node worker_threads");
await assert.rejects(validatePdfStructure(fake), /结构校验失败/);
await assert.rejects(validatePdfStructure(await broken.save()), /页面树引用缺失或无效/);
await assert.rejects(validatePdfStructure(await cyclic.save()), /页面树循环/);
await assert.rejects(validatePdfStructure(await encrypted.save()), /encrypted/);
await assert.rejects(validatePdfStructure(valid, { signal: alreadyAborted.signal }), /已取消/);
await assert.rejects(validatePdfStructure(valid, { timeoutMs: 0 }), /超时/);
delete process.type;

// Worker constructor failure fallback test (e.g. V8 platform does not support creating Workers)
class ThrowingWorker {
  constructor() {
    throw new Error("Failed to construct 'Worker': The V8 platform used by this instance of Node does not support creating Workers");
  }
}
Module._load = function (name, ...rest) {
  if (name === "worker_threads") return { Worker: ThrowingWorker };
  return originalLoad.call(this, name, ...rest);
};
const compiledFallback = new Module(path.join(root, "tests/pdf-validation-test-bundle-fallback.cjs"));
compiledFallback.filename = path.join(root, "tests/pdf-validation-test-bundle-fallback.cjs");
compiledFallback.paths = Module._nodeModulePaths(root);
try { compiledFallback._compile(built.outputFiles[0].text, compiledFallback.filename); }
finally { Module._load = originalLoad; }
const { validatePdfStructure: validateWithConstructorFailure } = compiledFallback.exports;
assert.equal(await validateWithConstructorFailure(valid), 2, "fallback gracefully handles worker constructor failure");
await assert.rejects(validateWithConstructorFailure(fake), /结构校验失败/);

// Optional local-only compatibility check. Never copies or commits private PDFs.
const compatDirectory = process.env.IMA_PDF_COMPAT_DIR;
if (compatDirectory) {
  let checked = 0;
  let pages = 0;
  const started = Date.now();
  const pending = [compatDirectory];
  while (pending.length) {
    const directory = pending.pop();
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, file.name);
      if (file.isDirectory()) pending.push(filePath);
      else if (file.isFile() && file.name.toLowerCase().endsWith(".pdf")) {
        pages += await validatePdfStructure(await readFile(filePath));
        checked++;
      }
    }
  }
  checkStopped();
  console.log(`PASS: local PDF compatibility: ${checked} files, ${pages} pages, ${Date.now() - started} ms; original files unchanged`);
}
console.log(`PASS: PDF page-tree validation, real compressed/classic PDF fixtures, fake/truncated/empty/broken/cyclic/encrypted rejection, cancellation, timeout; ${workers.length} workers terminated`);
