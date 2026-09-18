import {
  FileSystemAdapter,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  addIcon,
  normalizePath,
  setIcon,
} from "obsidian";
import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import syncScript from "./sync.ps1";
import { DesktopOperationCard } from "./desktop-card";
import { IMA_SHARE_SYNC_ICON_ID, IMA_SHARE_SYNC_ICON_SVG } from "./icon";

const GITHUB_REPOSITORY_URL = "https://github.com/oooing/ima-share-sync";

interface ImaSpeedSyncSettings {
  autoSync: boolean;
  hasConsented: boolean;
  knowledgeBaseName: string;
  folderName: string;
  destinationPath: string;
  overwriteSameName: boolean;
  maxItems: number;
  contentMode: "general" | "speed-reader";
  titleFilterMode: "all" | "contains" | "prefix" | "regex";
  titleFilter: string;
  allowForeground: boolean;
  notificationsEnabled: boolean;
  notifyAutoSuccess: boolean;
  notifyAutoFailure: boolean;
  notifyManualResult: boolean;
  showErrorBadge: boolean;
  showOperationBefore: boolean;
  showOperationAfter: boolean;
}

type NotificationSetting = "notificationsEnabled" | "notifyAutoSuccess" | "notifyAutoFailure" | "notifyManualResult" | "showErrorBadge" | "showOperationBefore" | "showOperationAfter";

interface SyncReport {
  id?: string;
  read?: boolean;
  finishedAt: number;
  interactive: boolean;
  status: "success" | "failed" | "canceled";
  summary: string;
  errors: ExtractionError[];
}

const SYNC_REPORTS_PER_PAGE = 20;

function restoreSyncReports(value: unknown): SyncReport[] {
  if (!Array.isArray(value)) return [];
  const reports: SyncReport[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const report = candidate as Partial<SyncReport>;
    if (typeof report.finishedAt !== "number" || !Number.isFinite(report.finishedAt) || report.finishedAt <= 0 ||
      typeof report.interactive !== "boolean" || typeof report.summary !== "string" ||
      !["success", "failed", "canceled"].includes(report.status ?? "") || !Array.isArray(report.errors)) continue;
    const errors: ExtractionError[] = [];
    for (const entry of report.errors.slice(0, 60)) {
      if (entry && typeof entry.title === "string" && typeof entry.message === "string") {
        errors.push({ title: entry.title.slice(0, 200), message: entry.message.slice(0, 600) });
      }
    }
    reports.push({
      id: typeof report.id === "string" && report.id.length > 0 && report.id.length <= 100
        ? report.id
        : createHash("sha256").update(JSON.stringify([report.finishedAt, report.interactive, report.status, report.summary, errors])).digest("hex"),
      read: report.read === true,
      finishedAt: report.finishedAt,
      interactive: report.interactive,
      status: report.status as SyncReport["status"],
      summary: report.summary.slice(0, 2000),
      errors,
    });
  }
  return reports.sort((left, right) => right.finishedAt - left.finishedAt);
}

interface ExtractedArticle {
  sourceTitle: string;
  updatedDate?: string | null;
  body: string;
  sourceId?: string;
  complete?: boolean;
}

interface ExtractionError {
  title: string;
  message: string;
}

interface ExtractionResult {
  busy?: boolean;
  canceled?: boolean;
  items?: ExtractedArticle[];
  errors?: ExtractionError[];
  skippedTitles?: string[];
}

interface SyncedArticleMetadata {
  sourceKey?: string;
  sourceTitle?: string;
  sourceId?: string;
  sourceScope?: string;
}

interface SyncedArticleIndex {
  bySourceKey: Map<string, TFile>;
  legacyBySourceTitle: Map<string, TFile>;
  markdownByBasename: Map<string, TFile>;
  occupiedFileNames: Set<string>;
  sourceTitles: Set<string>;
  metadataByPath: Map<string, SyncedArticleMetadata>;
}

interface SyncRun {
  readonly id: number;
  cancellationPath: string | null;
  cancellationRequested: boolean;
  process: ChildProcess | null;
  card?: DesktopOperationCard;
  report?: SyncReport;
}

interface SettingsController {
  open(): void;
  openTabById(id: string): void;
}

type SaveStatus = "created" | "updated" | "unchanged" | "skipped" | "conflict";

class SyncCanceledError extends Error {
  constructor() {
    super("IMA Share Sync 已取消。");
    this.name = "SyncCanceledError";
  }
}

const DEFAULT_SETTINGS: ImaSpeedSyncSettings = {
  autoSync: false,
  hasConsented: false,
  knowledgeBaseName: "",
  folderName: "",
  destinationPath: "IMA Share Sync",
  overwriteSameName: false,
  maxItems: 7,
  contentMode: "general",
  titleFilterMode: "all",
  titleFilter: "",
  allowForeground: false,
  notificationsEnabled: true,
  notifyAutoSuccess: false,
  notifyAutoFailure: true,
  notifyManualResult: true,
  showErrorBadge: true,
  showOperationBefore: true,
  showOperationAfter: true,
};

const VIEW_TYPE = "ima-speed-sync-view";
const PLUGIN_MARKER = "ima-speed-sync";
const ARTICLES_PER_PAGE = 20;
const MAX_BASENAME_LENGTH = 120;

class SyncHistoryPanel {
  contentEl!: HTMLElement;
  private page = 0;
  private focusedId?: string;
  private expandedIds = new Set<string>();

  constructor(private readonly getReports: () => readonly SyncReport[],
    focusedId: string | undefined, private readonly onViewed: (reports: readonly SyncReport[]) => void,
    private readonly onClosed: () => void) {
    this.focusedId = focusedId;
    if (focusedId) this.expandedIds.add(focusedId);
    const index = getReports().findIndex((report) => report.id === focusedId);
    if (index >= 0) this.page = Math.floor(index / SYNC_REPORTS_PER_PAGE);
  }

  mount(containerEl: HTMLElement): void {
    this.contentEl = containerEl;
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "ima-share-sync-history-header" });
    header.createEl("h4", { text: "同步日志" });
    header.createEl("button", { text: "收起" }).addEventListener("click", () => this.close());
    const reports = this.getReports();
    const focusedIndex = this.focusedId ? reports.findIndex((report) => report.id === this.focusedId) : -1;
    if (focusedIndex >= 0) this.page = Math.floor(focusedIndex / SYNC_REPORTS_PER_PAGE);
    const pages = Math.max(1, Math.ceil(reports.length / SYNC_REPORTS_PER_PAGE));
    this.page = Math.min(this.page, pages - 1);
    const pageReports = reports.slice(this.page * SYNC_REPORTS_PER_PAGE, (this.page + 1) * SYNC_REPORTS_PER_PAGE);
    const list = this.contentEl.createDiv({ cls: "ima-share-sync-history-list" });
    let focusedRecord: HTMLDetailsElement | undefined;
    if (!reports.length) list.createEl("p", { text: "暂无同步日志。" });
    for (const report of pageReports) {
      const record = list.createEl("details", { cls: "ima-share-sync-report" });
      record.open = !!report.id && this.expandedIds.has(report.id);
      if (record.open && report.id === this.focusedId) focusedRecord = record;
      record.createEl("summary", {
        text: `${new Date(report.finishedAt).toLocaleString("zh-CN")} · ${report.interactive ? "手动同步" : "自动同步"} · ${report.status === "failed" ? "存在异常" : report.status === "canceled" ? "已取消" : "已完成"}`,
      });
      record.createEl("p", { text: report.summary });
      for (const error of report.errors) {
        record.createEl("p", { text: `${error.title || "同步任务"}：${error.message}` });
      }
      record.addEventListener("toggle", () => {
        if (record.open) {
          if (report.id) this.expandedIds.add(report.id);
          this.onViewed([report]);
        } else {
          if (report.id) this.expandedIds.delete(report.id);
          if (this.focusedId === report.id) this.focusedId = undefined;
        }
      });
    }
    const pager = this.contentEl.createDiv({ cls: "ima-speed-sync-pagination" });
    const previous = pager.createEl("button", { text: "上一页" });
    previous.disabled = this.page === 0;
    previous.addEventListener("click", () => {
      if (this.page === 0) return;
      this.page--;
      this.focusedId = undefined;
      this.render();
    });
    pager.createSpan({ text: `第 ${this.page + 1} / ${pages} 页 · 共 ${reports.length} 次`, cls: "ima-speed-sync-page-status" });
    const next = pager.createEl("button", { text: "下一页" });
    next.disabled = this.page >= pages - 1;
    next.addEventListener("click", () => {
      if (this.page >= pages - 1) return;
      this.page++;
      this.focusedId = undefined;
      this.render();
    });
    this.onViewed(this.focusedId ? pageReports.filter((report) => report.id === this.focusedId) : pageReports);
    focusedRecord?.scrollIntoView?.({ block: "nearest" });
  }

  close(): void {
    this.contentEl.empty();
    this.onClosed();
  }
}

