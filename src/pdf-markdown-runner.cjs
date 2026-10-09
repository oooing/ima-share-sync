// @ts-check
const fs = require('fs');
const path = require('path');

/**
 * 动态安全加载 @firecrawl/pdf-inspector
 */
function loadInspector() {
  const parser = require('@firecrawl/pdf-inspector-wasm');
  parser.initSync({ module: require('ima-inspector-wasm') });
  return parser;
}

const inspector = loadInspector();

/**
 * @typedef {Object} ConvertTask
 * @property {string} pdfPath
 * @property {string} mdPath
 * @property {string} title
 * @property {boolean} embedPdfLink
 * @property {"all" | "text_only" | "image_only"} scope
 */

/**
 * 格式化 Frontmatter 和 Markdown 内容
 */
function buildMarkdownContent(task, result) {
  const isText = Boolean((result.markdown || '').trim());
  const pdfFileName = path.basename(task.pdfPath);
  const pdfWikiLink = `[[${pdfFileName}]]`;
  const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });

  let header = `---
title: "${task.title.replace(/"/g, '\\"')}"
source_pdf: "${pdfWikiLink}"
converted_date: "${nowStr}"
converter: "ima-speed-sync (Obsidian Plugin)"
pdf_type: "${(result.pdfType || 'unknown').toLowerCase()}"
page_count: ${result.pageCount || 0}
tags:
  - 研报
---

`;

  if (task.embedPdfLink) {
    header += `> [!INFO] 原始研报附件
> 本篇笔记由 **ima-speed-sync (Obsidian 插件)** 自动从 PDF 提取生成。
> 原始 PDF 附件：${pdfWikiLink}

`;
  }

  if (isText) {
    return header + (result.markdown || '').trim() + '\n';
  } else {
    return header + `> [!WARNING] 纯图片扫描件提示
> 本文档源文件为全图片扫描件（共 ${result.pageCount || 0} 页），无内嵌矢量文本。
> 建议直接在支持多模态视觉的阅读器或大模型中查看原始 PDF 附件：${pdfWikiLink}
`;
  }
}

/**
 * 执行单个转换
 */
function processSinglePdf(task) {
  if (!fs.existsSync(task.pdfPath)) {
    return { success: false, skipped: false, error: 'PDF 文件不存在' };
  }

  // 增量检查：如果 md 已经存在且修改时间晚于 pdf，直接跳过
  if (fs.existsSync(task.mdPath)) {
    try {
      const previous = fs.readFileSync(task.mdPath, 'utf8');
      if (!previous.startsWith('---\n') || !previous.includes('converter: "ima-speed-sync (Obsidian Plugin)"') ||
          !previous.includes(`source_pdf: "[[${path.basename(task.pdfPath)}]]"`)) {
        return { success: true, skipped: true, reason: '保护已有非本插件生成的笔记' };
      }
      const pdfStat = fs.statSync(task.pdfPath);
      const mdStat = fs.statSync(task.mdPath);
      if (mdStat.mtimeMs >= pdfStat.mtimeMs && mdStat.size > 20) {
        return { success: true, skipped: true };
      }
    } catch (_) {}
  }

  const bytes = fs.readFileSync(task.pdfPath);
  const result = inspector.processPdf(bytes);
  const isText = result.pdfType === 'TextBased' || result.pdfType === 'Mixed';

  if (task.scope === 'text_only' && !isText) {
    return { success: true, skipped: true, reason: '非文字版，已跳过' };
  }
  if (task.scope === 'image_only' && isText) {
    return { success: true, skipped: true, reason: '非图片版，已跳过' };
  }

  const mdContent = buildMarkdownContent(task, result);
  const dir = path.dirname(task.mdPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(task.mdPath, mdContent, 'utf8');

  return {
    success: true,
    skipped: false,
    pdfType: result.pdfType,
    pageCount: result.pageCount,
    chars: (result.markdown || '').length
  };
}

// Execute the same bundled runner in an Obsidian worker or development CLI.
const { parentPort, workerData } = require("worker_threads");

function runTasks(tasks, report) {
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    try {
      const result = processSinglePdf(task);
      if (result.skipped) skipped++;
      else if (result.success) completed++;
      else { failed++; report({ status: "error", message: task.title + ": " + result.error }); }
    } catch (error) {
      failed++;
      report({ status: "error", message: task.title + ": " + (error instanceof Error ? error.message : String(error)) });
    }
    report({ progress: index + 1, total: tasks.length });
  }
  return { status: "done", completed, skipped, failed };
}

if (parentPort) {
  parentPort.postMessage(runTasks(workerData, (message) => parentPort.postMessage(message)));
  parentPort.close();
}

// CLI 执行入口
if (!parentPort && require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({ error: '请提供参数文件路径' }));
    process.exit(1);
  }

  const inputJsonPath = args[0];
  if (!fs.existsSync(inputJsonPath)) {
    console.log(JSON.stringify({ error: '输入任务文件不存在' }));
    process.exit(1);
  }

  const tasks = JSON.parse(fs.readFileSync(inputJsonPath, 'utf8'));
  console.log(JSON.stringify(runTasks(tasks, (message) => console.log(JSON.stringify(message)))));
}

module.exports = { processSinglePdf, buildMarkdownContent };
