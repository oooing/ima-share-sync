import * as fs from "fs";
import * as path from "path";
import { initSync, processPdf } from "@firecrawl/pdf-inspector-wasm";
import wasmBinary from "ima-inspector-wasm";
import { buildMarkdownContent } from "./pdf-markdown-format";
import type { ConvertTask, SinglePdfResult } from "./pdf-to-markdown";

let inspectorLoaded = false;

function ensureInspector(): void {
  if (inspectorLoaded) return;
  initSync({ module: wasmBinary });
  inspectorLoaded = true;
}

/**
 * 转换单个 PDF 文件的核心业务逻辑。
 * 零 eval / 零 new Function / 零外部子进程，直接在当前 Node/Electron 环境运行。
 */
export function processSinglePdf(task: ConvertTask): SinglePdfResult {
  if (!fs.existsSync(task.pdfPath)) {
    return { success: false, skipped: false, error: "PDF 文件不存在" };
  }

  // 增量检查：若 Markdown 已存在且修改时间晚于 PDF，则安全跳过
  if (fs.existsSync(task.mdPath)) {
    try {
      const previous = fs.readFileSync(task.mdPath, "utf8");
      if (
        !previous.startsWith("---\n") ||
        !previous.includes('converter: "ima-speed-sync (Obsidian Plugin)"') ||
        !previous.includes(`source_pdf: "[[${path.basename(task.pdfPath)}]]"`)
      ) {
        return { success: true, skipped: true, error: "保护已有非本插件生成的笔记" };
      }
      const pdfStat = fs.statSync(task.pdfPath);
      const mdStat = fs.statSync(task.mdPath);
      if (mdStat.mtimeMs >= pdfStat.mtimeMs && mdStat.size > 20) {
        return { success: true, skipped: true };
      }
    } catch {
      // 容错处理：读取失败时允许继续尝试转换
    }
  }

  try {
    ensureInspector();
    const bytes = fs.readFileSync(task.pdfPath);
    const result = processPdf(new Uint8Array(bytes));
    const isText = result.pdfType === "TextBased" || result.pdfType === "Mixed";

    if (task.scope === "text_only" && !isText) {
      return { success: true, skipped: true, error: "非文字版，已跳过" };
    }
    if (task.scope === "image_only" && isText) {
      return { success: true, skipped: true, error: "非图片版，已跳过" };
    }

    const mdContent = buildMarkdownContent(task, result);
    const destinationDir = path.dirname(task.mdPath);
    if (!fs.existsSync(destinationDir)) {
      fs.mkdirSync(destinationDir, { recursive: true });
    }
    fs.writeFileSync(task.mdPath, mdContent, "utf8");

    return {
      success: true,
      skipped: false,
    };
  } catch (error) {
    return {
      success: false,
      skipped: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
