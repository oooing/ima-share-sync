export interface FormatTask { pdfPath: string; title: string; embedPdfLink: boolean }
export interface PdfTextResult { markdown?: string; pdfType?: string; pageCount?: number }

export function buildMarkdownContent(task: FormatTask, result: PdfTextResult): string {
  const isText = Boolean((result.markdown || '').trim());
  const pdfFileName = task.pdfPath.replace(/\\/g, "/").split("/").pop() ?? "";
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
