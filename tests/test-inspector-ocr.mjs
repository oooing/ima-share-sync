import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const inspector = require('@firecrawl/pdf-inspector');

const pdfImgPath = 'D:/005OneDrive/OneDrive/FileLibraries/Obsidian_vault/obsidian01/03投资/投资资料收集/机构研报/2026年10月【最新】/261008【更新中】/Goldman Sachs-Yum China Holdings （YUMC.US）： 3Q26 preview： Softer SSSG but store expansion and PH license fee savings sup.pdf';

async function testOcr() {
  console.log('Testing processPdfWithOcr...');
  const bytes = fs.readFileSync(pdfImgPath);
  try {
    const res = await inspector.processPdfWithOcr(bytes);
    console.log('OCR Result keys:', Object.keys(res));
    console.log('PDF Type:', res.pdfType);
    console.log('Markdown length:', (res.markdown || '').length);
    console.log('Snippet:\n', (res.markdown || '').slice(0, 300));
  } catch (err) {
    console.error('OCR Error:', err.message);
  }
}

testOcr();
