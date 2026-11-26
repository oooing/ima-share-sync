import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { inspectPdf, processSinglePdf } from "./pdf-markdown-core";
import { buildMarkdownContent } from "./pdf-markdown-format";
import type { ConvertTask, SinglePdfResult } from "./pdf-to-markdown";

export const OCR_MODELS = {
  api: "PaddleOCR-VL-1.6",
  local: "PaddleOCR-VL-1.6",
  "local-mobile": "PP-OCRv5 mobile",
} as const;
export type OcrProvider = keyof typeof OCR_MODELS;
export type LocalOcrMode = Exclude<OcrProvider, "api">;

export function isOcrProvider(value: unknown): value is OcrProvider {
  return value === "api" || value === "local" || value === "local-mobile";
}
export interface OcrPage { page: number; markdown: string }
export interface OcrRequest { pdfPath: string; pages: number[]; pageCount: number; signal?: AbortSignal }
export type OcrRecognizer = (request: OcrRequest) => Promise<OcrPage[]>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

/** Only the exact legacy scan placeholder is eligible for an OCR upgrade. */
export function isLegacyScanPlaceholder(text: string): boolean {
  const body = bodyOf(text).trim().replace(/^> \[!INFO\] 原始研报附件\r?\n> 本篇笔记由 \*\*ima-speed-sync \(Obsidian 插件\)\*\* 自动从 PDF 提取生成。\r?\n> 原始 PDF 附件：\[\[[^\r\n]+\]\]\r?\n\r?\n/, "");
  return /^> \[!WARNING\] 纯图片扫描件提示\r?\n> 本文档源文件为全图片扫描件（共 \d+ 页），无内嵌矢量文本。\r?\n> 建议直接在支持多模态视觉的阅读器或大模型中查看原始 PDF 附件：\[\[[^\r\n]+\]\]$/.test(body);
}

export function formatOcrPage(page: OcrPage, pdfName: string): string {
  const original = `[[${pdfName}#page=${page.page}|原文第 ${page.page} 页]]`;
  // Do not leave broken temporary images or model-estimated chart data in notes.
  const markdown = page.markdown.replace(/!\[[^\]]*\]\([^\n]*?\)/g, original)
    .replace(/<img\b[^>]*>/gi, original);
  return `## 第 ${page.page} 页\n\n${original}\n\n${markdown.trim()}`;
}

export async function processPdfWithOcr(
  task: ConvertTask, recognize: OcrRecognizer, provider: OcrProvider, signal?: AbortSignal,
): Promise<SinglePdfResult> {
  if (signal?.aborted) throw new Error("Markdown 转换已被取消");
  try {
    const before = fs.existsSync(task.mdPath) ? fs.readFileSync(task.mdPath, "utf8") : undefined;
    if (before !== undefined) {
      if (!before.startsWith("---\n") || !before.includes('converter: "ima-speed-sync (Obsidian Plugin)"') ||
        !before.includes(`source_pdf: "[[${path.basename(task.pdfPath)}]]"`)) return { success: true, skipped: true };
      const hash = before.match(/^ocr_content_sha256: "([a-f0-9]{64})"$/m)?.[1];
      if (hash && digest(bodyOf(before)) !== hash) return { success: true, skipped: true };
      if (!isLegacyScanPlaceholder(before) && fs.statSync(task.mdPath).mtimeMs >= fs.statSync(task.pdfPath).mtimeMs) {
        return { success: true, skipped: true };
      }
      // Preserve legacy authored content, including edits made before OCR was added.
      if (!hash && !isLegacyScanPlaceholder(before)) return processSinglePdf(task);
    }
    const bytes = fs.readFileSync(task.pdfPath);
    const inspected = inspectPdf(bytes);
    const hasText = inspected.pdfType === "TextBased" || inspected.pdfType === "Mixed";
    if (task.scope === "image_only" && hasText) return { success: true, skipped: true };
    if (task.scope === "text_only") return hasText ? processSinglePdf(task) : { success: true, skipped: true };
    const pages = inspected.pdfType === "TextBased" ? [] : inspected.pagesNeedingOcr.length ? inspected.pagesNeedingOcr :
      inspected.pdfType === "Scanned" || inspected.pdfType === "ImageBased" ?
        Array.from({ length: inspected.pageCount }, (_, i) => i + 1) : [];
    if (!pages.length) return processSinglePdf(task);
    const recognized = await recognize({ pdfPath: task.pdfPath, pages, pageCount: inspected.pageCount, signal });
    if (signal?.aborted) throw new Error("Markdown 转换已被取消");
    const byPage = new Map(recognized.map(p => [p.page, p.markdown]));
    if (recognized.length !== pages.length || byPage.size !== pages.length || pages.some(p => !byPage.get(p)?.trim())) {
      throw new Error("OCR 返回页数不完整，原 PDF 已保留");
    }
    const sections = Array.from({ length: inspected.pageCount }, (_, index) => {
      const page = index + 1;
      return formatOcrPage({ page, markdown: byPage.get(page) ?? inspectPdf(bytes, [page]).markdown ?? "" }, path.basename(task.pdfPath));
    });
    const qualityNote = provider === "local-mobile"
      ? "> [!NOTE] 轻量 OCR · 仅供文字检索\n> 扫描页的表格行列未还原，数字与单位请核对原 PDF。\n\n" : "";
    let output = buildMarkdownContent(task, {
      markdown: qualityNote + sections.join("\n\n"), pdfType: inspected.pdfType, pageCount: inspected.pageCount,
    });
    output = output.replace("\ntags:\n", `\nocr_provider: "${provider}"\nocr_model: "${OCR_MODELS[provider]}"\nocr_content_sha256: "${digest(bodyOf(output))}"\ntags:\n`);
    const now = fs.existsSync(task.mdPath) ? fs.readFileSync(task.mdPath, "utf8") : undefined;
    if (now !== before) return { success: true, skipped: true, error: "笔记在识别期间已修改，保留现有内容" };
    fs.mkdirSync(path.dirname(task.mdPath), { recursive: true });
    fs.writeFileSync(task.mdPath, output, "utf8");
    return { success: true, skipped: false };
  } catch (error) {
    if (signal?.aborted) throw new Error("Markdown 转换已被取消");
    return { success: false, skipped: false, error: error instanceof Error ? error.message : "OCR 失败" };
  }
}