class ConsentModal extends Modal {
  private settled = false;

  constructor(
    app: Plugin["app"],
    private readonly finish: (allowed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("允许自动操作 IMA 桌面端？");
    this.contentEl.createEl("p", {
      text: "本插件仅支持 Windows。它会启动 IMA 桌面端，通过 Windows UI 自动化读取当前可见的文章正文，并在指定的仓库文件夹中创建或更新 Markdown 文件。",
    });
    this.contentEl.createEl("p", {
      text: "插件不会把仓库数据发送到自有服务器。诊断日志仅写入本机 LocalAppData 目录。",
    });
    this.contentEl.createEl("p", {
      text: "默认不主动移动鼠标或切换焦点，但打开文章可能使 IMA 自行弹到前台。只有开启“允许短时前台操作”后才允许鼠标后备操作；你正在操作电脑时会停止该后备操作。",
    });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => this.resolve(false)),
      )
      .addButton((button) =>
        button
          .setButtonText("允许")
          .setCta()
          .onClick(() => this.resolve(true)),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.finish(false);
    }
  }

  private resolve(allowed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.finish(allowed);
    this.close();
  }
}

class ImaSpeedSyncView extends ItemView {
  private currentPage = 0;
  private renderTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ImaSpeedSyncPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "IMA Share Sync";
  }

  override getIcon(): string {
    return IMA_SHARE_SYNC_ICON_ID;
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.app.vault.on("create", (file) => this.scheduleRender(file.path)));
    this.registerEvent(this.plugin.app.vault.on("delete", (file) => this.scheduleRender(file.path)));
    this.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
      if (this.plugin.isDestinationArticlePath(oldPath)) {
        this.scheduleRender();
        return;
      }
      this.scheduleRender(file.path);
    }));
    this.registerEvent(this.plugin.app.vault.on("modify", (file) => this.scheduleRender(file.path)));
    this.render();
  }

  override async onClose(): Promise<void> {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  private scheduleRender(changedPath?: string): void {
    if (changedPath && !this.plugin.isDestinationArticlePath(changedPath)) return;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 150);
  }

  render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "IMA Share Sync" });

    const toolbar = this.contentEl.createDiv({ cls: "ima-speed-sync-toolbar" });
    const syncGroup = toolbar.createDiv({ cls: "ima-speed-sync-split-button" });
    const syncButton = syncGroup.createEl("button", {
      text: this.plugin.isRunning ? "取消同步" : "立即同步",
      cls: this.plugin.isRunning ? "mod-warning" : undefined,
    });
    syncButton.addEventListener("click", () => {
      if (this.plugin.isRunning) {
        void this.plugin.cancelSync();
      } else {
        void this.plugin.sync(true);
      }
    });

    const modeButton = syncGroup.createEl("button", {
      text: "▾",
      cls: "ima-speed-sync-mode-button",
    });
    modeButton.disabled = this.plugin.isRunning;
    modeButton.setAttr("aria-label", "选择同名文件处理方式");
    modeButton.setAttr("title", `当前：${this.plugin.settings.overwriteSameName ? "同名覆盖" : "同名不覆盖"}`);
    modeButton.addEventListener("click", (event) => this.showCollisionModeMenu(event));

    const settingsButton = toolbar.createEl("button", { text: "设置" });
    settingsButton.addEventListener("click", () => this.plugin.openSettings());

    this.plugin.renderSyncStatus(this.contentEl);

    const articles = this.plugin.getSortedArticles();
    if (!articles.length) {
      this.contentEl.createEl("p", {
        text: "目标文件夹中暂未找到已同步文章。",
      });
      return;
    }

    const totalPages = Math.ceil(articles.length / ARTICLES_PER_PAGE);
    this.currentPage = Math.min(this.currentPage, totalPages - 1);
    const pageStart = this.currentPage * ARTICLES_PER_PAGE;
    const pageArticles = articles.slice(pageStart, pageStart + ARTICLES_PER_PAGE);

    const list = this.contentEl.createEl("ul", { cls: "ima-speed-sync-list" });
    for (const file of pageArticles) {
      const item = list.createEl("li");
      const articleButton = item.createEl("button", { text: file.basename });
      articleButton.addEventListener("click", () => {
        void this.plugin.app.workspace.getLeaf(false).openFile(file);
      });
    }

    const pagination = this.contentEl.createDiv({ cls: "ima-speed-sync-pagination" });
    const previousButton = pagination.createEl("button", { text: "上一页" });
    previousButton.disabled = this.currentPage === 0;
    previousButton.addEventListener("click", () => {
      if (this.currentPage === 0) return;
      this.currentPage--;
      this.render();
    });

    pagination.createSpan({
      text: `第 ${this.currentPage + 1} / ${totalPages} 页 · 共 ${articles.length} 篇`,
      cls: "ima-speed-sync-page-status",
    });

    const nextButton = pagination.createEl("button", { text: "下一页" });
    nextButton.disabled = this.currentPage >= totalPages - 1;
    nextButton.addEventListener("click", () => {
      if (this.currentPage >= totalPages - 1) return;
      this.currentPage++;
      this.render();
    });
  }

  private showCollisionModeMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("同名不覆盖")
        .setIcon("shield-check")
        .setChecked(!this.plugin.settings.overwriteSameName)
        .onClick(async () => this.plugin.setOverwriteSameName(false)),
    );
    menu.addItem((item) =>
      item
        .setTitle("同名覆盖")
        .setIcon("replace")
        .setChecked(this.plugin.settings.overwriteSameName)
        .onClick(async () => this.plugin.setOverwriteSameName(true)),
    );
    menu.showAtMouseEvent(event);
  }
}

