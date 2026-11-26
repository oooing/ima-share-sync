import { spawn } from "child_process";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import workerSource from "./ocr-worker.py";
import mobileWorkerSource from "./ocr-mobile.py";
import { OCR_MODELS, type LocalOcrMode, type OcrPage, type OcrRequest } from "./pdf-ocr-core";

export class LocalOcrMemoryError extends Error {}
export class LocalOcrSetupError extends Error {}

export function localOcrMinimumGiB(mode: LocalOcrMode): number {
  return mode === "local-mobile" ? 1.5 : 6;
}

export function defaultOcrRuntime(mode: LocalOcrMode = "local"): string {
  const local = typeof process === "undefined" ? undefined : process.env.LOCALAPPDATA;
  return path.join(local || path.join(os.homedir(), "AppData", "Local"), "IMA-Share-Sync", mode === "local-mobile" ? "ocr-mobile" : "ocr");
}
export async function checkOcrRuntime(runtime: string, mode: LocalOcrMode = "local"): Promise<void> {
  const files = mode === "local-mobile"
    ? ["models/ch_PP-OCRv5_det_mobile.onnx", "models/ch_PP-OCRv5_rec_mobile.onnx"]
    : ["runtime/llama/llama-server.exe", "models/gguf/PaddleOCR-VL-1.6-GGUF.gguf",
      "models/gguf/PaddleOCR-VL-1.6-GGUF-mmproj.gguf", "cache/paddlex/official_models/PP-DocLayoutV3/inference.pdiparams"];
  try {
    const manifest = JSON.parse(await readFile(path.join(runtime, "runtime.json"), "utf8")) as { schema?: number; model?: string };
    if (manifest.schema !== 1 || manifest.model !== OCR_MODELS[mode]) throw new Error("wrong local runtime");
    await Promise.all([".venv/Scripts/python.exe", ...files].map(file => access(path.join(runtime, file))));
  } catch {
    throw new LocalOcrSetupError("所选本地 OCR 未就绪，请按文档转换中的指引在插件外安装，再检查环境");
  }
}

export async function recognizeLocal(input: OcrRequest, runtime: string,
  onPage?: (page: number, total: number) => void, mode: LocalOcrMode = "local"): Promise<OcrPage[]> {
  if (input.signal?.aborted) throw new Error("OCR 已取消");
  await checkOcrRuntime(runtime, mode);
  const minimum = localOcrMinimumGiB(mode);
  if (os.freemem() < minimum * 2 ** 30) throw new LocalOcrMemoryError(`可用内存不足 ${minimum} GiB，待转换`);
  await mkdir(path.join(os.tmpdir(), "ima-ocr"), { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ima-ocr", "job-"));
  const script = path.join(temporary, "worker.py");
  try {
    await writeFile(script, mode === "local-mobile" ? mobileWorkerSource : workerSource, "utf8");
    return await new Promise<OcrPage[]>((resolve, reject) => {
      const child = spawn(path.join(runtime, ".venv", "Scripts", "python.exe"), ["-u", script], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      const pages: OcrPage[] = []; let pending = ""; let done = false; let failure: Error | undefined;
      // A PDF can take minutes. Kill only our owned process tree on cancel/timeout.
      const stop = (message: string, insufficientMemory = false) => {
        if (failure) return;
        failure = insufficientMemory ? new LocalOcrMemoryError(message) : new Error(message);
        if (child.pid) {
          const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else child.kill();
      };
      let timer = scheduleTimeout(() => stop("本地 OCR 启动超时"), 180_000);
      const resetTimer = () => { cancelTimeout(timer); timer = scheduleTimeout(() => stop("本地 OCR 单页识别超时，原 PDF 已保留"), 300_000); };
      const abort = () => stop("OCR 已取消");
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.resume(); // Backend logs are deliberately not persisted with note contents.
      child.stdin.on("error", () => stop("本地 OCR 任务提交失败"));
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        if (pending.length > 20_000_000) { stop("本地 OCR 结果过大"); return; }
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.type === "error") {
              stop(typeof message.message === "string" ? message.message : "本地 OCR 失败", message.code === "insufficient-memory");
            }
            if (message.type === "ready") resetTimer();
            if (message.type === "page" && typeof message.page === "number" && typeof message.markdown === "string") {
              pages.push({ page: message.page, markdown: message.markdown }); resetTimer(); onPage?.(pages.length, input.pages.length);
            }
            if (message.type === "done") done = true;
          } catch { stop("本地 OCR 返回格式异常"); }
        }
      });
      child.on("error", () => { failure = new Error("无法启动本地 OCR，请检查 Python 环境"); });
      child.on("close", code => {
        cancelTimeout(timer); input.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0 || !done || pages.length !== input.pages.length) reject(new Error("本地 OCR 未完整完成，原 PDF 已保留"));
        else resolve(pages);
      });
      if (input.signal?.aborted) abort();
      else child.stdin.end(JSON.stringify({ runtime, pdfPath: input.pdfPath, pages: input.pages }) + "\n");
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
