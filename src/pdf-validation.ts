const scheduleParserTimeout = setTimeout;
const clearParserTimeout = clearTimeout;

import { Worker } from "worker_threads";
import workerSource from "ima-pdf-worker";
import { inspectPdfStructure } from "./pdf-structure";

interface PdfValidationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function canUseWorkerThreads(): boolean {
  if (typeof window !== "undefined" || typeof document !== "undefined") {
    return false;
  }
  if (typeof process !== "undefined" && ((process as { type?: string }).type === "renderer" || Boolean((process as { versions?: { electron?: string } }).versions?.electron))) {
    return false;
  }
  return typeof Worker === "function";
}

export async function validatePdfStructureDirect(bytes: Uint8Array, options: PdfValidationOptions = {}): Promise<number> {
  if (options.signal?.aborted) throw new Error("PDF 校验已取消。");
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) throw new Error("PDF 校验超时，未保存文件。");
  if (bytes.byteLength <= 0 || bytes.byteLength > 256 * 1024 * 1024) throw new Error("PDF 文件大小无效。");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = scheduleParserTimeout(() => reject(new Error("PDF 校验超时，未保存文件。")), options.timeoutMs ?? 60_000);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (options.signal) {
      abort = () => reject(new Error("PDF 校验已取消。"));
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
  });

  try {
    const inspectPromise = (async () => {
      try {
        const pages = await inspectPdfStructure(bytes);
        if (Number.isInteger(pages) && pages > 0 && pages <= 10_000) return pages;
        throw new Error("页面数无效");
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 300) : "无法解析页面结构";
        throw new Error(`PDF 结构校验失败，未保存文件。${detail ? `（${detail}）` : ""}`);
      }
    })();

    return await Promise.race([inspectPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearParserTimeout(timer);
    if (abort && options.signal) {
      options.signal.removeEventListener("abort", abort);
    }
  }
}

/** Parsing stays off the Obsidian UI thread when workers are available, falling back safely in Electron renderer environments. */
export async function validatePdfStructure(bytes: Uint8Array, options: PdfValidationOptions = {}): Promise<number> {
  if (options.signal?.aborted) throw new Error("PDF 校验已取消。");
  if (bytes.byteLength <= 0 || bytes.byteLength > 256 * 1024 * 1024) throw new Error("PDF 文件大小无效。");

  if (!canUseWorkerThreads()) {
    return await validatePdfStructureDirect(bytes, options);
  }

  const transferred = Uint8Array.from(bytes).buffer;
  let worker: Worker | undefined;
  try {
    worker = new Worker(workerSource, {
      eval: true,
      workerData: transferred,
      transferList: [transferred],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
  } catch {
    return await validatePdfStructureDirect(bytes, options);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      worker.once("message", (result: unknown) => {
        const message = result as { ok?: boolean; pages?: number; message?: string } | null;
        if (message?.ok === true && Number.isInteger(message.pages) && message.pages! > 0 && message.pages! <= 10_000) resolve(message.pages!);
        else reject(new Error(`PDF 结构校验失败，未保存文件。${typeof message?.message === "string" ? `（${message.message.slice(0, 300)}）` : ""}`));
      });
      worker.once("error", () => reject(new Error("PDF 校验进程异常，未保存文件。")));
      worker.once("exit", () => reject(new Error("PDF 校验进程提前退出，未保存文件。")));
      timer = scheduleParserTimeout(() => reject(new Error("PDF 校验超时，未保存文件。")), options.timeoutMs ?? 60_000);
      abort = () => reject(new Error("PDF 校验已取消。"));
      options.signal?.addEventListener("abort", abort, { once: true });
      // Keep worker error handlers installed even if it was canceled during construction.
      if (options.signal?.aborted) abort();
    });
  } finally {
    if (timer) clearParserTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
    try { await worker.terminate(); }
    finally { worker.removeAllListeners(); }
  }
}
