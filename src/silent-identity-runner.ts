import { execFile } from "child_process";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import * as path from "path";
import { request as httpsRequest } from "https";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";
import { windowsPowerShellPath } from "./windows-runtime";
import { SilentDirectoryService, directoryError, type DirectoryCache, type DirectoryQuery } from "./silent-directory";
import type { NativeIdentityRequest } from "./desktop-identity-provider";

// DPAPI is scoped to the signed-in Windows user. Output goes only to an anonymous
// child-process pipe; credentials are never written to a file, log, argument or UI.
const readLogin = String.raw`
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  $p=Join-Path $env:LOCALAPPDATA 'ima.copilot\User Data\Default\Preferences'
  $prefs=Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
  $wx=$prefs.tencent.wxlogin
  $m=$wx.account_meta | ConvertFrom-Json
  $bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($wx.account_secret_encrypted),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $s=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  $q=''
  foreach($g in $prefs.sync.transport_data_per_account.PSObject.Properties){if($g.Value.'sync.cache_guid'){$q=$g.Value.'sync.cache_guid';break}}
  $version=(Get-Item (Join-Path $env:LOCALAPPDATA 'ima.copilot\Application\ima.copilot.exe')).VersionInfo.ProductVersion
  $out=@{token=$s.token;refresh=$s.refresh_token;uid=$m.user_id;idType=$m.id_type;tokenType=$m.token_type;guid=$m.user_info.open_info.guid;q36=$q;version=$version}
  [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
  [Console]::Write(($out | ConvertTo-Json -Compress))
  [Array]::Clear($bytes,0,$bytes.Length)
} catch { exit 1 }
`;
interface Login { token: string; refresh?: string; uid: string; idType: number; tokenType: number; guid?: string; q36?: string; version: string }
interface Context { account: string; signature: string; uid: string; cachePath: string }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
async function context(): Promise<Context> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) throw directoryError("login-required");
  try {
    const prefs = JSON.parse(await readFile(path.join(process.env.LOCALAPPDATA, "ima.copilot", "User Data", "Default", "Preferences"), "utf8")) as { tencent?: { wxlogin?: { account_meta?: string; account_secret_encrypted?: string } } };
    const wx = prefs.tencent?.wxlogin;
    const meta = JSON.parse(wx?.account_meta ?? "{}") as { user_id?: string };
    if (!meta.user_id || !wx?.account_secret_encrypted) throw directoryError();
    const uid = String(meta.user_id), account = digest(uid);
    return { uid, account, signature: digest(uid + wx.account_secret_encrypted), cachePath: path.join(process.env.LOCALAPPDATA, "ima-share-sync", "source-cache", account + ".json") };
  } catch { throw directoryError("login-required"); }
}
function decryptLogin(): Promise<Login> {
  return new Promise((resolve, reject) => {
    execFile(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", readLogin],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) { reject(directoryError("login-required")); return; }
        try {
          const login = JSON.parse(stdout) as Login;
          if (!login.token || !login.uid || !login.version) throw directoryError();
          resolve(login);
        } catch { reject(directoryError("login-required")); }
      });
  });
}
export function loginHeaders(login: Login): Record<string, string> {
  let hash = 5381;
  for (let i = 0; i < login.token.length; i++) hash += (hash << 5) + login.token.charCodeAt(i);
  const fields = { PLATFORM: "H5", "CLIENT-TYPE": "256021", "WEB-VERSION": "5.21.8", "IMA-GUID": login.guid, "IMA-Q36": login.q36,
    "IMA-IUA": `PR=IMA&PP=com.tencent.imawin&PPVN=${login.version}&PL=WIN&COVC=${login.version}&EV=`,
    "IMA-UID": login.uid, "IMA-TOKEN": login.token, "IMA-REFRESH-TOKEN": login.refresh, "UID-TYPE": login.idType, "TOKEN-TYPE": login.tokenType };
  return { "x-ima-cookie": Object.entries(fields).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join("; "),
    "x-ima-bkn": String(hash & 0x7fffffff), from_browser_ima: "1", extension_version: "5.21.8", "Content-Type": "application/json", accept: "application/json", origin: "https://ima.qq.com", referer: "https://ima.qq.com/" };
}
export function queryDirectories(headers: Record<string, string>): DirectoryQuery {
  return (endpoint, body) => new Promise((resolve, reject) => {
    if (!["get_knowledge_base_list", "get_folder_list", "get_knowledge_list"].includes(endpoint)) { reject(directoryError()); return; }
    const req = httpsRequest({ hostname: "ima.qq.com", port: 443, path: "/cgi-bin/knowledge_tab_reader/" + endpoint, method: "POST", headers }, res => {
      // No redirects, browser cookie jar, login refresh, logout or interactive fallback.
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { raw += chunk; if (raw.length > 4000000) req.destroy(); });
      res.on("error", () => reject(directoryError("network-unavailable")));
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(directoryError(res.statusCode === 401 || res.statusCode === 403 ? "login-required" : "network-unavailable")); return; }
        try {
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (data.code !== 0) { reject(directoryError([41, 600001, 110030, 110031].includes(data.code as number) ? "login-required" : data.code === 30005 ? "not-found" : "unverified")); return; }
          resolve(data);
        } catch { reject(directoryError("unverified")); }
      });
    });
    const timeout = setNodeTimeout(() => req.destroy(), 10000);
    req.once("close", () => clearNodeTimeout(timeout));
    req.once("error", () => reject(directoryError("network-unavailable")));
    req.end(JSON.stringify(body));
  });
}
let session: { signature: string; login: Login } | undefined;
let cacheAccount = "", cache: DirectoryCache = {};
let loginPending: Promise<Login> | undefined;
export async function runSilentIdentity(request: NativeIdentityRequest): Promise<unknown> {
  const ctx = await context();
  if (cacheAccount !== ctx.account) {
    cacheAccount = ctx.account; cache = {};
    try {
      const saved = JSON.parse(await readFile(ctx.cachePath, "utf8")) as { version: number; account: string; entries: DirectoryCache };
      if (saved.version === 1 && saved.account === ctx.account && saved.entries && typeof saved.entries === "object") cache = saved.entries;
    } catch { /* A missing/old cache is a normal cold start. */ }
  }
  if (request.cacheOnly) return new SilentDirectoryService(async () => { throw directoryError(); }, cache).call(request);
  if (session?.signature !== ctx.signature) {
    loginPending ??= decryptLogin().finally(() => { loginPending = undefined; });
    const login = await loginPending;
    if (String(login.uid) !== ctx.uid) throw directoryError("login-required");
    session = { signature: ctx.signature, login };
  }
  try {
    const service = new SilentDirectoryService(queryDirectories(loginHeaders(session.login)), cache);
    const value = await service.call(request);
    // An account change during a query must not replace the displayed account's catalog.
    if ((await context()).account !== ctx.account) throw directoryError("login-required");
    await mkdir(path.dirname(ctx.cachePath), { recursive: true })
      .then(() => writeFile(ctx.cachePath, JSON.stringify({ version: 1, account: ctx.account, entries: cache }), "utf8"))
      .catch(() => undefined);
    return value;
  } catch (error) {
    if ((error as { code?: string }).code === "login-required") session = undefined;
    throw error;
  }
}
