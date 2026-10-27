import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";
import { build } from "esbuild";
import { bundleMarkdownRunner } from "../scripts/markdown-runner-build.mjs";
import { embeddedWasmPlugin } from "../scripts/inspector-wasm-build.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib");
const compiled = await build({ entryPoints: ["src/pdf-to-markdown.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
const module = new Module(path.resolve("tests/markdown-test.cjs"));
module.filename = path.resolve("tests/markdown-test.cjs");
module._compile(compiled.outputFiles[0].text, module.filename);
const { runMarkdownConversion } = module.exports;
// Verify the compressed production asset restores the exact upstream WASM,
// not only that one PDF fixture happens to convert.
const wasmCompiled = await build({
  stdin: { contents: 'module.exports = require("ima-inspector-wasm").default;', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs",
  plugins: [embeddedWasmPlugin()],
});
const wasmModule = new Module(path.resolve("tests/wasm-roundtrip.cjs"));
wasmModule.filename = path.resolve("tests/wasm-roundtrip.cjs");
wasmModule._compile(wasmCompiled.outputFiles[0].text, wasmModule.filename);
assert.deepEqual(Buffer.from(wasmModule.exports), await readFile(require.resolve("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm")));
const directCompiled = await build({
  entryPoints: ["src/pdf-markdown-core.ts"], bundle: true, write: false,
  platform: "browser", format: "cjs", target: "es2022", external: ["fs", "path", "zlib", "buffer"],
  plugins: [embeddedWasmPlugin()],
});
const directModule = new Module(path.resolve("tests/markdown-direct-test.cjs"));
directModule.filename = path.resolve("tests/markdown-direct-test.cjs");
directModule._compile(directCompiled.outputFiles[0].text, directModule.filename);
const { processSinglePdf } = directModule.exports;
const runner = await bundleMarkdownRunner();
const directory = await mkdtemp(path.join(tmpdir(), "ima-markdown-test-"));
const previousPath = process.env.PATH;
try {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Portable local PDF extraction", { x: 40, y: 700, font, size: 20 });
  const pdfPath = path.join(directory, "sample.pdf");
  const mdPath = path.join(directory, "sample.md");
  await writeFile(pdfPath, await pdf.save());
  const task = { pdfPath, mdPath, title: "Portable extraction", embedPdfLink: true, scope: "all" };
  // The packaged runner must work with no system Node.js lookup or node_modules.
  process.env.PATH = "";
  assert.deepEqual(await runMarkdownConversion([task], runner), { completed: 1, skipped: 0, failed: 0 });
  const markdown = await readFile(mdPath, "utf8");
  assert.match(markdown, /Portable local PDF extraction/);
  assert.match(markdown, /\[\[sample\.pdf\]\]/);
  assert.deepEqual(await runMarkdownConversion([task], runner), { completed: 0, skipped: 1, failed: 0 });
  await writeFile(mdPath, "My manually authored research note");
  assert.deepEqual(await runMarkdownConversion([task], runner), { completed: 0, skipped: 1, failed: 0 });
  assert.equal(await readFile(mdPath, "utf8"), "My manually authored research note");
  await rm(mdPath);
  assert.deepEqual(await runMarkdownConversion([{ ...task, scope: "image_only" }], runner), { completed: 0, skipped: 1, failed: 0 });
  await writeFile(pdfPath, "%PDF-1.4\ninvalid fixture\n%%EOF");
  assert.deepEqual(await runMarkdownConversion([task], runner), { completed: 0, skipped: 0, failed: 1 });
  await assert.rejects(stat(mdPath), { code: "ENOENT" });
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(runMarkdownConversion([task], runner, undefined, canceled.signal), /取消/);
  const running = new AbortController();
  const pending = runMarkdownConversion([task], "setInterval(() => {}, 100);", undefined, running.signal);
  setTimeout(() => running.abort(), 100);
  await assert.rejects(pending, /取消/);
  await assert.rejects(runMarkdownConversion([task], 'throw new Error("runner fixture failure");'), /runner fixture failure/);
  // Exercise the same direct processor wired into the Obsidian plugin, with
  // real fixture bytes and no system Node/dependency lookup.
  await writeFile(pdfPath, await pdf.save());
  const directPath = path.join(directory, "direct.md");
  const directTask = { ...task, mdPath: directPath };
  const progress = [];
  const convertDirect = (tasks, onProgress, signal) =>
    runMarkdownConversion(tasks, "", onProgress, signal, processSinglePdf);
  assert.deepEqual(await convertDirect([directTask], (current, total) => progress.push([current, total])), { completed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(progress, [[1, 1]]);
  assert.match(await readFile(directPath, "utf8"), /Portable local PDF extraction/);
  assert.match(await readFile(directPath, "utf8"), /\[\[sample\.pdf\]\]/);
  assert.deepEqual(await convertDirect([directTask]), { completed: 0, skipped: 1, failed: 0 });
  await writeFile(directPath, "My authored note must remain intact");
  assert.deepEqual(await convertDirect([directTask]), { completed: 0, skipped: 1, failed: 0 });
  assert.equal(await readFile(directPath, "utf8"), "My authored note must remain intact");
  await rm(directPath);
  assert.deepEqual(await convertDirect([{ ...directTask, scope: "image_only" }]), { completed: 0, skipped: 1, failed: 0 });
  const nextPath = path.join(directory, "after-cancel.md");
  const directCancel = new AbortController();
  await assert.rejects(convertDirect([directTask, { ...directTask, mdPath: nextPath }], () => directCancel.abort(), directCancel.signal), /取消/);
  await assert.rejects(stat(nextPath), { code: "ENOENT" });
  await assert.rejects(convertDirect([directTask], undefined, canceled.signal), /取消/);
  await rm(directPath);
  await writeFile(pdfPath, "%PDF-1.4\ninvalid fixture\n%%EOF");
  assert.deepEqual(await convertDirect([directTask]), { completed: 0, skipped: 0, failed: 1 });
  await assert.rejects(stat(directPath), { code: "ENOENT" });
  console.log("PASS: bundled direct WASM conversion, progress, scopes, incremental skip, authored-note protection, invalid PDF and cancellation between files");
  console.log("PASS: standalone WASM PDF conversion without system Node or project dependencies; text, scope, incremental skip, authored-note protection, invalid PDF, cancellation and worker errors");
} finally {
  process.env.PATH = previousPath;
  await rm(directory, { recursive: true, force: true });
}
