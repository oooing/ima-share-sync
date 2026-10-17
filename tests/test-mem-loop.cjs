const fs = require('fs');
const { initSync, processPdf } = require('@firecrawl/pdf-inspector-wasm');
const wasmBytes = fs.readFileSync(require.resolve('@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm'));
initSync({ module: wasmBytes });

const pdfPath = 'D:/005OneDrive/OneDrive/FileLibraries/Obsidian_vault/obsidian01/03投资/投资资料收集/机构研报/2026年10月【最新】/261012/Goldman Sachs-China FX Rates Monitor： Measured Easing， Resilient CNY and Low Rates-261011.pdf';
const bytes = fs.readFileSync(pdfPath);

console.log('Testing 10 iterations...');
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  const res = processPdf(new Uint8Array(bytes));
  console.log(`Iter ${i+1}: type=${res.pdfType}, pages=${res.pageCount}, time=${Date.now() - t0}ms, heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB, rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
}
