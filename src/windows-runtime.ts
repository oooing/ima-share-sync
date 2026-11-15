import * as path from "path";
/** Windows ships this host; never rely on a developer application's private PATH. */
export function windowsPowerShellPath(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}