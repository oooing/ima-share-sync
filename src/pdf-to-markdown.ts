import { Worker } from "worker_threads";

export interface MarkdownConvertOptions {
  scope: "all" | "text_only" | "image_only";
  embedPdfLink: boolean;
}

export interface ConvertTask extends MarkdownConvertOptions {
  pdfPath: string;
  mdPath: string;
  title: string;
}

export interface ConvertResultSummary {
  completed: number;
  skipped: number;
  failed: number;
}

const scheduleParserTimeout = setTimeout;
const clearParserTimeout = clearTimeout;

/** Run the bundled WASM parser locally without a system Node installation. */
export async function runMarkdownConversion(
  tasks: ConvertTask[],
  runnerSource: string,
  onProgress?: (progress: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ConvertResultSummary> {
  if (!tasks.length) return { completed: 0, skipped: 0, failed: 0 };
  if (signal?.aborted) throw new Error("Markdown 转换已被取消");

  return await new Promise<ConvertResultSummary>((resolve, reject) => {
    const worker = new Worker(runnerSource, {
      eval: true, workerData: tasks,
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = (error?: Error, summary?: ConvertResultSummary) => {
      if (settled) return;
      settled = true;
      clearParserTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(summary ?? { completed: 0, skipped: 0, failed: tasks.length });
      }, (terminationError: unknown) => reject(terminationError instanceof Error ? terminationError : new Error(String(terminationError))));
    };
    const abort = () => finish(new Error("Markdown 转换已被取消"));
    const timer = scheduleParserTimeout(() => finish(new Error("Markdown 转换超时")), Math.min(30 * 60_000, tasks.length * 120_000));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("message", (value: unknown) => {
      if (settled || !value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (typeof message.progress === "number" && typeof message.total === "number") {
        try { onProgress?.(message.progress, message.total); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }
      }
      if (message.status === "error" && typeof message.message === "string") console.warn("Markdown conversion details:", message.message);
      if (message.status === "done" && typeof message.completed === "number" && typeof message.skipped === "number" && typeof message.failed === "number") {
        finish(undefined, { completed: message.completed, skipped: message.skipped, failed: message.failed });
      }
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) => {
      if (!settled) finish(new Error("Markdown 转换线程未返回结果，退出代码：" + code));
    });
  });
}
