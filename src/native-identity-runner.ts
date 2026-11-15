import { spawn } from "child_process";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import syncScript from "./sync.ps1";
import { windowsPowerShellPath } from "./windows-runtime";
import type { NativeIdentityRequest } from "./desktop-identity-provider";

/** Web development host uses the same packaged desktop backend, without credentials. */
export async function runDesktopIdentity(request: NativeIdentityRequest): Promise<unknown> {
  if (process.platform !== "win32") throw new Error("来源选择需要 Windows 版 IMA 客户端。");
  const root = path.join(os.tmpdir(), "ima-native-identity");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "query-"));
  const script = path.join(directory, "sync.ps1"), input = path.join(directory, "input.json"), output = path.join(directory, "output.json");
  try {
    await writeFile(script, "\uFEFF" + syncScript, "utf8");
    await writeFile(input, JSON.stringify({ operation: "native-identity", nativeIdentity: request, sourceTargetKind: "knowledge-base", contentMode: "general", allowForeground: false }), "utf8");
    let processFailure = "";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InputPath", input, "-OutputPath", output], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let errorTail = "", timedOut = false;
      const timeout = setNodeTimeout(() => { timedOut = true; child.kill(); }, 180000);
      child.stderr?.on("data", chunk => { errorTail = (errorTail + String(chunk)).slice(-4096); });
      child.once("error", error => { clearNodeTimeout(timeout); reject(error); });
      child.once("close", code => { clearNodeTimeout(timeout); if (timedOut) reject(new Error("读取 IMA 来源超时，请确认客户端已就绪后重试。")); else { if (code !== 0) processFailure = errorTail || "IMA 来源读取未完成。"; resolve(); } });
    });
    const result = JSON.parse((await readFile(output, "utf8").catch(() => { throw new Error(processFailure || "IMA 来源读取未返回结果。"); })).replace(/^\uFEFF/, "")) as { busy?: boolean; locked?: boolean; canceled?: boolean; errors?: {message: string}[]; identityResult?: unknown; identityErrorCode?: string };
    if (result.busy) throw Object.assign(new Error("IMA 正在执行其他任务，请稍后再试。"), { code: "desktop-busy" });
    if (result.locked) throw Object.assign(new Error("请解锁 Windows 后选择来源。"), { code: "desktop-locked" });
    if (result.canceled) throw new Error("来源读取已取消。");
    if (result.errors?.length || result.identityResult === undefined) {
      const error = new Error(result.errors?.[0]?.message || "IMA 来源身份未能确认。");
      Object.assign(error, { code: result.identityErrorCode }); throw error;
    }
    return result.identityResult;
  } finally {
    const resolved = path.resolve(directory);
    if (resolved.startsWith(path.resolve(root) + path.sep)) await rm(resolved, { recursive: true, force: true });
  }
}