class ImaSpeedSyncSettingTab extends PluginSettingTab {
  constructor(
    app: Plugin["app"],
    private readonly plugin: ImaSpeedSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();

    const supportCard = containerEl.createDiv({ cls: "ima-share-sync-support" });
    const supportIcon = supportCard.createDiv({
      cls: "ima-share-sync-support-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(supportIcon, "star");
    const supportCopy = supportCard.createDiv({ cls: "ima-share-sync-support-copy" });
    supportCopy.createDiv({
      cls: "ima-share-sync-support-title",
      text: "喜欢这个插件？",
    });
    supportCopy.createDiv({
      cls: "ima-share-sync-support-description",
      text: "欢迎在 GitHub 上点个 Star，支持 IMA Share Sync 持续改进。",
    });
    supportCard.createEl("a", {
      cls: "ima-share-sync-support-link",
      text: "去 GitHub 点星",
      attr: {
        href: GITHUB_REPOSITORY_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": "打开 IMA Share Sync 的 GitHub 仓库，手动点星支持插件",
      },
    });

    if (!Platform.isWin) {
      containerEl.createEl("p", {
        text: "IMA Share Sync 依赖 Windows UI 自动化和 PowerShell，仅支持 Windows。",
        cls: "mod-warning",
      });
    }

    new Setting(containerEl)
      .setName("Obsidian 启动时同步")
      .setDesc("工作区加载完成后自动检查 IMA。默认关闭。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          if (value && !(await this.plugin.ensureConsent(true))) {
            toggle.setValue(false);
            return;
          }
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("内容模式")
      .setDesc("通用文字支持普通标题、短文和无目录正文；速看预设保留旧筛选和排版。切换模式会改变检查范围。")
      .addDropdown((dropdown) => dropdown
        .addOption("general", "通用文字")
        .addOption("speed-reader", "速看预设（兼容旧版）")
        .setValue(this.plugin.settings.contentMode)
        .onChange(async (value) => {
          this.plugin.settings.contentMode = value === "general" ? "general" : "speed-reader";
          await this.plugin.saveSettings();
          this.renderSettings();
        }));

    if (this.plugin.settings.contentMode === "general") {
      new Setting(containerEl)
        .setName("标题筛选")
        .setDesc("默认不限标题。仅在目标文章列表内筛选，不把日期、摘要或文件夹当成文章。")
        .addDropdown((dropdown) => dropdown
          .addOption("all", "全部标题")
          .addOption("contains", "包含关键词")
          .addOption("prefix", "指定前缀")
          .addOption("regex", "正则表达式（高级）")
          .setValue(this.plugin.settings.titleFilterMode)
          .onChange(async (value) => {
            this.plugin.settings.titleFilterMode = value as ImaSpeedSyncSettings["titleFilterMode"];
            await this.plugin.saveSettings();
            this.renderSettings();
          }));
      if (this.plugin.settings.titleFilterMode !== "all") {
        new Setting(containerEl)
          .setName("筛选内容")
          .setDesc("筛选先于最近文章数量限制。正则语法以 Windows PowerShell 为准，错误会在打开 IMA 前提示。")
          .addText((text) => text
            .setValue(this.plugin.settings.titleFilter)
            .onChange(async (value) => {
              this.plugin.settings.titleFilter = value;
              await this.plugin.saveSettings();
            }));
      }
    }

    new Setting(containerEl)
      .setName("允许短时前台操作")
      .setDesc("默认关闭。优先不移动鼠标、不切换焦点；必要时在电脑空闲后短暂置前，滚轮回退累计最多约 8 秒（不含 IMA 自身弹窗）。无法安全读取时停止，不反复抢焦点。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowForeground)
        .onChange(async (value) => {
          this.plugin.settings.allowForeground = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("知识库名称")
      .setDesc("填写 IMA 侧边栏中显示的完整知识库名称。")
      .addText((text) =>
        text
          .setPlaceholder("例如：我的知识库")
          .setValue(this.plugin.settings.knowledgeBaseName)
          .onChange(async (value) => {
            this.plugin.settings.knowledgeBaseName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("IMA 文件夹名称")
      .setDesc("填写要同步的 IMA 分享文章所在的完整文件夹名称。")
      .addText((text) =>
        text
          .setPlaceholder("例如：每日速看")
          .setValue(this.plugin.settings.folderName)
          .onChange(async (value) => {
            this.plugin.settings.folderName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("保存文件夹")
      .setDesc("同步后的 Markdown 文件在当前仓库中的保存路径。")
      .addText((text) =>
        text
          .setPlaceholder("例如：IMA Share Sync")
          .setValue(this.plugin.settings.destinationPath)
          .onChange(async (value) => {
            this.plugin.settings.destinationPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("覆盖同名文件")
      .setDesc("默认关闭。通用模式仅允许更新已确认同一来源的文件；同名不同来源或身份不明时始终保留原文件。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.overwriteSameName)
          .onChange(async (value) => {
            await this.plugin.setOverwriteSameName(value);
          }),
      );

    new Setting(containerEl)
      .setName("检查最近文章数")
      .setDesc("每次从 IMA 文件夹顶部检查的文章数量，可设置为 1–30 篇。")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.maxItems)
          .onChange(async (value) => {
            this.plugin.settings.maxItems = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("外部应用访问授权")
      .setDesc("清除之前的授权，下次同步前重新询问。")
      .addButton((button) =>
        button.setButtonText("重置授权").onClick(async () => {
          this.plugin.settings.hasConsented = false;
          this.plugin.settings.autoSync = false;
          await this.plugin.saveSettings();
          this.plugin.notifyManual("IMA Share Sync 授权已重置。下次同步时会重新询问。");
        }),
      );

    new Setting(containerEl).setName("同步提醒").setHeading();
    const notificationSettings: [NotificationSetting, string, string][] = [
      ["notificationsEnabled", "启用同步提醒", "总开关。关闭后不弹气泡、不显示图标异常标记；同步记录仍然保留。"],
      ["notifyAutoSuccess", "自动同步成功提醒", "默认关闭。开启后，自动同步完成时显示一次汇总提醒。"],
      ["notifyAutoFailure", "自动同步失败提醒", "默认开启。自动同步失败、部分文章失败或同名冲突时，显示一次汇总提醒。"],
      ["notifyManualResult", "手动同步结果提醒", "默认开启。控制手动同步的结果及操作提示，包含失败提醒。关闭后可在面板查看结果。"],
      ["showErrorBadge", "图标异常标记", "默认开启。有未读同步异常时显示黄点；查看记录或详情后消除，并记住已读状态。下一次同步出现异常时重新提示。"],
      ["showOperationBefore", "操作前提示", "自动同步前倒计时 5 秒，可推迟或取消。手动同步立即开始；运行中均可停止。"],
      ["showOperationAfter", "操作结束提示", "默认开启。桌面卡片显示最终结果，成功 5 秒后收起，异常需手动关闭。有卡片时不重复弹结果气泡。"],
    ];
    for (const [key, name, description] of notificationSettings) {
      new Setting(containerEl).setName(name).setDesc(description).addToggle((toggle) =>
        toggle.setValue(this.plugin.settings[key])
          .setDisabled(key !== "notificationsEnabled" && !this.plugin.settings.notificationsEnabled)
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            this.plugin.updateNotificationPreferences();
            if (key === "notificationsEnabled") this.renderSettings();
            try {
              await this.plugin.saveSettings();
            } catch (error) {
              console.error("保存 IMA Share Sync 提醒设置失败", error);
              this.plugin.notifyManual("提醒设置未能保存，重启后可能恢复原设置。请检查仓库写入权限。");
            }
          }),
      );
    }
  }
}

export default class ImaSpeedSyncPlugin extends Plugin {
  override settings: ImaSpeedSyncSettings = { ...DEFAULT_SETTINGS };
  private running = false;
  private currentProcess: ChildProcess | null = null;
  private cancellationPath: string | null = null;
  private cancellationRequested = false;
  private consentPromise: Promise<boolean> | null = null;
  private activeRun: SyncRun | null = null;
  private nextRunId = 1;
  private unloaded = false;
  private syncReports: SyncReport[] = [];
  private historyPanel: SyncHistoryPanel | null = null;
  private historyHost: HTMLElement | null = null;
  private historyToggle: HTMLButtonElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private activeNotice: { notice: Notice; interactive: boolean; failed: boolean } | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private reportSaveFailed = false;
  private operationCards = new Set<DesktopOperationCard>();
  private deferredSyncTimer: number | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  override async onload(): Promise<void> {
    this.unloaded = false;
    addIcon(IMA_SHARE_SYNC_ICON_ID, IMA_SHARE_SYNC_ICON_SVG);
    const stored = (await this.loadData()) as (Partial<ImaSpeedSyncSettings> & { syncReports?: unknown }) | null;
    const { syncReports, ...saved } = stored ?? {};
    this.syncReports = restoreSyncReports(syncReports);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      // An existing installation must not silently expand from speed-reader titles to all articles.
      contentMode: saved.contentMode ?? (stored ? "speed-reader" : "general"),
    };
    for (const key of ["notificationsEnabled", "notifyAutoSuccess", "notifyAutoFailure", "notifyManualResult", "showErrorBadge", "showOperationBefore", "showOperationAfter"] as const) {
      if (typeof this.settings[key] !== "boolean") this.settings[key] = DEFAULT_SETTINGS[key];
    }

    this.addSettingTab(new ImaSpeedSyncSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new ImaSpeedSyncView(leaf, this));
    this.ribbonEl = this.addRibbonIcon(IMA_SHARE_SYNC_ICON_ID, "打开 IMA Share Sync", () => {
      if (this.settings.notificationsEnabled && this.settings.showErrorBadge && this.hasUnreadSyncFailure()) {
        const failed = this.syncReports.find((report) => report.status === "failed" && !report.read);
        this.openSyncHistory(failed ? [failed] : undefined);
      } else {
        void this.activateView();
      }
    });
    this.updateNotificationPreferences();

    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => void this.sync(true),
    });
    this.addCommand({
      id: "cancel-sync",
      name: "取消同步",
      callback: () => void this.cancelSync(),
    });

    if (Platform.isWin) {
      this.app.workspace.onLayoutReady(() => {
        if (this.settings.autoSync && this.settings.hasConsented) {
          void this.sync(false);
        }
      });
    }
  }

  override onunload(): void {
    this.unloaded = true;
    this.activeNotice?.notice.hide();
    this.activeNotice = null;
    if (this.deferredSyncTimer !== null) window.clearTimeout(this.deferredSyncTimer);
    this.deferredSyncTimer = null;
    for (const card of this.operationCards) void card.dispose();
    this.operationCards.clear();
    const run = this.activeRun;
    if (!run) return;

    run.cancellationRequested = true;
    this.cancellationRequested = true;
    void this.writeCancellationMarker(run).catch((error) => {
      console.error("卸载 IMA Share Sync 时写入取消标记失败", error);
    });
    if (run.process && !run.process.killed) {
      try {
        run.process.kill();
      } catch (error) {
        console.error("卸载 IMA Share Sync 时终止 PowerShell 失败", error);
      }
    }
  }

  async saveSettings(): Promise<void> {
    const save = this.saveQueue.catch(() => undefined).then(() => this.saveData({
      ...this.settings,
      syncReports: this.syncReports,
    }));
    this.saveQueue = save;
    await save;
  }

  private canNotify(interactive: boolean, failed: boolean): boolean {
    return !this.unloaded && this.settings.notificationsEnabled && (interactive
      ? this.settings.notifyManualResult
      : failed ? this.settings.notifyAutoFailure : this.settings.notifyAutoSuccess);
  }

  notifyManual(message: string, duration = 5000): void {
    this.notify(message, true, false, duration);
  }

  private notify(message: string, interactive: boolean, failed: boolean, duration: number, report?: SyncReport): void {
    if (!this.canNotify(interactive, failed)) return;
    this.activeNotice?.notice.hide();
    const notice = new Notice(message, duration);
    this.activeNotice = { notice, interactive, failed };
    if (report) {
      const detailsButton = notice.messageEl.createEl("button", { text: "查看详情", cls: "ima-share-sync-notice-details" });
      detailsButton.addEventListener("click", () => {
        notice.hide();
        this.openSyncHistory([report]);
      });
    }
  }

  updateNotificationPreferences(): void {
    if (this.activeNotice && !this.canNotify(this.activeNotice.interactive, this.activeNotice.failed)) {
      this.activeNotice.notice.hide();
      this.activeNotice = null;
    }
    const showBadge = this.settings.notificationsEnabled && this.settings.showErrorBadge && this.hasUnreadSyncFailure();
    this.ribbonEl?.toggleClass("ima-share-sync-has-warning", showBadge);
    this.ribbonEl?.setAttr("aria-label", showBadge ? "IMA Share Sync：有未读异常，点击查看记录" : "打开 IMA Share Sync");
    if (!this.settings.notificationsEnabled || !this.settings.showOperationAfter) {
      for (const card of this.operationCards) {
        if (card !== this.activeRun?.card) void card.dispose();
      }
    }
  }

  private hasUnreadSyncFailure(): boolean {
    const latest = this.syncReports.find((report) => report.status !== "canceled");
    return latest?.status === "failed" && latest.read !== true;
  }

  openSyncHistory(focusedReports?: readonly SyncReport[]): void {
    this.historyPanel = new SyncHistoryPanel(() => {
      const reports = [...this.syncReports];
      for (const report of focusedReports ?? []) {
        if (!reports.some((stored) => stored.id === report.id)) reports.push(report);
      }
      return reports.sort((left, right) => right.finishedAt - left.finishedAt);
    }, focusedReports?.[0]?.id,
    (viewed) => { void this.markSyncReportsRead(viewed); },
    () => {
      this.historyPanel = null;
      this.historyToggle?.setAttr("aria-expanded", "false");
    });
    this.historyToggle?.setAttr("aria-expanded", "true");
    if (this.historyHost) this.historyPanel.mount(this.historyHost);
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const reveal = existing ? this.app.workspace.revealLeaf(existing) : this.activateView();
    void reveal.catch((error) => { console.error("打开同步日志失败", error); this.notifyManual("无法打开同步日志，请重新打开插件侧栏。"); });
  }

  private async markSyncReportsRead(reports: readonly SyncReport[]): Promise<void> {
    if (this.unloaded) return;
    const viewedIds = new Set(reports.filter((report) => report.id && report.status === "failed").map((report) => report.id));
    let changed = false;
    this.syncReports = this.syncReports.map((report) => {
      if (report.read || !viewedIds.has(report.id)) return report;
      changed = true;
      return { ...report, read: true };
    });
    if (!changed) return;
    this.updateNotificationPreferences();
    try {
      await this.saveSettings();
    } catch (error) {
      console.error("保存同步异常已读状态失败", error);
      this.notifyManual("异常已标记为已读，但保存失败，重启后可能再次显示黄点。请检查仓库写入权限。");
    }
  }

  renderSyncStatus(containerEl: HTMLElement): void {
    const latest = this.syncReports[0];
    const status = containerEl.createDiv({ cls: "ima-share-sync-status" });
    this.historyToggle = status.createEl("button", { text: `同步日志（${this.syncReports.length}）` });
    this.historyToggle.setAttr("aria-expanded", String(!!this.historyPanel));
    this.historyToggle.addEventListener("click", () => {
      if (this.historyPanel) this.historyPanel.close();
      else this.openSyncHistory();
    });
    if (this.running) status.createEl("p", { text: "正在同步，可随时取消…" });
    if (latest) {
      status.createSpan({ text: `最近：${latest.status === "failed" ? "有异常" : latest.status === "canceled" ? "已取消" : "已完成"}`, cls: "ima-share-sync-latest-status" });
      if (latest.status === "failed") {
        status.createEl("button", { text: "查看本次异常" }).addEventListener("click", () => this.openSyncHistory([latest]));
      }
      if (this.reportSaveFailed) status.createEl("p", { text: "同步记录未能写入配置文件，本次结果仅在当前会话保留。" });
    }
    this.historyHost = containerEl.createDiv({ cls: "ima-share-sync-history" });
    this.historyPanel?.mount(this.historyHost);
  }

  private async recordSyncReport(report: SyncReport, showNotice = true): Promise<void> {
    if (this.unloaded) return;
    report.id = randomUUID();
    report.read = false;
    // Normalize only the new record; never discard older runs or repeatedly re-parse history.
    const normalized = restoreSyncReports([report]);
    this.syncReports = [...normalized, ...this.syncReports];
    if (this.activeRun) this.activeRun.report = report;
    this.updateNotificationPreferences();
    try {
      await this.saveSettings();
      this.reportSaveFailed = false;
    } catch (error) {
      this.reportSaveFailed = true;
      console.error("保存 IMA Share Sync 同步记录失败", error);
    }
    if (showNotice && (!this.activeRun?.card || !this.settings.showOperationAfter) && (report.status !== "canceled" || report.interactive)) {
      this.notify(report.summary, report.interactive, report.status === "failed", report.status === "failed" ? 10000 : 5000, report);
    }
  }

  private async openOperationCard(run: SyncRun, interactive: boolean): Promise<DesktopOperationCard | null> {
    const card = new DesktopOperationCard(() => {
      if (this.activeRun === run && !run.report) void this.cancelSync().catch((error) => console.error("停止同步失败", error));
    }, () => {
      if (run.report) void this.markSyncReportsRead([run.report]);
    }, () => this.operationCards.delete(card));
    this.operationCards.add(card);
    run.card = card;
    try {
      await card.open(!interactive && this.settings.notificationsEnabled && this.settings.showOperationBefore);
    } catch (error) {
      run.card = undefined;
      this.operationCards.delete(card);
      throw error;
    }
    return card;
  }

  private updateOperationCard(run: SyncRun, text: string): void {
    if (!run.card || run.cancellationRequested || this.unloaded) return;
    void run.card.update({ phase: "running", text }).catch((error) => {
      console.error("桌面操作提示更新失败，停止同步", error);
      void this.cancelSync().catch((cancelError) => console.error(cancelError));
    });
  }

  private scheduleDeferredSync(interactive: boolean, maxItems?: number): void {
    if (this.deferredSyncTimer !== null) window.clearTimeout(this.deferredSyncTimer);
    this.deferredSyncTimer = window.setTimeout(() => {
      this.deferredSyncTimer = null;
      if (!this.unloaded && !this.running) void this.sync(interactive, maxItems);
    }, 5 * 60 * 1000);
  }

  async setOverwriteSameName(value: boolean): Promise<void> {
    if (this.settings.overwriteSameName === value) return;
    this.settings.overwriteSameName = value;
    await this.saveSettings();
    this.refreshView();
  }

  async cancelSync(): Promise<void> {
    const run = this.activeRun;
    if (!run) {
      this.notifyManual("当前没有正在运行的 IMA Share Sync。", 3000);
      return;
    }
    if (run.cancellationRequested) return;

    run.cancellationRequested = true;
    this.cancellationRequested = true;
    await this.writeCancellationMarker(run);
    if (run.card) await run.card.stop();
    else this.notifyManual("正在取消 IMA Share Sync…", 3000);
  }

  openSettings(): void {
    const settings = (this.app as Plugin["app"] & { setting?: SettingsController }).setting;
    if (!settings) {
      this.notifyManual("无法打开插件设置，请从 Obsidian 设置中的“第三方插件”进入。");
      return;
    }
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  async ensureConsent(interactive: boolean): Promise<boolean> {
    if (this.settings.hasConsented) return true;
    if (!interactive || !Platform.isWin) return false;
    if (this.consentPromise) return this.consentPromise;

    this.consentPromise = new Promise<boolean>((resolve) => {
      new ConsentModal(this.app, (allowed) => {
        void this.completeConsent(allowed, resolve);
      }).open();
    });
    return this.consentPromise;
  }

  async activateView(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      this.notifyManual("无法创建 IMA Share Sync 侧边栏。");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  isDestinationArticlePath(filePath: string): boolean {
    let destinationPath: string;
    try {
      destinationPath = this.resolveDestinationPath(this.settings.destinationPath);
    } catch {
      return false;
    }
    const normalizedFilePath = normalizePath(filePath);
    return (
      normalizedFilePath.startsWith(`${destinationPath}/`) &&
      normalizedFilePath.slice(destinationPath.length + 1).length > 0 &&
      !normalizedFilePath.slice(destinationPath.length + 1).includes("/") &&
      normalizedFilePath.toLocaleLowerCase().endsWith(".md")
    );
  }

  getSortedArticles(): TFile[] {
    let folderPath: string;
    try {
      folderPath = this.resolveDestinationPath();
    } catch {
      return [];
    }
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];

    return folder.children
      .filter(
        (file): file is TFile =>
          file instanceof TFile &&
          file.extension === "md",
      )
      .sort((left, right) => {
        const leftTitleDate = this.getArticleTitleTimestamp(left);
        const rightTitleDate = this.getArticleTitleTimestamp(right);
        if (leftTitleDate !== null || rightTitleDate !== null) {
          if (leftTitleDate === null) return 1;
          if (rightTitleDate === null) return -1;
          if (leftTitleDate !== rightTitleDate) return rightTitleDate - leftTitleDate;
        }
        return (
          this.getArticleSourceTimestamp(right) - this.getArticleSourceTimestamp(left) ||
          right.basename.localeCompare(left.basename, "zh-CN", { numeric: true })
        );
      });
  }

  private getArticleSourceTimestamp(file: TFile): number {
    const metadata = this.app.metadataCache?.getFileCache(file)?.frontmatter;
    const value: unknown = metadata?.ima_updated;
    return this.isValidSourceDate(value) && metadata?.ima_sync_plugin === PLUGIN_MARKER
      ? Date.parse(`${value}T00:00:00Z`)
      : file.stat.ctime;
  }

  private getArticleTitleTimestamp(file: TFile): number | null {
    const title = file.basename.trim().replace(/\s*\(\d+\)$/, "");
    const fullDate =
      title.match(/(?:^|\D)(\d{4})[-_./年](\d{1,2})[-_./月](\d{1,2})日?(?:$|\D)/) ??
      title.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?:$|\D)/);
    if (fullDate) {
      return this.createDateTimestamp(
        Number(fullDate[1]),
        Number(fullDate[2]),
        Number(fullDate[3]),
      );
    }

    const shortDate =
      title.match(/(?:^|\D)(\d{1,2})[-_./月](\d{1,2})日?$/) ??
      title.match(/(?:^|\D)(\d{2})(\d{2})$/);
    if (!shortDate) return null;

    const month = Number(shortDate[1]);
    const day = Number(shortDate[2]);
    const frontmatter = this.app.metadataCache?.getFileCache(file)?.frontmatter as unknown;
    const metadataDate =
      frontmatter && typeof frontmatter === "object"
        ? (frontmatter as Record<string, unknown>).ima_updated
        : undefined;
    if (typeof metadataDate === "string") {
      const metadataMatch = metadataDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (
        metadataMatch &&
        Number(metadataMatch[2]) === month &&
        Number(metadataMatch[3]) === day
      ) {
        return this.createDateTimestamp(Number(metadataMatch[1]), month, day);
      }
    }

    const reference = new Date(Number.isFinite(file.stat.ctime) ? file.stat.ctime : Date.now());
    let year = reference.getFullYear();
    const timestamp = this.createDateTimestamp(year, month, day);
    if (timestamp === null) return null;
    const halfYear = 183 * 24 * 60 * 60 * 1000;
    if (timestamp - reference.getTime() > halfYear) {
      year--;
    }
    return this.createDateTimestamp(year, month, day);
  }

  private createDateTimestamp(year: number, month: number, day: number): number | null {
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return timestamp;
  }

  refreshView(): void {
    this.updateNotificationPreferences();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ImaSpeedSyncView) view.render();
    }
  }

  async sync(interactive: boolean, maxItems?: number): Promise<void> {
    if (this.running) {
      if (interactive) this.notifyManual("IMA Share Sync 正在运行，请稍候。");
      return;
    }
    if (this.unloaded) return;
    if (!Platform.isWin) {
      if (interactive) this.notifyManual("IMA Share Sync 仅支持 Windows。");
      return;
    }

    if (this.deferredSyncTimer !== null) window.clearTimeout(this.deferredSyncTimer);
    this.deferredSyncTimer = null;
    for (const card of this.operationCards) void card.dispose();
    this.operationCards.clear();

    const settings = Object.freeze({
      ...this.settings,
      maxItems: maxItems ?? this.settings.maxItems,
    });
    const run: SyncRun = {
      id: this.nextRunId++,
      cancellationPath: null,
      cancellationRequested: false,
      process: null,
    };
    // The gate is closed synchronously before the first await, so two button clicks
    // cannot both enter and later clear one another's process/cancellation state.
    this.activeRun = run;
    this.cancellationRequested = false;
    this.running = true;
    this.refreshView();
    const counts: Record<SaveStatus, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0, conflict: 0 };
    const issues: ExtractionError[] = [];
    try {
      if (!(await this.ensureConsent(interactive))) {
        await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "canceled", summary: "未开始：尚未授权。", errors: [] }, false);
        return;
      }
      this.assertRunActive(run);
      const destinationPath = this.validateSettings(settings);
      await this.ensureFolder(destinationPath);
      this.assertRunActive(run);
      const articleIndex = await this.buildArticleIndex(destinationPath);
      this.assertRunActive(run);
      const skipTitles = settings.overwriteSameName
        ? []
        : settings.contentMode === "speed-reader" ? this.getExistingArticleTitles(articleIndex) : [];
      const skipSourceIds = settings.overwriteSameName ? [] : this.getExistingSourceIds(articleIndex, settings);
      const card = await this.openOperationCard(run, interactive);
      if (card) {
        const decision = await card.decision;
        if (decision !== "start") {
          if (decision === "later" && !this.unloaded) this.scheduleDeferredSync(interactive, maxItems);
          await card.dispose();
          run.card = undefined;
          await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "canceled",
            summary: decision === "later" ? "已推迟：5 分钟后重试。" : "已取消：未开始操作。", errors: [] }, false);
          return;
        }
      }
      this.assertRunActive(run);
      this.updateOperationCard(run, "正在打开 IMA…");
      const rawResult = await this.runPowerShell(settings.maxItems, skipTitles, settings, run, skipSourceIds);
      this.assertRunActive(run, true);
      const result = this.parseExtractionResult(rawResult);
      if (result.busy) {
        await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "canceled", summary: "未开始：已有其他同步任务运行。", errors: [] }, false);
        if (interactive) this.notifyManual("另一个窗口正在运行 IMA Share Sync。");
        return;
      }
      this.updateOperationCard(run, "正在保存文章…");
      const extractionCanceled = result.canceled === true;
      if (!extractionCanceled) this.assertRunActive(run);

      counts.skipped = result.skippedTitles?.length ?? 0;
      issues.push(...(result.errors ?? []));
      const items = [...(result.items ?? [])].sort(
        (left, right) =>
          (left.updatedDate ?? "").localeCompare(right.updatedDate ?? "") ||
          left.sourceTitle.localeCompare(right.sourceTitle),
      );
      const saveErrors: ExtractionError[] = [];
      for (const item of items) {
        this.assertRunActive(run, extractionCanceled);
        try {
          const status = await this.saveArticle(
            item,
            destinationPath,
            articleIndex,
            settings,
            run,
            extractionCanceled,
          );
          counts[status]++;
          if (status === "conflict") issues.push({ title: item.sourceTitle, message: "同名冲突：无法确认是同一篇文章，已保留原文件，请检查后重试。" });
        } catch (error) {
          if (error instanceof SyncCanceledError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const saveError = {
            title: this.normalizeSourceTitle(item.sourceTitle),
            message: message.trim().slice(0, 600),
          };
          saveErrors.push(saveError);
          issues.push(saveError);
        }
      }

      const errors = [...(result.errors ?? []), ...saveErrors];
      const preserved = counts.created + counts.updated + counts.unchanged;
      const resultParts = [
        counts.created ? `新增 ${counts.created} 篇` : "",
        counts.updated ? `更新 ${counts.updated} 篇` : "",
        counts.unchanged ? `无变化 ${counts.unchanged} 篇` : "",
        counts.skipped ? `跳过 ${counts.skipped} 篇` : "",
        counts.conflict ? `同名冲突 ${counts.conflict} 篇（未覆盖）` : "",
        errors.length ? `失败 ${errors.length} 篇` : "",
      ].filter(Boolean).join(" · ");
      const summary = extractionCanceled
        ? `同步已取消：已保留 ${preserved} 篇${resultParts ? ` · ${resultParts}` : ""}`
        : `同步${errors.length || counts.conflict ? "有异常" : "完成"}：${resultParts || "暂无新文章"}`;
      await this.recordSyncReport({
        finishedAt: Date.now(), interactive,
        status: errors.length || counts.conflict ? "failed" : extractionCanceled ? "canceled" : "success",
        summary, errors: issues,
      });
      if (errors.length) console.error("IMA Share Sync 存在文章处理失败", errors);
    } catch (error) {
      if (error instanceof SyncCanceledError || run.cancellationRequested || this.unloaded) {
        await this.recordSyncReport({
          finishedAt: Date.now(), interactive, status: issues.length ? "failed" : "canceled",
          summary: `同步已取消：已保留 ${counts.created + counts.updated + counts.unchanged} 篇` +
            (counts.skipped ? ` · 跳过 ${counts.skipped} 篇` : "") +
            (issues.length ? ` · 异常 ${issues.length} 项` : ""),
          errors: issues,
        });
        return;
      }
      const detail = (error instanceof Error ? error.message : String(error)).trim().slice(0, 600);
      console.error("IMA Share Sync 失败", error);
      await this.recordSyncReport({
        finishedAt: Date.now(), interactive, status: "failed",
        summary: detail.length <= 60 && !/[\r\n]/.test(detail) ? `同步失败：${detail}` : "同步失败，请查看原因。",
        errors: [...issues, { title: "同步任务", message: detail }],
      });
    } finally {
      if (run.card) {
        const report = run.report;
        try {
          if (report && !this.unloaded && this.settings.notificationsEnabled && this.settings.showOperationAfter) {
            await run.card.finish({
              phase: report.status, text: report.summary.replace(/^同步(?:完成|有异常|已取消)：/, ""),
              details: report.errors.length ? report.errors.slice(0, 3).map((error) => {
                const message = /未能完整读取|未到达底部|未读取.*底部|正文未完整/.test(error.message)
                  ? "正文未读取完整，请重试。"
                  : (error.title && (error.message.startsWith(`${error.title}：`) || error.message.startsWith(`${error.title}:`))
                    ? error.message.slice(error.title.length + 1).trim() : error.message).slice(0, 120);
                return `${error.title || "同步任务"}：${message}`;
              }).join("\n\n") + (report.errors.length > 3 ? `\n另有 ${report.errors.length - 3} 项，详见同步记录。` : "") : "",
            });
          } else {
            await run.card.dispose();
          }
        } catch (error) {
          console.error("关闭桌面操作提示失败", error);
          await run.card.dispose();
        }
      }
      if (this.activeRun === run) {
        this.activeRun = null;
        this.running = false;
        this.currentProcess = null;
        this.cancellationRequested = false;
        this.cancellationPath = null;
        if (!this.unloaded) this.refreshView();
      }
    }
  }

  private validateSettings(settings: Readonly<ImaSpeedSyncSettings>): string {
    if (!settings.knowledgeBaseName.trim()) {
      throw new Error("请先填写完整的 IMA 知识库名称。");
    }
    if (!settings.folderName.trim()) {
      throw new Error("请先填写完整的 IMA 文件夹名称。");
    }
    if (!Number.isInteger(settings.maxItems) || settings.maxItems < 1 || settings.maxItems > 30) {
      throw new Error("检查最近文章数必须在 1–30 之间。");
    }
    if (!["general", "speed-reader"].includes(settings.contentMode)) throw new Error("内容模式无效。");
    if (!["all", "contains", "prefix", "regex"].includes(settings.titleFilterMode)) throw new Error("标题筛选方式无效。");
    if (settings.contentMode === "general" && settings.titleFilterMode !== "all" && !settings.titleFilter.trim()) {
      throw new Error("请填写标题筛选内容，或选择“全部标题”。");
    }
    if (settings.titleFilter.length > 300) throw new Error("标题筛选内容不能超过 300 个字符。");
    return this.resolveDestinationPath(settings.destinationPath);
  }

  private resolveDestinationPath(destinationPath = this.settings.destinationPath): string {
    const raw = destinationPath.trim().replace(/\\/g, "/");
    if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
      throw new Error("保存文件夹必须是当前仓库内的相对路径。");
    }
    const destination = normalizePath(raw);
    if (destination === ".." || destination.startsWith("../") || destination.split("/").includes("..")) {
      throw new Error("保存文件夹不能位于当前仓库之外。");
    }
    const configDir = normalizePath(this.app.vault.configDir);
    if (destination === configDir || destination.startsWith(`${configDir}/`)) {
      throw new Error("保存文件夹不能位于 Obsidian 配置目录中。");
    }
    return destination;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    let current = "";
    for (const part of folderPath.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`保存路径中的这一项是文件，无法作为文件夹使用：${current}`);
      }
    }
  }

  private async saveArticle(
    item: ExtractedArticle,
    destinationPath: string,
    articleIndex: SyncedArticleIndex,
    settings: Readonly<ImaSpeedSyncSettings>,
    run: SyncRun,
    allowCancellation: boolean,
  ): Promise<SaveStatus> {
    const general = settings.contentMode === "general";
    if ((!general || item.updatedDate) && !this.isValidSourceDate(item.updatedDate)) {
      throw new Error(`IMA 返回的文章日期无效：${item.sourceTitle}`);
    }
    if (!item.body.trim() || (general ? item.complete !== true : item.body.trim().length < 1000)) {
      throw new Error(`IMA 返回的文章正文不完整：${item.sourceTitle}`);
    }

    const sourceTitle = this.normalizeSourceTitle(item.sourceTitle);
    const sourceKey = general ? this.createGeneralSourceKey(item, settings) : this.createSourceKey(sourceTitle, settings);
    let existing =
      articleIndex.bySourceKey.get(sourceKey) ??
      (general ? undefined : articleIndex.legacyBySourceTitle.get(sourceTitle));
    const preferredBasename = this.sanitizeBasename(sourceTitle);
    if (!general) existing ??= articleIndex.markdownByBasename.get(preferredBasename.toLocaleLowerCase());
    const preferredFileName = `${preferredBasename}.md`.toLocaleLowerCase();
    if (general && !existing && articleIndex.occupiedFileNames.has(preferredFileName)) {
      console.warn(`IMA 同名冲突：${sourceTitle}；来源不同或无法确认，未覆盖原文件。`);
      return "conflict";
    }
    if (!settings.overwriteSameName && (existing || articleIndex.occupiedFileNames.has(preferredFileName))) {
      return "skipped";
    }
    const basename = existing
      ? existing.basename
      : preferredBasename;
    const filePath = existing?.path ?? normalizePath(`${destinationPath}/${basename}.md`);
    const markdown = this.formatArticleMarkdown(item, sourceTitle, sourceKey, settings);

    if (!existing) {
      this.assertRunActive(run, allowCancellation);
      const created = await this.app.vault.create(filePath, markdown);
      articleIndex.bySourceKey.set(sourceKey, created);
      articleIndex.markdownByBasename.set(basename.toLocaleLowerCase(), created);
      articleIndex.occupiedFileNames.add(`${basename}.md`.toLocaleLowerCase());
      articleIndex.sourceTitles.add(sourceTitle);
      return "created";
    }

    const current = await this.app.vault.read(existing);
    if (current === markdown) return "unchanged";
    if (general && !item.sourceId) {
      console.warn(`IMA 来源身份不明：${sourceTitle}；仅有内容指纹，未覆盖已有文件。`);
      return "conflict";
    }
    this.assertRunActive(run, allowCancellation);
    await this.app.vault.process(existing, () => markdown);
    articleIndex.bySourceKey.set(sourceKey, existing);
    articleIndex.markdownByBasename.set(existing.basename.toLocaleLowerCase(), existing);
    articleIndex.legacyBySourceTitle.delete(sourceTitle);
    return "updated";
  }

  private isValidSourceDate(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return !!match && this.createDateTimestamp(Number(match[1]), Number(match[2]), Number(match[3])) !== null;
  }

  private createSourceScope(settings: Readonly<ImaSpeedSyncSettings>): string {
    return createHash("sha256").update(settings.knowledgeBaseName.trim(), "utf8").digest("hex");
  }

  private createGeneralSourceKey(item: ExtractedArticle, settings: Readonly<ImaSpeedSyncSettings>): string {
    // A UI card identity is independent of the article title and folder. Without one,
    // exact content + source location is only a conservative same-content fallback.
    const identity = item.sourceId
      ? [this.createSourceScope(settings), "card", item.sourceId]
      : [this.createSourceScope(settings), settings.folderName.trim(), item.sourceTitle, "content", item.body.replace(/\r\n?/g, "\n").trim()];
    return `general:${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`;
  }

  private getExistingSourceIds(index: SyncedArticleIndex, settings: Readonly<ImaSpeedSyncSettings>): string[] {
    const scope = this.createSourceScope(settings);
    return [...new Set([...index.metadataByPath.values()]
      .filter((metadata) => metadata.sourceScope === scope && metadata.sourceId)
      .map((metadata) => metadata.sourceId!))];
  }

  private formatArticleMarkdown(
    item: ExtractedArticle,
    sourceTitle: string,
    sourceKey: string,
    settings: Readonly<ImaSpeedSyncSettings> = this.settings,
  ): string {
    let body = item.body.replace(/\r\n?/g, "\n").trim();
    body = body.replace(/^•\s*/gm, "- ");
    body = body.replace(/^◦\s*/gm, "  - ");
    if (settings.contentMode === "speed-reader") {
      body = body.replace(/^(一句话结论|利好\/利空|催化剂|原文)：\s*/gm, "**$1：** ");
      body = body.replace(/([^\n])\n(?=\*\*(?:一句话结论|利好\/利空|催化剂|原文)：\*\*)/g, "$1\n\n");
    } else {
      body = body.replace(/\uFFFC/g, "[内嵌内容：图片或附件暂未同步]");
    }

    return [
      "---",
      `ima_source_key: ${JSON.stringify(sourceKey)}`,
      `ima_source_title: ${JSON.stringify(sourceTitle)}`,
      ...(item.updatedDate ? [`ima_updated: ${item.updatedDate}`] : []),
      ...(settings.contentMode === "general" ? [
        `ima_source_scope: ${JSON.stringify(this.createSourceScope(settings))}`,
        ...(item.sourceId ? [`ima_source_id: ${JSON.stringify(item.sourceId)}`] : []),
        `ima_identity: ${item.sourceId ? "card" : "content-fallback"}`,
      ] : []),
      `ima_sync_plugin: ${PLUGIN_MARKER}`,
      "---",
      "",
      `# ${sourceTitle}`,
      "",
      body,
      "",
    ].join("\n");
  }

  private async buildArticleIndex(destinationPath: string): Promise<SyncedArticleIndex> {
    const folder = this.app.vault.getAbstractFileByPath(destinationPath);
    if (!(folder instanceof TFolder)) {
      throw new Error(`保存文件夹不存在：${destinationPath}`);
    }

    const bySourceKey = new Map<string, TFile>();
    const legacyBySourceTitle = new Map<string, TFile>();
    const ambiguousLegacyTitles = new Set<string>();
    const markdownByBasename = new Map<string, TFile>();
    const occupiedFileNames = new Set<string>();
    const sourceTitles = new Set<string>();
    const metadataByPath = new Map<string, SyncedArticleMetadata>();

    for (const child of folder.children) {
      occupiedFileNames.add(child.name.toLocaleLowerCase());
      if (!(child instanceof TFile) || child.extension.toLocaleLowerCase() !== "md") continue;

      markdownByBasename.set(child.basename.toLocaleLowerCase(), child);
      const metadata =
        this.getCachedSyncedArticleMetadata(child) ??
        this.parseSyncedArticleMetadata(await this.app.vault.read(child));
      metadataByPath.set(child.path, metadata);
      if (metadata.sourceTitle) {
        sourceTitles.add(metadata.sourceTitle);
      }
      if (metadata.sourceKey) {
        const indexed = bySourceKey.get(metadata.sourceKey);
        if (!indexed || child.stat.mtime > indexed.stat.mtime) {
          bySourceKey.set(metadata.sourceKey, child);
        }
        continue;
      }
      if (!metadata.sourceTitle || ambiguousLegacyTitles.has(metadata.sourceTitle)) continue;
      if (legacyBySourceTitle.has(metadata.sourceTitle)) {
        legacyBySourceTitle.delete(metadata.sourceTitle);
        ambiguousLegacyTitles.add(metadata.sourceTitle);
      } else {
        legacyBySourceTitle.set(metadata.sourceTitle, child);
      }
    }

    return {
      bySourceKey,
      legacyBySourceTitle,
      markdownByBasename,
      occupiedFileNames,
      sourceTitles,
      metadataByPath,
    };
  }

  private getCachedSyncedArticleMetadata(file: TFile): SyncedArticleMetadata | null {
    const cache = this.app.metadataCache?.getFileCache(file);
    if (!cache) return null;
    const frontmatter = cache.frontmatter;
    if (!frontmatter || typeof frontmatter !== "object") return {};

    const record = frontmatter as Record<string, unknown>;
    if (record.ima_sync_plugin !== PLUGIN_MARKER) return {};
    return {
      sourceKey: typeof record.ima_source_key === "string" ? record.ima_source_key : undefined,
      sourceTitle: typeof record.ima_source_title === "string" ? record.ima_source_title : undefined,
      sourceId: typeof record.ima_source_id === "string" ? record.ima_source_id : undefined,
      sourceScope: typeof record.ima_source_scope === "string" ? record.ima_source_scope : undefined,
    };
  }

  private getExistingArticleTitles(articleIndex: SyncedArticleIndex): string[] {
    const titles = new Set(articleIndex.sourceTitles);
    for (const file of articleIndex.markdownByBasename.values()) {
      titles.add(file.basename);
    }
    return [...titles];
  }

  private parseSyncedArticleMetadata(markdown: string): SyncedArticleMetadata {
    const normalized = markdown.replace(/\r\n?/g, "\n");
    if (!normalized.startsWith("---\n")) return {};
    const frontmatterEnd = normalized.indexOf("\n---\n", 4);
    if (frontmatterEnd < 0) return {};

    const frontmatter = normalized.slice(4, frontmatterEnd);
    if (this.readFrontmatterValue(frontmatter, "ima_sync_plugin") !== PLUGIN_MARKER) return {};
    return {
      sourceKey: this.readFrontmatterValue(frontmatter, "ima_source_key"),
      sourceTitle: this.readFrontmatterValue(frontmatter, "ima_source_title"),
      sourceId: this.readFrontmatterValue(frontmatter, "ima_source_id"),
      sourceScope: this.readFrontmatterValue(frontmatter, "ima_source_scope"),
    };
  }

  private readFrontmatterValue(frontmatter: string, key: string): string | undefined {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!match?.[1]) return undefined;
    const raw = match[1].trim();
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw;
    } catch {
      return raw;
    }
  }

  private normalizeSourceTitle(sourceTitle: string): string {
    const normalized = sourceTitle.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    return normalized || "未命名文章";
  }

  private createSourceKey(
    sourceTitle: string,
    settings: Readonly<ImaSpeedSyncSettings> = this.settings,
  ): string {
    const identity = JSON.stringify([
      settings.knowledgeBaseName.trim(),
      settings.folderName.trim(),
      sourceTitle,
    ]);
    return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  }

  private sanitizeBasename(sourceTitle: string): string {
    const replacements: Record<string, string> = {
      "<": "＜",
      ">": "＞",
      ":": "：",
      '"': "＂",
      "/": "／",
      "\\": "＼",
      "|": "｜",
      "?": "？",
      "*": "＊",
    };
    let basename = Array.from(sourceTitle, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 31 || codePoint === 127) return " ";
      return replacements[character] ?? character;
    })
      .join("")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    basename = this.truncateBasename(basename || "未命名文章", MAX_BASENAME_LENGTH);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) {
      basename = this.truncateBasename(`${basename}_`, MAX_BASENAME_LENGTH);
    }
    return basename;
  }

  private truncateBasename(value: string, maximumLength: number): string {
    return Array.from(value).slice(0, maximumLength).join("").replace(/[. ]+$/g, "");
  }

  private parseExtractionResult(stdout: string): ExtractionResult {
    const text = stdout.replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error("PowerShell 没有返回结果。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`PowerShell 返回了无效 JSON：${text.slice(0, 200)}`);
    }
    if (!this.isExtractionResult(parsed)) {
      throw new Error("PowerShell 返回的结果格式无效。");
    }
    return parsed;
  }

  private isExtractionResult(value: unknown): value is ExtractionResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    const hasKnownField = ["busy", "canceled", "items", "errors", "skippedTitles"]
      .some((key) => Object.prototype.hasOwnProperty.call(result, key));
    if (!hasKnownField) return false;
    if (result.busy !== undefined && typeof result.busy !== "boolean") return false;
    if (result.canceled !== undefined && typeof result.canceled !== "boolean") return false;
    if (
      result.items !== undefined &&
      (!Array.isArray(result.items) ||
        !result.items.every(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>).sourceTitle === "string" &&
            ((item as Record<string, unknown>).updatedDate == null || typeof (item as Record<string, unknown>).updatedDate === "string") &&
            ((item as Record<string, unknown>).sourceId === undefined || typeof (item as Record<string, unknown>).sourceId === "string") &&
            ((item as Record<string, unknown>).complete === undefined || typeof (item as Record<string, unknown>).complete === "boolean") &&
            typeof (item as Record<string, unknown>).body === "string",
        ))
    ) {
      return false;
    }
    if (
      result.errors !== undefined &&
      (!Array.isArray(result.errors) ||
        !result.errors.every(
          (error) =>
            error &&
            typeof error === "object" &&
            typeof (error as Record<string, unknown>).title === "string" &&
            typeof (error as Record<string, unknown>).message === "string",
        ))
    ) {
      return false;
    }
    return (
      result.skippedTitles === undefined ||
      (Array.isArray(result.skippedTitles) &&
        result.skippedTitles.every((title) => typeof title === "string"))
    );
  }

  private async runPowerShell(
    maxItems: number,
    skipTitles: string[],
    settings: Readonly<ImaSpeedSyncSettings>,
    run: SyncRun,
    skipSourceIds: string[] = [],
  ): Promise<string> {
    if (!Platform.isWin) throw new Error("此功能需要 Windows。");
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      throw new Error("此功能需要本机桌面仓库。");
    }

    const runtimeRoot = path.join(os.tmpdir(), PLUGIN_MARKER);
    await mkdir(runtimeRoot, { recursive: true });
    this.assertRunActive(run);
    const runDirectory = await mkdtemp(path.join(runtimeRoot, "run-"));
    try {
      const scriptPath = await this.writeRuntimeScript(runDirectory);
      const inputPath = path.join(runDirectory, "input.json");
      const outputPath = path.join(runDirectory, "output.json");
      const cancellationPath = path.join(runDirectory, "cancel");
      run.cancellationPath = cancellationPath;
      if (this.activeRun === run) this.cancellationPath = cancellationPath;

      await writeFile(inputPath, JSON.stringify({
        skipTitles, skipSourceIds,
        contentMode: settings.contentMode,
        titleFilterMode: settings.titleFilterMode,
        titleFilter: settings.titleFilter,
        allowForeground: settings.allowForeground,
      }), { encoding: "utf8", flag: "wx" });
      this.assertRunActive(run);

      const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-MaxItems",
        String(maxItems),
        "-KnowledgeBaseName",
        settings.knowledgeBaseName,
        "-FolderName",
        settings.folderName,
        "-InputPath",
        inputPath,
        "-OutputPath",
        outputPath,
        "-CancelFilePath",
        cancellationPath,
      ];

      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        let stderrTail = "";
        let progressBuffer = "";
        const finish = async (
          code: number | null,
          signal: NodeJS.Signals | null,
          processError?: Error,
        ): Promise<void> => {
          if (settled) return;
          settled = true;
          run.process = null;
          if (this.activeRun === run) this.currentProcess = null;

          let outputFailure = "";
          try {
            const output = await readFile(outputPath, "utf8");
            this.parseExtractionResult(output);
            resolve(output);
            return;
          } catch (error) {
            outputFailure = error instanceof Error ? error.message : String(error);
          }

          if (run.cancellationRequested) {
            reject(new SyncCanceledError());
            return;
          }
          const processFailure =
            stderrTail.trim() ||
            processError?.message ||
            (code === 0
              ? ""
              : `PowerShell 异常退出（${signal ?? `代码 ${String(code)}`}）。`);
          const outputDetail = `PowerShell 结果文件缺失或无效：${outputFailure}`;
          reject(new Error(processFailure ? `${processFailure}\n${outputDetail}` : outputDetail));
        };

        let child: ChildProcess;
        try {
          child = spawn("powershell.exe", args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          void finish(null, null, error instanceof Error ? error : new Error(String(error)));
          return;
        }
        run.process = child;
        if (this.activeRun === run) this.currentProcess = child;
        child.stdout?.setEncoding?.("utf8");
        child.stdout?.on("data", (chunk: Buffer | string) => {
          progressBuffer = (progressBuffer + String(chunk)).slice(-8192);
          let newline: number;
          while ((newline = progressBuffer.indexOf("\n")) >= 0) {
            const line = progressBuffer.slice(0, newline).trim();
            progressBuffer = progressBuffer.slice(newline + 1);
            if (!line.startsWith("IMA_PROGRESS:")) continue;
            try {
              const progress: unknown = JSON.parse(line.slice(13));
              if (progress && typeof progress === "object" && "text" in progress && typeof progress.text === "string") {
                this.updateOperationCard(run, progress.text.slice(0, 300));
              }
            } catch { /* Ignore malformed diagnostics; extraction JSON remains authoritative. */ }
          }
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderrTail = `${stderrTail}${String(chunk)}`.slice(-64 * 1024);
        });
        child.once("error", (error) => void finish(null, null, error));
        child.once("close", (code, signal) => {
          void finish(code, signal);
        });
      });
    } finally {
      run.process = null;
      run.cancellationPath = null;
      if (this.activeRun === run) {
        this.currentProcess = null;
        this.cancellationPath = null;
      }
      await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async writeRuntimeScript(runtimeDirectory = path.join(os.tmpdir(), PLUGIN_MARKER)): Promise<string> {
    if (!Platform.isWin) throw new Error("此功能需要 Windows。");

    await mkdir(runtimeDirectory, { recursive: true });
    const digest = createHash("sha256").update(syncScript, "utf8").digest("hex").slice(0, 16);
    const scriptPath = path.join(runtimeDirectory, `sync-${digest}-${process.pid}-${Date.now()}.ps1`);
    // Windows PowerShell 5.1 needs a BOM to reliably decode non-ASCII script literals.
    await writeFile(scriptPath, `\uFEFF${syncScript}`, { encoding: "utf8", flag: "wx" });
    return scriptPath;
  }

  private assertRunActive(run: SyncRun, allowCancellation = false): void {
    if (
      this.unloaded ||
      this.activeRun !== run ||
      (!allowCancellation && run.cancellationRequested)
    ) {
      throw new SyncCanceledError();
    }
  }

  private async writeCancellationMarker(run: SyncRun): Promise<void> {
    if (!run.cancellationPath) return;
    try {
      await writeFile(run.cancellationPath, "cancel", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") throw error;
    }
  }

  private async completeConsent(allowed: boolean, resolve: (allowed: boolean) => void): Promise<void> {
    try {
      if (allowed) {
        this.settings.hasConsented = true;
        await this.saveSettings();
      }
      resolve(allowed);
    } catch (error) {
      this.settings.hasConsented = false;
      console.error("保存 IMA Share Sync 授权失败", error);
      this.notifyManual("保存 IMA Share Sync 授权失败，请重试。", 8000);
      resolve(false);
    } finally {
      this.consentPromise = null;
    }
  }
}
