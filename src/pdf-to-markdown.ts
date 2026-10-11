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

export interface SinglePdfResult {
  success: boolean;
  skipped: boolean;
  error?: string;
}

export type SinglePdfProcessor = (task: ConvertTask) => SinglePdfResult;

const scheduleParserTimeout = setTimeout;
const clearParserTimeout = clearTimeout;

function canUseWorkerThreads(): boolean {
  if (typeof window !== "undefined" || typeof document !== "undefined") {
    return false;
  }
  if (
    typeof process !== "undefined" &&
    ((process as { type?: string }).type === "renderer" ||
      Boolean((process as { versions?: { electron?: string } }).versions?.electron))
  ) {
    return false;
  }
  return typeof Worker === "function";
}

/**
 * 直接在当前进程异步分片处理转换任务。
 * 每篇处理后出让事件循环，保证 UI 丝滑响应用户取消和进度显示。
 */
export async function runDirectConversion(
  tasks: ConvertTask[],
  processor: SinglePdfProcessor,
  onProgress?: (progress: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ConvertResultSummary> {
  if (signal?.aborted) throw new Error("Markdown 转换已被取消");
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < tasks.length; index++) {
    if (signal?.aborted) throw new Error("Markdown 转换已被取消");
    const task = tasks[index];
    if (!task) continue;

    try {
      const result = processor(task);
      if (result.skipped) {
        skipped++;
      } else if (result.success) {
        completed++;
      } else {
        failed++;
        console.warn("Markdown 转换失败:", task.title, result.error);
      }
    } catch (error) {
      failed++;
      console.warn("Markdown 转换执行异常:", task.title, error);
    }

    onProgress?.(index + 1, tasks.length);
    await new Promise((resolve) => scheduleParserTimeout(resolve, 0));
  }

  return { completed, skipped, failed };
}

/**
 * 转换任务调度入口：
 * - 在 Obsidian / Electron 渲染进程中：安全走 Direct 模式，零子进程/零 eval，杜绝进程挂死与安全告警；
 * - 在独立 Node 测试环境中：使用 worker_threads 隔离执行 runnerSource，完整保留并发与超时保障。
 */
export async function runMarkdownConversion(
  tasks: ConvertTask[],
  runnerSource: string,
  onProgress?: (progress: number, total: number) => void,
  signal?: AbortSignal,
  directProcessor?: SinglePdfProcessor,
): Promise<ConvertResultSummary> {
  if (!tasks.length) return { completed: 0, skipped: 0, failed: 0 };
  if (signal?.aborted) throw new Error("Markdown 转换已被取消");

  if (!canUseWorkerThreads() || directProcessor) {
    if (directProcessor) {
      return await runDirectConversion(tasks, directProcessor, onProgress, signal);
    }
  }

  return await new Promise<ConvertResultSummary>((resolve, reject) => {
    const worker = new Worker(runnerSource, {
      eval: true,
      workerData: tasks,
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = (error?: Error, summary?: ConvertResultSummary) => {
      if (settled) return;
      settled = true;
      clearParserTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(summary ?? { completed: 0, skipped: 0, failed: tasks.length });
        },
        (terminationError: unknown) =>
          reject(terminationError instanceof Error ? terminationError : new Error(String(terminationError))),
      );
    };
    const abort = () => finish(new Error("Markdown 转换已被取消"));
    const timer = scheduleParserTimeout(
      () => finish(new Error("Markdown 转换超时")),
      Math.min(30 * 60_000, tasks.length * 120_000),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("message", (value: unknown) => {
      if (settled || !value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (typeof message.progress === "number" && typeof message.total === "number") {
        try {
          onProgress?.(message.progress, message.total);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      if (message.status === "error" && typeof message.message === "string") {
        console.warn("Markdown conversion details:", message.message);
      }
      if (
        message.status === "done" &&
        typeof message.completed === "number" &&
        typeof message.skipped === "number" &&
        typeof message.failed === "number"
      ) {
        finish(undefined, {
          completed: message.completed,
          skipped: message.skipped,
          failed: message.failed,
        });
      }
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) => {
      if (!settled) finish(new Error("Markdown 转换线程未返回结果，退出代码：" + String(code)));
    });
  });
}
