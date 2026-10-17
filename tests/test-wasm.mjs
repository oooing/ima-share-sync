import fs from 'fs';
import path from 'path';
import init, { processPdf } from '@firecrawl/pdf-inspector-wasm';

const wasmPath = 'd:/001oooing/WorkPitt/001AIcoding/037ima-share-sync/code/node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm';
const wasmBuffer = fs.readFileSync(wasmPath);

await init({ module_or_path: wasmBuffer });

const pdfTextPath = 'C:/Users/oooin/AppData/Local/Temp/ima-e2e-test/downloads/file-62aa0aebcfe54cdc8660537a465b5dd4.pdf';
const bytes = fs.readFileSync(pdfTextPath);

const start = Date.now();
const result = processPdf(new Uint8Array(bytes));
const elapsed = Date.now() - start;

console.log(`WASM Processed in ${elapsed}ms!`);
console.log('PDF Type:', result.pdfType);
console.log('Markdown length:', (result.markdown || '').length);
console.log('Snippet:\n', (result.markdown || '').slice(0, 400));
