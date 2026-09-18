import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, writeFile, rename, rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import cardScript from "./operation-card.ps1";

export type CardDecision = "start" | "later" | "cancel";
export interface CardState {
  phase: "before" | "running" | "stopping" | "success" | "failed" | "canceled" | "close";
  text: string;
  details?: string;
}

/** One local UI process per run; no Electron remote API or focus-changing calls. */
export class DesktopOperationCard {
  private child: ChildProcess | null = null;
  private directory = "";
  private queue = Promise.resolve();
  private ended = false;
  private disposed = false;
  private decide!: (decision: CardDecision) => void;
  readonly decision = new Promise<CardDecision>((resolve) => { this.decide = resolve; });

  constructor(private readonly onStop: () => void, private readonly onDetails: () => void,
    private readonly onClosed: () => void) {}

  async open(showBefore: boolean): Promise<void> {
    this.directory = await mkdtemp(path.join(os.tmpdir(), "ima-operation-card-"));
    try {
      const scriptPath = path.join(this.directory, "card.ps1");
      await writeFile(scriptPath, `\uFEFF${cardScript}`, "utf8");
      await this.update({ phase: showBefore ? "before" : "running", text: showBefore ? "将操作 IMA，保存分享文章。" : "正在准备同步…" });
      if (this.disposed) throw new Error("桌面操作提示已取消。");
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        let buffer = "";
        const timeout = window.setTimeout(() => reject(new Error("桌面操作提示未能启动，已阻止自动操作。")), 20000);
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
          "-File", scriptPath, "-StatePath", path.join(this.directory, "state.json"), "-OwnerProcessId", String(process.pid)],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        this.child = child;
        child.stdout?.setEncoding?.("utf8");
        child.stdout?.on("data", (chunk: Buffer | string) => {
          buffer = (buffer + String(chunk)).slice(-4096);
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const command = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (command === "ready") { ready = true; window.clearTimeout(timeout); resolve(); }
            if (command === "start" || command === "later" || command === "cancel") this.decide(command);
            if (command === "stop" && !this.ended) this.onStop();
            if (command === "details") this.onDetails();
          }
        });
        // Drain stderr without exposing UI script internals in a notification.
        child.stderr?.on("data", () => undefined);
        child.once("error", () => { window.clearTimeout(timeout); reject(new Error("无法启动桌面操作提示，已阻止自动操作。")); });
        child.once("close", () => {
          window.clearTimeout(timeout);
          this.child = null;
          this.decide("cancel");
          if (!ready) reject(new Error("桌面操作提示意外退出，未开始自动操作。"));
          if (!this.ended && !this.disposed) this.onStop();
          this.onClosed();
          void this.dispose();
        });
      });
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  update(state: CardState): Promise<void> {
    const write = this.queue.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      const pending = path.join(this.directory, "state.pending");
      await writeFile(pending, JSON.stringify(state), "utf8");
      for (let attempt = 0; ; attempt++) {
        if (this.disposed) return;
        try {
          await rename(pending, path.join(this.directory, "state.json"));
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 11 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
          // Windows readers/antivirus can briefly hold the target. Preserve atomic replacement.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
        }
      }
    });
    this.queue = write;
    return write;
  }

  async finish(state: CardState): Promise<void> {
    this.ended = true;
    await this.update(state);
  }

  async stop(): Promise<void> {
    this.decide("cancel");
    await this.update({ phase: "stopping", text: "已保存内容会保留。" });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.decide("cancel");
    const child = this.child;
    if (child && !child.killed) child.kill();
    await this.queue.catch(() => undefined);
    if (this.directory) await rm(this.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
