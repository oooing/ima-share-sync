import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const inspector = require('@firecrawl/pdf-inspector');

// 1. 测试原生文字版研报（大摩三星）
const pdfTextPath = 'C:/Users/oooin/AppData/Local/Temp/ima-e2e-test/downloads/file-62aa0aebcfe54cdc8660537a465b5dd4.pdf';
if (fs.existsSync(pdfTextPath)) {
  console.log('--- Testing Morgan Stanley Samsung (20 pages, text) ---');
  const bytes = fs.readFileSync(pdfTextPath);
  const start = Date.now();
  const res = inspector.processPdf(bytes);
  const elapsed = Date.now() - start;
  console.log(`Finished in ${elapsed} ms!`);
  console.log('Result type:', typeof res);
  console.log('Keys:', Object.keys(res));
  console.log('PDF Type:', res.pdfType);
  console.log('Markdown length:', (res.markdown || '').length);
  console.log('\n--- Markdown snippet (first 800 chars) ---\n');
  console.log((res.markdown || '').slice(0, 800));
}

// 2. 测试纯图片版研报（高盛百胜中国）
const pdfImgPath = 'D:/005OneDrive/OneDrive/FileLibraries/Obsidian_vault/obsidian01/03投资/投资资料收集/机构研报/2026年10月【最新】/261008【更新中】/Goldman Sachs-Yum China Holdings （YUMC.US）： 3Q26 preview： Softer SSSG but store expansion and PH license fee savings sup.pdf';
if (fs.existsSync(pdfImgPath)) {
  console.log('\n--- Testing Goldman Sachs Yum China (10 pages, scanned) ---');
  const bytes = fs.readFileSync(pdfImgPath);
  const start = Date.now();
  const res = inspector.processPdf(bytes);
  const elapsed = Date.now() - start;
  console.log(`Finished in ${elapsed} ms!`);
  console.log('PDF Type:', res.pdfType);
  console.log('Markdown length:', (res.markdown || '').length);
}
