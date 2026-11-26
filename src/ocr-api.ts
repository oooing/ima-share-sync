import { request } from "https";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";
import { readFile, stat } from "fs/promises";
import type { OcrPage, OcrRequest } from "./pdf-ocr-core";

export const OCR_API_ENDPOINT = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
export class OcrAccountError extends Error {}
export interface OcrJobFailure {
  jobId: string;
  reason?: string;
}

export class OcrJobError extends Error {
  constructor(readonly diagnostic: OcrJobFailure) {
    super("百度 OCR 任务失败，原 PDF 已保留");
  }
}

function summarizeProviderError(value: unknown, token: string): string | undefined {
  if (typeof value !== "string") return;
  // Retain the provider's diagnosis, not signed links or credentials it may echo.
  const reason = value
    .replaceAll(token, "[已隐藏]")
    .replace(/https?:\/\/[^\s<>"'，。；]+/gi, "[链接已隐藏]")
    .replace(/\bBearer[ \t]+[\w.~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
  return reason.length > 600 ? reason.slice(0, 599) + "…" : reason || undefined;
}
export interface OcrHttpRequest { url: string; token?: string; body?: Buffer; contentType?: string; signal?: AbortSignal }
export type OcrTransport = (options: OcrHttpRequest) => Promise<string>;
export type OcrSubmissionObserver = (pdfBytes: number, accepted: boolean) => void;

export const ocrHttps: OcrTransport = options => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error("OCR 已取消")); return; }
  const url = new URL(options.url);
  if (url.protocol !== "https:") { reject(new Error("OCR 响应地址无效")); return; }
  const headers: Record<string, string | number> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body) { headers["Content-Type"] = options.contentType ?? "application/json"; headers["Content-Length"] = options.body.length; }
  let settled = false;
  const finish = (error?: Error, value?: string) => {
    if (settled) return;
    settled = true;
    cancelTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (error) reject(error); else resolve(value ?? "");
  };
  const req = request(url, { method: options.body ? "POST" : "GET", headers }, res => {
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      res.resume();
      if (options.token && [401, 403, 429].includes(res.statusCode ?? 0)) {
        finish(new OcrAccountError(res.statusCode === 429 ? "百度 OCR 限流或当日额度已用尽，请稍后补转" :
          "百度 OCR 拒绝请求，请检查 AI Studio 令牌与账户额度"));
      } else finish(new Error(`百度 OCR 请求失败（HTTP ${res.statusCode ?? 0}）`));
      return;
    }
    const chunks: Buffer[] = []; let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) { finish(new Error("OCR 结果过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    res.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
    res.on("error", () => finish(new Error("OCR 结果下载失败")));
  });
  const abort = () => { finish(new Error("OCR 已取消")); req.destroy(); };
  const timer = scheduleTimeout(() => { finish(new Error("百度 OCR 请求超时")); req.destroy(); }, 120_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  req.on("error", () => finish(new Error("百度 OCR 连接失败")));
  if (options.signal?.aborted) abort(); else req.end(options.body);
});

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function recognizeApi(
  input: OcrRequest, token: string, uploadApproved: boolean,
  transport: OcrTransport = ocrHttps,
  wait: (signal?: AbortSignal) => Promise<void> = signal => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("OCR 已取消")); return; }
    const abort = () => { cancelTimeout(timer); reject(new Error("OCR 已取消")); };
    const timer = scheduleTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 2000);
    signal?.addEventListener("abort", abort, { once: true });
  }),
  onSubmission?: OcrSubmissionObserver,
): Promise<OcrPage[]> {
  // Enforced here as well as in the UI. No secret, file read or network call before consent.
  if (!uploadApproved) throw new Error("API 识别需手动确认上传或开启本机同步上传授权");
  if (!token.trim()) throw new Error("请先在文档转换中配置百度 AI Studio 令牌");
  if (input.signal?.aborted) throw new Error("OCR 已取消");
  if (input.pageCount > 1000 || (await stat(input.pdfPath)).size > 50 * 1024 * 1024) throw new Error("API 单份 PDF 限 50 MB / 1000 页，请先拆分");
  const boundary = "ima-ocr-multipart-" + Date.now().toString(36);
  const fields = {
    model: "PaddleOCR-VL-1.6",
    optionalPayload: JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false,
      useLayoutDetection: true, useChartRecognition: false }),
    pageRanges: input.pages.join(","),
  };
  const parts = Object.entries(fields).map(([key, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  const pdf = await readFile(input.pdfPath);
  if (input.signal?.aborted) throw new Error("OCR 已取消");
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf, Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  let jobId: unknown;
  try {
    const submitted = object(JSON.parse(await transport({ url: OCR_API_ENDPOINT, token, body,
      contentType: `multipart/form-data; boundary=${boundary}`, signal: input.signal })));
    jobId = object(submitted.data).jobId;
    if (typeof jobId !== "string" || !jobId) throw new Error("百度 OCR 未接受任务，请检查账户额度");
  } catch (error) {
    onSubmission?.(pdf.length, false);
    throw error;
  }
  // A job ID confirms the upload, even if recognition or local saving later fails.
  onSubmission?.(pdf.length, true);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error("OCR 已取消（已上传的云端任务可能继续处理）");
    const status = object(object(JSON.parse(await transport({ url: `${OCR_API_ENDPOINT}/${encodeURIComponent(jobId)}`, token, signal: input.signal }))).data);
    const state = status.state ?? status.status;
    if (state === "failed") {
      throw new OcrJobError({
        jobId: jobId === token ? "" : jobId,
        reason: summarizeProviderError(status.errorMsg, token),
      });
    }
    if (state === "done") {
      const resultUrl = object(status.resultUrl).jsonUrl;
      if (typeof resultUrl !== "string" || !resultUrl.startsWith("https://")) throw new Error("百度 OCR 未返回有效结果");
      // Never send the account token to the result-storage host.
      const text = await transport({ url: resultUrl, signal: input.signal });
      const pages: OcrPage[] = [];
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const results = object(object(JSON.parse(line)).result).layoutParsingResults;
        if (!Array.isArray(results)) throw new Error("OCR 结果格式无效");
        for (const item of results) {
          const data = object(item);
          const markdown = object(data.markdown).text;
          if (typeof markdown !== "string") throw new Error("OCR 未返回正文");
          pages.push({ page: input.pages[pages.length] ?? 0, markdown });
        }
      }
      if (pages.length !== input.pages.length) throw new Error("OCR 返回页数与请求不符");
      return pages;
    }
    await wait(input.signal);
  }
  throw new Error("百度 OCR 排队超时，原 PDF 已保留");
}
