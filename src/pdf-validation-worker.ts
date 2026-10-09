import { parentPort, workerData } from "worker_threads";
import { inspectPdfStructure } from "./pdf-structure";

void (async () => {
  try {
    const pages = await inspectPdfStructure(new Uint8Array(workerData as ArrayBuffer));
    parentPort?.postMessage({ ok: true, pages });
  } catch (error) {
    parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message.slice(0, 300) : "无法解析页面结构" });
  } finally {
    parentPort?.close();
  }
})();
