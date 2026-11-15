import { spawn } from "child_process";
import { readFile, access } from "fs/promises";
import * as os from "os";
import * as path from "path";
export interface ImaCredentials { clientId: string; apiKey: string }
let pending: Promise<ImaCredentials> | undefined;
function valid(clientId: unknown, apiKey: unknown): ImaCredentials | undefined {
  return typeof clientId === "string" && typeof apiKey === "string" && clientId.trim().length > 8 && apiKey.trim().length > 8 ? { clientId: clientId.trim(), apiKey: apiKey.trim() } : undefined;
}
async function op(args: string[]): Promise<unknown> {
  const wrapper = path.join(os.homedir(), "Tools", "1PasswordAI", "op-ai.ps1");
  try { await access(wrapper); } catch { throw new Error("请先配置 IMA 授权：本机环境变量或 1Password「AI自动化」中的 IMA API 条目。"); }
  return await new Promise((resolve, reject) => {
    const child = spawn("pwsh.exe", ["-NoProfile", "-File", wrapper, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let failed = false;
    const fail = () => { if (failed) return; failed = true; reject(new Error("无法读取 1Password 的 IMA 授权，请检查 AI自动化 保险库的访问权限。")); };
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", () => { /* Credential tools may include sensitive values; never forward raw stderr. */ });
    child.on("error", fail);
    child.on("close", code => { if (code !== 0) { fail(); return; } try { resolve(JSON.parse(output)); } catch { fail(); } finally { output = ""; } });
  });
}
async function readCredentials(): Promise<ImaCredentials> {
  const env = valid(process.env.IMA_OPENAPI_CLIENTID ?? process.env.IMA_CLIENT_ID, process.env.IMA_OPENAPI_APIKEY ?? process.env.IMA_API_KEY);
  if (env) return env;
  const folder = path.join(os.homedir(), ".config", "ima");
  const local = await Promise.all([readFile(path.join(folder, "client_id"), "utf8").catch(() => ""), readFile(path.join(folder, "api_key"), "utf8").catch(() => "")]);
  const file = valid(local[0], local[1]); if (file) return file;
  const entries = await op(["item", "list", "--vault", "AI自动化", "--format", "json"]);
  if (!Array.isArray(entries)) throw new Error("1Password 条目列表无法识别。");
  const matches = entries.filter((entry: { title?: unknown }) => typeof entry.title === "string" && /^(ima|ima api)$/i.test(entry.title.trim()));
  if (matches.length !== 1) throw new Error("请在 1Password「AI自动化」中保留一个名为「IMA API」的授权条目。");
  const detail = await op(["item", "get", String((matches[0] as {id: string}).id), "--vault", "AI自动化", "--format", "json"]) as { fields?: {id: string; label: string; value: string}[] };
  const fields = detail.fields ?? [];
  const clientId = fields.find(f => /^client[ _-]?id$/i.test(f.label))?.value;
  const apiKey = fields.find(f => /^api[ _-]?key$/i.test(f.label) || f.id === "credential")?.value;
  const result = valid(clientId, apiKey); if (!result) throw new Error("IMA API 条目需要 Client ID 与 API Key（凭据）两个字段。");
  return result;
}
/** One in-memory credential read per host lifetime; never persisted to plugin data. */
export function getImaCredentials(): Promise<ImaCredentials> { return pending ??= readCredentials().catch(error => { pending = undefined; throw error; }); }
