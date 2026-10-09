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
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import syncScript from "./sync.ps1";
import { DesktopOperationCard } from "./desktop-card";
import { IMA_SHARE_SYNC_ICON_ID, IMA_SHARE_SYNC_ICON_SVG } from "./icon";
import { validatePdfStructure } from "./pdf-validation";
import { runMarkdownConversion, type ConvertTask, type ConvertResultSummary } from "./pdf-to-markdown";
import markdownRunnerScript from "ima-markdown-runner";
import { getStrings } from "./i18n";

const GITHUB_REPOSITORY_URL = "https://github.com/oooing/ima-share-sync";

interface ImaSpeedSyncSettings {
  autoSync: boolean;
  hasConsented: boolean;
  knowledgeBaseName: string;
  folderName: string;
  destinationPath: string;
  includeSourceFolder: boolean;
  overwriteSameName: boolean;
  maxItems: number;
  syncScopeMode?: "all" | "recent";
  contentMode: "general" | "speed-reader";
  includeSubfolders: boolean;
  maxFolders: number;
  maxFolderDepth: number;
  generalSelectionMode: "total" | "per-folder";
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
  enableMarkdownConversion: boolean;
  markdownConversionScope: "all" | "text_only" | "image_only";
  embedPdfLinkInMarkdown: boolean;
  language?: "auto" | "zh" | "en";
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
  relativeFolder?: string[];
  downloadedFile?: string;
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
  stagingDirectory?: string;
  pdfValidationAbort?: AbortController;
  savedPdfFiles?: { path: string; title: string }[];
  markdownAbort?: AbortController;
}

interface SyncedAttachment {
  path: string;
  sourceId: string;
  sourceScope: string;
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
  includeSourceFolder: true,
  overwriteSameName: false,
  maxItems: 30,
  syncScopeMode: "recent",
  contentMode: "general",
  includeSubfolders: true,
  maxFolders: 1,
  maxFolderDepth: 1,
  generalSelectionMode: "total",
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
  enableMarkdownConversion: true,
  markdownConversionScope: "all",
  embedPdfLinkInMarkdown: true,
  language: "auto",
};

const VIEW_TYPE = "ima-speed-sync-view";
const PLUGIN_MARKER = "ima-speed-sync";
const ARTICLES_PER_PAGE = 20;
const MAX_BASENAME_LENGTH = 120;

function renderPageHeader(container: HTMLElement, title: string, onBack: () => void): void {
  const header = container.createDiv({ cls: "ima-share-sync-history-header" });
  const back = header.createEl("button", {
    cls: "ima-share-sync-back-button", attr: { "aria-label": "返回首页", title: "返回首页" },
  });
  setIcon(back.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-left");
  back.addEventListener("click", onBack);
  header.createEl("h4", { text: title });
}

class SyncHistoryPanel {
  contentEl!: HTMLElement;
  private page = 0;
  private focusedId?: string;
  private focusedRecord?: HTMLDetailsElement;
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
    renderPageHeader(this.contentEl, "同步日志", () => this.close());
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
      this.focusPageStart();
    });
    pager.createSpan({ text: `第 ${this.page + 1} / ${pages} 页 · 共 ${reports.length} 次`, cls: "ima-speed-sync-page-status" });
    const next = pager.createEl("button", { text: "下一页" });
    next.disabled = this.page >= pages - 1;
    next.addEventListener("click", () => {
      if (this.page >= pages - 1) return;
      this.page++;
      this.focusedId = undefined;
      this.render();
      this.focusPageStart();
    });
    this.onViewed(this.focusedId ? pageReports.filter((report) => report.id === this.focusedId) : pageReports);
    this.focusedRecord = focusedRecord;
  }

  revealFocusedReport(): void {
    this.focusedRecord?.scrollIntoView?.({ block: "nearest" });
    this.focusedRecord?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  }

  private focusPageStart(): void {
    this.contentEl.scrollTop = 0;
    this.contentEl.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }

  close(): void {
    this.focusedId = undefined;
    this.expandedIds.clear();
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
      text: "本插件仅支持 Windows。它会启动 IMA 桌面端，通过 Windows UI 自动化读取文章，并将正文和允许下载的原文件保存到指定的仓库文件夹；开启文档转换后，会在本地将 PDF 中的文字生成 Markdown 笔记。",
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
  private page: "home" | "articles" | "history" = "home";
  private history?: SyncHistoryPanel;
  private scrollPositions = new Map<string, number>();

  showHistory(panel: SyncHistoryPanel): void {
    this.history = panel;
    this.navigate("history");
    panel.revealFocusedReport();
  }

  showHome(): void { this.navigate("home", "同步日志"); }

  private navigate(page: typeof this.page, focusKey?: string): void {
    this.scrollPositions.set(this.page, this.contentEl.scrollTop);
    this.page = page;
    this.render();
    this.contentEl.scrollTop = this.scrollPositions.get(page) ?? 0;
    const target = focusKey
      ? Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-nav-key]")).find((el) => el.dataset.navKey === focusKey)
      : this.contentEl.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
  }

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
    if (this.page === "history" && this.history) {
      this.history.mount(this.contentEl);
      return;
    }
    if (this.page === "articles") {
      renderPageHeader(this.contentEl, "文章", () => this.navigate("home", "文章"));
      this.renderArticles();
      return;
    }
    const heading = this.contentEl.createDiv({ cls: "ima-share-sync-heading" });
    heading.createEl("h3", { text: "IMA Share Sync" });
    heading.createSpan({
      cls: "ima-share-sync-version",
      text: `v${this.plugin.manifest.version}`,
      attr: { "aria-label": `当前版本 ${this.plugin.manifest.version}` },
    });

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

    const entry = this.contentEl.createEl("button", {
      text: `文章（${this.plugin.getSortedArticles().length}）`, cls: "ima-share-sync-nav-entry",
      attr: { "data-nav-key": "文章" },
    });
    entry.addEventListener("click", () => this.navigate("articles"));
    this.plugin.renderHistoryEntry(this.contentEl);
  }

  private renderArticles(): void {
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
      const articleButton = item.createEl("button", { text: file.basename, cls: "ima-share-sync-nav-entry", attr: { "data-nav-key": file.path } });
      articleButton.addEventListener("click", () => {
        void this.plugin.app.workspace.getLeaf(false).openFile(file, { active: true });
      });
    }

    const pagination = this.contentEl.createDiv({ cls: "ima-speed-sync-pagination" });
    const previousButton = pagination.createEl("button", { text: "上一页" });
    previousButton.disabled = this.currentPage === 0;
    previousButton.addEventListener("click", () => {
      if (this.currentPage === 0) return;
      this.currentPage--;
      this.render();
      this.contentEl.scrollTop = 0;
      this.contentEl.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
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
      this.contentEl.scrollTop = 0;
      this.contentEl.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
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
  private advancedOpen = false;
  private activeTabId: "scope" | "markdown" | "notifications" | "general" = "scope";
  private updateScopeSummary?: () => void;
  private quantitySelect?: HTMLSelectElement;
  constructor(
    app: Plugin["app"],
    private readonly plugin: ImaSpeedSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.renderSettings();
  }

  private renderGeneralScope(containerEl: HTMLElement): void {
    const s = getStrings(this.plugin.settings.language);
    const settings = this.plugin.settings;
    const legacy = settings.generalSelectionMode === "per-folder";
    const currentMode = settings.syncScopeMode ?? "recent";
    let folderControl: { setDisabled(value: boolean): unknown } | undefined;
    let depthControl: { setDisabled(value: boolean): unknown; setValue(value: string): unknown } | undefined;
    let scopeDetails: HTMLElement | undefined;
    let subfolderSetting: Setting | undefined;
    let maxFoldersSetting: Setting | undefined;
    if (legacy) {
      new Setting(containerEl)
        .setName("正在沿用旧版数量规则")
        .setDesc(`原设置未改变：每个文件夹最多 ${settings.maxItems} 个。切换后改为每次合计最多 ${settings.maxItems} 个，文件夹范围不变。`)
        .addButton((button) => button.setButtonText(`改为每次共 ${settings.maxItems} 个`).onClick(async () => {
          settings.generalSelectionMode = "total";
          await this.plugin.saveSettings();
          this.renderSettings();
          this.quantitySelect?.focus();
        }));
    }

    // 双列栅格：左列全部同步（穷尽），右列仅同步最新+级联下沉菜单
    const columns = containerEl.createDiv({ cls: "ima-mode-columns" });

    // 左列：全部同步（穷尽）
    const colLeft = columns.createDiv({ cls: "ima-mode-column" });
    const cardAll = colLeft.createDiv({
      cls: `ima-main-mode-card${currentMode === "all" ? " is-active" : ""}`,
      attr: { "data-mode": "all" },
    });
    const allHeader = cardAll.createDiv({ cls: "ima-card-header-row" });
    const allIcon = allHeader.createDiv({ cls: "ima-card-icon" });
    setIcon(allIcon, "layers");
    const allCheck = allHeader.createDiv({ cls: "ima-check-circle" });
    setIcon(allCheck, "check");

    const allContent = cardAll.createDiv();
    allContent.createDiv({ cls: "ima-card-title", text: s.modeAllTitle });
    const allSummary = allContent.createDiv({ cls: "ima-card-summary-row" });
    allSummary.createSpan({ text: s.modeAllDesc });

    // 右列：仅同步最新 + 级联下沉菜单
    const colRight = columns.createDiv({ cls: "ima-mode-column" });
    const cardRecent = colRight.createDiv({
      cls: `ima-main-mode-card${currentMode === "recent" ? " is-active" : ""}`,
      attr: { "data-mode": "recent" },
    });
    const recentHeader = cardRecent.createDiv({ cls: "ima-card-header-row" });
    const recentIcon = recentHeader.createDiv({ cls: "ima-card-icon" });
    setIcon(recentIcon, "clock");
    const recentCheck = recentHeader.createDiv({ cls: "ima-check-circle" });
    setIcon(recentCheck, "check");

    const formatSummaryText = (qty: number) => {
      return s.modeRecentDesc(qty);
    };

    const recentContent = cardRecent.createDiv();
    recentContent.createDiv({ cls: "ima-card-title", text: s.modeRecentTitle });
    const recentSummaryRow = recentContent.createDiv({ cls: "ima-card-summary-row" });
    const recentSummaryText = recentSummaryRow.createSpan({ text: formatSummaryText(settings.maxItems) });
    let isPanelOpen = false;
    const recentArrow = recentSummaryRow.createSpan({ cls: "ima-card-arrow" });
    setIcon(recentArrow, "chevron-down");

    // 级联下沉面板（与右卡片天然等宽，绝对定位悬浮层）
    const cascadePanel = colRight.createDiv({ cls: "ima-cascade-popover-panel is-hidden" });

    const onOutsideClick = (evt: MouseEvent) => {
      const target = evt.target as Node | null;
      if (isPanelOpen && target && !cascadePanel.contains(target) && !cardRecent.contains(target)) {
        togglePanel(false);
      }
    };

    const togglePanel = (open?: boolean) => {
      isPanelOpen = open ?? !isPanelOpen;
      cascadePanel.toggleClass("is-hidden", !isPanelOpen);
      recentArrow.toggleClass("is-expanded", isPanelOpen);
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        if (isPanelOpen) {
          window.addEventListener("click", onOutsideClick, { capture: true });
        } else if (typeof window.removeEventListener === "function") {
          window.removeEventListener("click", onOutsideClick, { capture: true });
        }
      }
    };

    const popHeader = cascadePanel.createDiv({ cls: "ima-popover-header" });
    const breadcrumb = popHeader.createDiv({ cls: "ima-popover-breadcrumb" });
    breadcrumb.createSpan({ text: s.modeRecentTitle });
    breadcrumb.createSpan({ text: "/", cls: "crumb-sep" });
    breadcrumb.createSpan({ text: s.cascadeHeader.split("/")[1]?.trim() || "Presets", cls: "crumb-active" });

    const closeBtn = popHeader.createEl("button", { cls: "ima-popover-close-btn", attr: { title: "Close" } });
    setIcon(closeBtn, "x");

    const itemsList = cascadePanel.createDiv({ cls: "ima-cascade-items-list" });
    const presets = [10, 30, 50, 100];
    const rowElements = new Map<number | "custom", HTMLElement>();

    const updateQuantitySelection = async (qty: number, isCustom = false) => {
      const validQty = Math.min(Math.max(qty, 1), 1000);
      settings.maxItems = validQty;
      recentSummaryText.setText(formatSummaryText(validQty));

      rowElements.forEach((el, key) => {
        const active = isCustom ? key === "custom" : key === validQty;
        el.toggleClass("is-active", active);
        const check = el.querySelector(".ima-option-check");
        if (check) check.toggleClass("is-visible", active);
      });

      if (this.quantitySelect) {
        this.quantitySelect.value = String(Math.min(validQty, 30));
      }
      updateSummary();
      await this.plugin.saveSettings();
    };

    presets.forEach((preset) => {
      const isSelected = settings.maxItems === preset;
      const row = itemsList.createDiv({ cls: `ima-cascade-option-row${isSelected ? " is-active" : ""}` });
      rowElements.set(preset, row);

      const left = row.createDiv({ cls: "ima-option-row-left" });
      left.createSpan({ cls: "ima-option-name", text: s.cascadePreset(preset) });
      if (preset === 30) {
        left.createSpan({ cls: "ima-option-badge", text: s.badgeDefault });
      }

      const check = row.createDiv({ cls: "ima-option-check" });
      setIcon(check, "check");
      check.toggleClass("is-visible", isSelected);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        void updateQuantitySelection(preset, false);
        togglePanel(false);
      });
    });

    // “最新的 [ ] 份文件” 行内紧凑输入项
    const isCustomActive = !presets.includes(settings.maxItems);
    const customRow = itemsList.createDiv({ cls: `ima-cascade-option-row${isCustomActive ? " is-active" : ""}` });
    rowElements.set("custom", customRow);

    const customLeft = customRow.createDiv({ cls: "ima-option-row-left" });
    customLeft.createSpan({ cls: "ima-option-name", text: s.cascadeCustomPrefix });
    const inputWrap = customLeft.createDiv({ cls: "ima-custom-input-wrapper" });
    const customInput = inputWrap.createEl("input", {
      cls: "ima-compact-num-input",
      type: "number",
      attr: { min: "1", max: "1000", placeholder: "30" },
    });
    customInput.value = isCustomActive ? String(settings.maxItems) : "30";
    customLeft.createSpan({ cls: "ima-option-name", text: s.cascadeCustomSuffix });

    const customCheck = customRow.createDiv({ cls: "ima-option-check" });
    setIcon(customCheck, "check");
    customCheck.toggleClass("is-visible", isCustomActive);

    const triggerCustom = () => {
      let val = parseInt(customInput.value, 10);
      if (isNaN(val) || val <= 0) val = 30;
      void updateQuantitySelection(val, true);
    };

    customRow.addEventListener("click", (e) => {
      e.stopPropagation();
      customInput.focus();
      triggerCustom();
    });
    customInput.addEventListener("click", (e) => e.stopPropagation());
    customInput.addEventListener("focus", () => triggerCustom());
    customInput.addEventListener("input", () => triggerCustom());
    customInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        triggerCustom();
        togglePanel(false);
      }
    });

    // 底部说明条
    const footerNote = cascadePanel.createDiv({ cls: "ima-popover-footer-note" });
    setIcon(footerNote.createSpan(), "info");
    footerNote.createSpan({ text: s.cascadeFooter });

    // 关闭按钮事件
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel(false);
    });

    const selectMode = async (mode: "all" | "recent") => {
      settings.syncScopeMode = mode;
      cardAll.toggleClass("is-active", mode === "all");
      cardRecent.toggleClass("is-active", mode === "recent");
      if (mode === "all") {
        togglePanel(false);
      } else {
        togglePanel(true);
      }
      updateSummary();
      await this.plugin.saveSettings();
    };

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock DOM dispatches await the returned promise in test-main.cjs
    cardAll.addEventListener("click", () => selectMode("all"));
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock DOM dispatches await the returned promise in test-main.cjs
    cardRecent.addEventListener("click", () => {
      if (settings.syncScopeMode === "recent") {
        togglePanel();
        return Promise.resolve();
      } else {
        return selectMode("recent");
      }
    });

    // 状态无障碍说明与测试兼容
    const summary = containerEl.createDiv({ cls: "ima-share-sync-scope-summary", attr: { "role": "status", "aria-live": "polite" } });
    const summaryTitle = summary.createDiv({ cls: "ima-share-sync-scope-title" });
    const updateSummary = (): void => {
      const nested = settings.includeSubfolders && settings.maxFolderDepth > 0;
      const folder = settings.folderName || "所选文件夹";
      const folderNameDesc = settings.folderName ? settings.folderName : "";
      sourceFolderSetting?.setDesc(settings.includeSourceFolder
        ? s.includeFolderDescTrue(folderNameDesc)
        : s.includeFolderDescFalse);
      const isAll = (settings.syncScopeMode ?? "recent") === "all";
      const scope = nested
        ? (isAll
            ? s.scopeDetailAll(folder, settings.maxFolderDepth)
            : s.scopeDetailRecent(folder, settings.maxFolders, settings.maxFolderDepth))
        : s.scopeDetailCurrentOnly(folder);
      if (legacy) {
        summaryTitle.setText(s.summaryTitleLegacy((nested ? settings.maxFolders : 1) * settings.maxItems));
      } else if (isAll) {
        summaryTitle.setText(s.summaryTitleAll);
      } else {
        summaryTitle.setText(s.summaryTitleRecent(settings.maxItems));
      }
      scopeDetails?.setText(scope);
      subfolderSetting?.setDesc(nested
        ? s.includeSubfoldersDescTrue
        : s.includeSubfoldersDescFalse);
      if (folderControl) {
        folderControl.setDisabled(!settings.includeSubfolders || isAll);
      }
      if (maxFoldersSetting) {
        maxFoldersSetting.setDesc(isAll
          ? s.maxFoldersDescAll
          : s.maxFoldersDescRecent);
      }
    };
    this.updateScopeSummary = updateSummary;

    // 辅助 dropdown 兼容单元测试与键盘无障碍
    const hiddenQuantitySetting = new Setting(containerEl)
      .setName(legacy ? "每个文件夹检查数量（旧规则）" : "每次检查数量")
      .setDesc(legacy ? "每个文件夹分别计数。" : "按时间从新到旧。")
      .addDropdown((dropdown) => {
        this.quantitySelect = dropdown.selectEl;
        for (let count = 1; count <= 30; count++) dropdown.addOption(String(count), s.unitFolders(count));
        dropdown.setValue(String(Math.min(settings.maxItems, 30))).onChange(async (value) => {
          await updateQuantitySelection(Number(value));
        });
      });
    hiddenQuantitySetting.settingEl.toggleClass("ima-hidden-setting", true);

    const sourceFolderSetting = new Setting(containerEl)
      .setName(s.includeFolderOption)
      .addToggle((toggle) => toggle.setValue(settings.includeSourceFolder).onChange(async (value) => {
        settings.includeSourceFolder = value;
        updateSummary();
        await this.plugin.saveSettings();
      }));

    subfolderSetting = new Setting(containerEl)
      .setName(s.includeSubfoldersOption)
      .addToggle((toggle) => toggle.setValue(settings.includeSubfolders).onChange(async (value) => {
        settings.includeSubfolders = value;
        if (value && settings.maxFolderDepth === 0) settings.maxFolderDepth = 1;
        // Preserve legacy depth-based behavior, including after restarting.
        if (!value && legacy) settings.maxFolderDepth = 0;
        depthControl?.setDisabled(!value);
        depthControl?.setValue(String(settings.maxFolderDepth || 1));
        updateSummary();
        await this.plugin.saveSettings();
      }));
    updateSummary();

    const advanced = containerEl.createEl("details", { cls: "ima-share-sync-advanced" });
    advanced.open = this.advancedOpen;
    advanced.addEventListener("toggle", () => { this.advancedOpen = advanced.open; });
    advanced.createEl("summary", { text: s.advancedSummary });
    const content = advanced.createDiv({ cls: "ima-share-sync-advanced-content" });
    scopeDetails = content.createDiv({ cls: "setting-item-description ima-advanced-scope-banner", attr: { role: "status", "aria-live": "polite" } });
    updateSummary();
    const ruleSetting = new Setting(content).setName(s.ruleSettingName).setDesc(s.ruleSettingDesc);
    if (ruleSetting.settingEl) ruleSetting.settingEl.toggleClass("ima-advanced-info-item", true);
    maxFoldersSetting = new Setting(content)
      .setName(s.maxFoldersName)
      .setDesc((settings.syncScopeMode ?? "recent") === "all"
        ? s.maxFoldersDescAll
        : s.maxFoldersDescRecent)
      .addDropdown((dropdown) => {
        folderControl = dropdown;
        for (let count = 1; count <= 20; count++) dropdown.addOption(String(count), s.unitFolders(count));
        dropdown.setValue(String(settings.maxFolders)).setDisabled(!settings.includeSubfolders || (settings.syncScopeMode ?? "recent") === "all").onChange(async (value) => {
          settings.maxFolders = Number(value);
          updateSummary();
          await this.plugin.saveSettings();
        });
      });
    new Setting(content)
      .setName(s.maxFolderDepthName)
      .setDesc(s.maxFolderDepthDesc)
      .addDropdown((dropdown) => {
        depthControl = dropdown;
        for (let depth = 1; depth <= 5; depth++) dropdown.addOption(String(depth), s.unitLevels(depth));
        dropdown.setValue(String(settings.maxFolderDepth || 1)).setDisabled(!settings.includeSubfolders).onChange(async (value) => {
          settings.maxFolderDepth = Number(value);
          updateSummary();
          await this.plugin.saveSettings();
        });
      });
    const sortSetting = new Setting(content)
      .setName(s.sortSettingName)
      .setDesc(s.sortSettingDesc);
    if (sortSetting.settingEl) sortSetting.settingEl.toggleClass("ima-advanced-info-item", true);
    new Setting(content)
      .setName(s.titleFilterName)
      .setDesc(s.titleFilterDesc)
      .addDropdown((dropdown) => dropdown
        .addOption("all", s.titleFilterAll)
        .addOption("contains", s.titleFilterContains)
        .addOption("prefix", s.titleFilterPrefix)
        .addOption("regex", s.titleFilterRegex)
        .setValue(settings.titleFilterMode)
        .onChange(async (value) => {
          settings.titleFilterMode = value as ImaSpeedSyncSettings["titleFilterMode"];
          await this.plugin.saveSettings();
          this.renderSettings();
        }));
    if (settings.titleFilterMode !== "all") {
      new Setting(content).setName(s.filterContentName).setDesc(s.filterContentDesc)
        .addText((text) => text.setValue(settings.titleFilter).onChange(async (value) => {
          settings.titleFilter = value;
          await this.plugin.saveSettings();
        }));
    }
  }

  private renderSettings(): void {
    const s = getStrings(this.plugin.settings.language);
    const { containerEl } = this;
    containerEl.empty();
    this.updateScopeSummary = undefined;

    const supportCard = containerEl.createDiv({ cls: "ima-share-sync-support" });
    const supportIcon = supportCard.createDiv({
      cls: "ima-share-sync-support-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(supportIcon, "star");
    const supportCopy = supportCard.createDiv({ cls: "ima-share-sync-support-copy" });
    supportCopy.createDiv({
      cls: "ima-share-sync-support-title",
      text: s.supportTitle,
    });
    supportCopy.createDiv({
      cls: "ima-share-sync-support-description",
      text: s.supportDesc,
    });
    supportCard.createEl("a", {
      cls: "ima-share-sync-support-link",
      text: s.supportBtn,
      attr: {
        href: GITHUB_REPOSITORY_URL,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": s.supportAria,
      },
    });

    if (!Platform.isWin) {
      containerEl.createEl("p", {
        text: s.windowsWarning,
        cls: "mod-warning",
      });
    }

    const tabsHeader = containerEl.createDiv({ cls: "ima-settings-tabs-header" });
    const panelScope = containerEl.createDiv({
      cls: `ima-settings-tab-content${this.activeTabId === "scope" ? "" : " is-hidden"}`,
      attr: { "data-tab-content": "scope" },
    });
    const panelMarkdown = containerEl.createDiv({
      cls: `ima-settings-tab-content${this.activeTabId === "markdown" ? "" : " is-hidden"}`,
      attr: { "data-tab-content": "markdown" },
    });
    const panelNotifications = containerEl.createDiv({
      cls: `ima-settings-tab-content${this.activeTabId === "notifications" ? "" : " is-hidden"}`,
      attr: { "data-tab-content": "notifications" },
    });
    const panelGeneral = containerEl.createDiv({
      cls: `ima-settings-tab-content${this.activeTabId === "general" ? "" : " is-hidden"}`,
      attr: { "data-tab-content": "general" },
    });

    const panels: Record<"scope" | "markdown" | "notifications" | "general", HTMLElement> = {
      scope: panelScope,
      markdown: panelMarkdown,
      notifications: panelNotifications,
      general: panelGeneral,
    };

    const tabButtons = new Map<string, HTMLElement>();
    const tabConfigs: { id: "scope" | "markdown" | "notifications" | "general"; label: string; icon: string }[] = [
      { id: "scope", label: s.tabScope, icon: "folder" },
      { id: "markdown", label: s.tabMarkdown, icon: "file-text" },
      { id: "notifications", label: s.tabNotifications, icon: "bell" },
      { id: "general", label: s.tabGeneral, icon: "settings" },
    ];

    for (const tab of tabConfigs) {
      const btn = tabsHeader.createEl("button", {
        cls: `ima-settings-tab-btn${this.activeTabId === tab.id ? " is-active" : ""}`,
        attr: { "data-tab-id": tab.id, type: "button" },
      });
      setIcon(btn.createSpan(), tab.icon);
      btn.createSpan({ text: tab.label });
      btn.addEventListener("click", () => {
        this.activeTabId = tab.id;
        tabButtons.forEach((b, id) => b.toggleClass("is-active", id === tab.id));
        Object.entries(panels).forEach(([id, p]) => p.toggleClass("is-hidden", id !== tab.id));
      });
      tabButtons.set(tab.id, btn);
    }

    new Setting(panelGeneral)
      .setName(s.languageName)
      .setDesc(s.languageDesc)
      .addDropdown((dropdown) => dropdown
        .addOption("auto", s.langAuto)
        .addOption("zh", s.langZh)
        .addOption("en", s.langEn)
        .setValue(this.plugin.settings.language || "auto")
        .onChange(async (value) => {
          if (value !== "auto" && value !== "zh" && value !== "en") return;
          this.plugin.settings.language = value;
          await this.plugin.saveSettings();
          this.renderSettings();
        }));

    new Setting(panelGeneral)
      .setName(s.autoSyncName)
      .setDesc(s.autoSyncDesc)
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

    new Setting(panelGeneral)
      .setName(s.contentModeName)
      .setDesc(s.contentModeDesc)
      .addDropdown((dropdown) => dropdown
        .addOption("general", s.contentModeGeneral)
        .addOption("speed-reader", s.contentModeSpeedReader)
        .setValue(this.plugin.settings.contentMode)
        .onChange(async (value) => {
          this.plugin.settings.contentMode = value === "general" ? "general" : "speed-reader";
          await this.plugin.saveSettings();
          this.renderSettings();
        }));

    new Setting(panelGeneral)
      .setName(s.allowForegroundName)
      .setDesc(s.allowForegroundDesc)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowForeground)
        .onChange(async (value) => {
          this.plugin.settings.allowForeground = value;
          await this.plugin.saveSettings();
        }));

    new Setting(panelScope)
      .setName(s.kbName)
      .setDesc(s.kbDesc)
      .addText((text) =>
        text
          .setPlaceholder(s.kbPlaceholder)
          .setValue(this.plugin.settings.knowledgeBaseName)
          .onChange(async (value) => {
            this.plugin.settings.knowledgeBaseName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(panelScope)
      .setName(s.sourceFolderName)
      .setDesc(s.sourceFolderDesc)
      .addText((text) =>
        text
          .setPlaceholder(s.sourceFolderPlaceholder)
          .setValue(this.plugin.settings.folderName)
          .onChange(async (value) => {
            this.plugin.settings.folderName = value.trim();
            this.updateScopeSummary?.();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(panelScope)
      .setName(s.destPathName)
      .setDesc(s.destPathDesc)
      .addText((text) =>
        text
          .setPlaceholder(s.destPathPlaceholder)
          .setValue(this.plugin.settings.destinationPath)
          .onChange(async (value) => {
            this.plugin.settings.destinationPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(panelScope)
      .setName(s.overwriteName)
      .setDesc(s.overwriteDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.overwriteSameName)
          .onChange(async (value) => {
            await this.plugin.setOverwriteSameName(value);
          }),
      );

    if (this.plugin.settings.contentMode === "general") {
      this.renderGeneralScope(panelScope);
    } else {
      new Setting(panelScope)
      .setName(s.maxItemsName)
      .setDesc(s.maxItemsDesc)
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.maxItems)
          .onChange(async (value) => {
            this.plugin.settings.maxItems = value;
            await this.plugin.saveSettings();
          }),
      );
    }

    new Setting(panelGeneral)
      .setName(s.resetConsentName)
      .setDesc(s.resetConsentDesc)
      .addButton((button) =>
        button.setButtonText(s.resetConsentBtn).onClick(async () => {
          this.plugin.settings.hasConsented = false;
          this.plugin.settings.autoSync = false;
          await this.plugin.saveSettings();
          this.plugin.notifyManual(s.resetConsentNotice);
        }),
      );

    new Setting(panelNotifications).setName(s.noticesHeading).setHeading();
    const notificationSettings: [NotificationSetting, string, string][] = [
      ["notificationsEnabled", s.notificationsEnabledName, s.notificationsEnabledDesc],
      ["notifyAutoSuccess", s.notifyAutoSuccessName, s.notifyAutoSuccessDesc],
      ["notifyAutoFailure", s.notifyAutoFailureName, s.notifyAutoFailureDesc],
      ["notifyManualResult", s.notifyManualResultName, s.notifyManualResultDesc],
      ["showErrorBadge", s.showErrorBadgeName, s.showErrorBadgeDesc],
      ["showOperationBefore", s.showOperationBeforeName, s.showOperationBeforeDesc],
      ["showOperationAfter", s.showOperationAfterName, s.showOperationAfterDesc],
    ];
    for (const [key, name, description] of notificationSettings) {
      new Setting(panelNotifications).setName(name).setDesc(description).addToggle((toggle) =>
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
              this.plugin.notifyManual(s.saveSettingsError);
            }
          }),
      );
    }

    new Setting(panelMarkdown)
      .setName(s.enableMarkdownName)
      .setDesc(s.enableMarkdownDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableMarkdownConversion).onChange(async (value) => {
          this.plugin.settings.enableMarkdownConversion = value;
          await this.plugin.saveSettings();
          this.renderSettings();
        }),
      );

    if (this.plugin.settings.enableMarkdownConversion) {
      new Setting(panelMarkdown)
        .setName(s.markdownScopeName)
        .setDesc(s.markdownScopeDesc)
        .addDropdown((dropdown) =>
          dropdown
            .addOption("all", s.markdownScopeAll)
            .addOption("text_only", s.markdownScopeText)
            .addOption("image_only", s.markdownScopeImage)
            .setValue(this.plugin.settings.markdownConversionScope)
          .onChange(async (value) => {
            if (value !== "all" && value !== "text_only" && value !== "image_only") return;
              this.plugin.settings.markdownConversionScope = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(panelMarkdown)
        .setName(s.embedPdfLinkName)
        .setDesc(s.embedPdfLinkDesc)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.embedPdfLinkInMarkdown).onChange(async (value) => {
            this.plugin.settings.embedPdfLinkInMarkdown = value;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(panelMarkdown)
        .setName(s.manualScanName)
        .setDesc(s.manualScanDesc)
        .addButton((button) =>
          button.setButtonText(s.manualScanBtn).onClick(async () => {
            await this.plugin.convertAllVaultPdfFiles(true);
          }),
        );
    }

    containerEl.createDiv({
      cls: "ima-share-sync-settings-version",
      text: s.versionText(this.plugin.manifest.version),
    });
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
  private syncedAttachments: SyncedAttachment[] = [];
  private historyPanel: SyncHistoryPanel | null = null;
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
    const stored = (await this.loadData()) as (Partial<ImaSpeedSyncSettings> & { syncReports?: unknown; syncedAttachments?: unknown }) | null;
    const { syncReports, syncedAttachments, ...saved } = stored ?? {};
    this.syncedAttachments = Array.isArray(syncedAttachments) ? syncedAttachments.filter((entry: unknown): entry is SyncedAttachment => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return typeof value.path === "string" && typeof value.sourceId === "string" && typeof value.sourceScope === "string";
    }) : [];
    this.syncReports = restoreSyncReports(syncReports);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      // An existing installation must not silently expand from speed-reader titles to all articles.
      contentMode: saved.contentMode ?? (stored ? "speed-reader" : "general"),
      // Do not silently expand the scope of an existing general-mode installation.
      includeSubfolders: typeof saved.includeSubfolders === "boolean" ? saved.includeSubfolders : saved.contentMode === "general" ? false : true,
      includeSourceFolder: typeof saved.includeSourceFolder === "boolean" ? saved.includeSourceFolder : (stored ? false : true),
      maxFolders: saved.maxFolders ?? DEFAULT_SETTINGS.maxFolders,
      // Preserve an explicit old opt-out instead of enabling traversal on upgrade.
      maxFolderDepth: saved.maxFolderDepth ?? (saved.includeSubfolders === false ||
        (saved.contentMode === "general" && saved.includeSubfolders === undefined) ? 0 : DEFAULT_SETTINGS.maxFolderDepth),
      // Keep existing per-folder quantities until the user explicitly switches.
      generalSelectionMode: saved.generalSelectionMode ?? (stored ? "per-folder" : "total"),
      syncScopeMode: saved.syncScopeMode ?? "recent",
    };
    this.settings.includeSubfolders = this.settings.maxFolderDepth > 0 &&
      (this.settings.generalSelectionMode !== "total" || saved.includeSubfolders !== false);
    for (const key of ["notificationsEnabled", "notifyAutoSuccess", "notifyAutoFailure", "notifyManualResult", "showErrorBadge", "showOperationBefore", "showOperationAfter"] as const) {
      if (typeof this.settings[key] !== "boolean") this.settings[key] = DEFAULT_SETTINGS[key];
    }

    const s = getStrings();
    this.addSettingTab(new ImaSpeedSyncSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new ImaSpeedSyncView(leaf, this));
    this.ribbonEl = this.addRibbonIcon(IMA_SHARE_SYNC_ICON_ID, s.ribbonTooltip, () => {
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
      name: s.cmdSyncNow,
      callback: () => void this.sync(true),
    });
    this.addCommand({
      id: "cancel-sync",
      name: s.cmdCancelSync,
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
    run.pdfValidationAbort?.abort();
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
      syncedAttachments: this.syncedAttachments,
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
    if (!this.historyPanel || focusedReports?.length) this.historyPanel = new SyncHistoryPanel(() => {
      const reports = [...this.syncReports];
      for (const report of focusedReports ?? []) {
        if (!reports.some((stored) => stored.id === report.id)) reports.push(report);
      }
      return reports.sort((left, right) => right.finishedAt - left.finishedAt);
    }, focusedReports?.[0]?.id,
    (viewed) => { void this.markSyncReportsRead(viewed); },
    () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof ImaSpeedSyncView) leaf.view.showHome();
      }
    });
    const panel = this.historyPanel;
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing?.view instanceof ImaSpeedSyncView) existing.view.showHistory(panel);
    const reveal = existing ? this.app.workspace.revealLeaf(existing) : this.activateView();
    void reveal.then(() => {
      if (existing) return;
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
      if (view instanceof ImaSpeedSyncView) view.showHistory(panel);
    }).catch((error) => { console.error("打开同步日志失败", error); this.notifyManual("无法打开同步日志，请重新打开插件侧栏。"); });
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
    if (!latest && !this.running) status.createSpan({ text: "尚未同步", cls: "ima-share-sync-latest-status" });
    if (this.running) status.createEl("p", { text: "正在同步，可随时取消…" });
    if (latest) {
      status.createSpan({ text: `最近：${latest.status === "failed" ? "有异常" : latest.status === "canceled" ? "已取消" : "已完成"}`, cls: "ima-share-sync-latest-status" });
      if (latest.status === "failed") {
        status.createEl("button", { text: "查看本次异常" }).addEventListener("click", () => this.openSyncHistory([latest]));
      }
      if (this.reportSaveFailed) status.createEl("p", { text: "同步记录未能写入配置文件，本次结果仅在当前会话保留。" });
    }
  }

  renderHistoryEntry(containerEl: HTMLElement): void {
    containerEl.createEl("button", {
      text: `同步日志（${this.syncReports.length}）`, cls: "ima-share-sync-nav-entry",
      attr: { "data-nav-key": "同步日志" },
    }).addEventListener("click", () => this.openSyncHistory());
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
    run.pdfValidationAbort?.abort();
    run.markdownAbort?.abort();
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
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
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
      destinationPath = this.getEffectiveDestinationPath(this.settings);
    } catch {
      return false;
    }
    const normalizedFilePath = normalizePath(filePath);
    return (
      normalizedFilePath.startsWith(`${destinationPath}/`) &&
      normalizedFilePath.slice(destinationPath.length + 1).length > 0 &&
      (this.settings.contentMode === "general" || !normalizedFilePath.slice(destinationPath.length + 1).includes("/")) &&
      normalizedFilePath.toLocaleLowerCase().endsWith(".md")
    );
  }

  getSortedArticles(): TFile[] {
    let folderPath: string;
    try {
      folderPath = this.getEffectiveDestinationPath(this.settings);
    } catch {
      return [];
    }
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];

    const children = this.settings.contentMode === "general" ? this.getDescendants(folder) : folder.children;
    return children
      .filter(
        (file): file is TFile =>
          file instanceof TFile &&
          (file.extension === "md" || this.syncedAttachments.some((entry) => entry.path === file.path)),
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
      const articleIndex = await this.buildArticleIndex(destinationPath, settings.contentMode === "general");
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
      const effectiveMaxItems = maxItems ?? (
        settings.contentMode === "general" && (settings.syncScopeMode ?? "recent") === "all"
          ? 1000
          : settings.maxItems
      );
      const rawResult = await this.runPowerShell(effectiveMaxItems, skipTitles, settings, run, skipSourceIds);
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
      const directoryIndexes = new Map<string, SyncedArticleIndex>();
      const totalItems = items.length;
      let processedIndex = 0;
      for (const item of items) {
        processedIndex++;
        this.assertRunActive(run, extractionCanceled);
        const displayTitle = this.normalizeSourceTitle(item.sourceTitle);
        this.updateOperationCard(run, `正在保存 (${processedIndex}/${totalItems})：${displayTitle.slice(0, 24)}…`);
        try {
          const itemDestination = settings.contentMode === "general"
            ? this.resolveItemDestination(destinationPath, item.relativeFolder) : destinationPath;
          await this.ensureFolder(itemDestination);
          let itemIndex = articleIndex;
          if (settings.contentMode === "general") {
            itemIndex = directoryIndexes.get(itemDestination) ?? await this.buildArticleIndex(itemDestination);
            directoryIndexes.set(itemDestination, itemIndex);
            // Stable identities continue to work even when the source folder/title changes.
            itemIndex.bySourceKey = articleIndex.bySourceKey;
          }
          const status = item.downloadedFile ? await this.saveAttachment(item, itemDestination, settings, run, extractionCanceled, false) : await this.saveArticle(
            item,
            itemDestination,
            itemIndex,
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

      if (!extractionCanceled) {
        try {
          await this.saveSettings();
        } catch (error) {
          console.error("保存 IMA Share Sync 附件索引失败", error);
        }
      }

      if (!extractionCanceled && settings.enableMarkdownConversion && run.savedPdfFiles && run.savedPdfFiles.length > 0) {
        this.updateOperationCard(run, "正在生成 Markdown 笔记…");
        try {
          const converted = await this.convertPdfFilesToMarkdown(run.savedPdfFiles, interactive, run);
          this.assertRunActive(run);
          if (converted?.failed) {
            const error = { title: "PDF → Markdown", message: `${converted.failed} 个 PDF 转换失败，原 PDF 已保留；详细原因见 Obsidian 开发者控制台。` };
            saveErrors.push(error);
            issues.push(error);
          }
        } catch (err) {
          this.assertRunActive(run);
          const error = { title: "PDF → Markdown", message: `转换阶段失败，原 PDF 已保留：${err instanceof Error ? err.message : String(err)}` };
          saveErrors.push(error);
          issues.push(error);
        }
      }

      const errors = [...(result.errors ?? []), ...saveErrors];
      const articleErrors = errors.filter((error) => error.title.trim());
      const taskErrors = errors.filter((error) => !error.title.trim());
      const firstTaskError = taskErrors[0];
      const preserved = counts.created + counts.updated + counts.unchanged;
      const resultParts = [
        counts.created ? `新增 ${counts.created} 篇` : "",
        counts.updated ? `更新 ${counts.updated} 篇` : "",
        counts.unchanged ? `无变化 ${counts.unchanged} 篇` : "",
        counts.skipped ? `跳过 ${counts.skipped} 篇` : "",
        counts.conflict ? `同名冲突 ${counts.conflict} 篇（未覆盖）` : "",
        articleErrors.length ? `失败 ${articleErrors.length} 篇` : "",
        taskErrors.length ? "流程异常" : "",
      ].filter(Boolean).join(" · ");
      const summary = extractionCanceled
        ? `同步已取消：已保留 ${preserved} 篇${resultParts ? ` · ${resultParts}` : ""}`
        : firstTaskError && !items.length && !counts.skipped
          ? `同步未完成：${firstTaskError.message}`
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
      run.pdfValidationAbort?.abort();
      if (run.stagingDirectory) {
        await rm(run.stagingDirectory, { recursive: true, force: true }).catch((error) => console.error("清理同步暂存文件失败", error));
      }
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
    if (!Number.isInteger(settings.maxItems) || settings.maxItems < 1 || settings.maxItems > 1000) {
      throw new Error("检查数量必须在 1–1000 之间。");
    }
    if (settings.syncScopeMode && !["all", "recent"].includes(settings.syncScopeMode)) {
      throw new Error("同步范围模式无效。");
    }
    if (!["general", "speed-reader"].includes(settings.contentMode)) throw new Error("内容模式无效。");
    if (settings.contentMode === "general") {
      if (!["total", "per-folder"].includes(settings.generalSelectionMode)) throw new Error("文件检查数量规则无效。");
      if (typeof settings.includeSubfolders !== "boolean") throw new Error("包含子文件夹开关无效。");
      if (!Number.isInteger(settings.maxFolders) || settings.maxFolders < 1 || settings.maxFolders > 20) {
        throw new Error("最多检查文件夹数必须在 1–20 之间。");
      }
      if (!Number.isInteger(settings.maxFolderDepth) || settings.maxFolderDepth < 0 || settings.maxFolderDepth > 5) {
        throw new Error("向下查找层数必须在 0–5 之间。");
      }
    }
    if (!["all", "contains", "prefix", "regex"].includes(settings.titleFilterMode)) throw new Error("标题筛选方式无效。");
    if (settings.contentMode === "general" && settings.titleFilterMode !== "all" && !settings.titleFilter.trim()) {
      throw new Error("请填写标题筛选内容，或选择“全部标题”。");
    }
    if (settings.titleFilter.length > 300) throw new Error("标题筛选内容不能超过 300 个字符。");
    return this.getEffectiveDestinationPath(settings);
  }

  getEffectiveDestinationPath(settings: Readonly<ImaSpeedSyncSettings> = this.settings): string {
    const base = this.resolveDestinationPath(settings.destinationPath);
    if (settings.includeSourceFolder && settings.folderName.trim()) {
      const safe = this.sanitizeBasename(settings.folderName.trim());
      if (safe) return normalizePath(`${base}/${safe}`);
    }
    return base;
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

  private getDescendants(folder: TFolder): (TFile | TFolder)[] {
    const entries: (TFile | TFolder)[] = [];
    for (const child of folder.children) {
      if (child instanceof TFolder) entries.push(...this.getDescendants(child));
      else if (child instanceof TFile) entries.push(child);
    }
    return entries;
  }

  private resolveItemDestination(destination: string, folders: string[] = []): string {
    if (folders.length > 5) throw new Error("子目录层级超过 5 层。");
    const parts = folders.map((part) => {
      if (!part.trim() || part === "." || part === "..") throw new Error("来源子目录名称无效。");
      const safe = this.sanitizeBasename(part);
      // Distinct source folder names must not collapse onto the same local path.
      return safe === part ? safe : `${safe}-${createHash("sha256").update(part).digest("hex").slice(0, 8)}`;
    });
    return this.resolveDestinationPath([destination, ...parts].join("/"));
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
    if (!settings.overwriteSameName && (existing || articleIndex.occupiedFileNames.has(preferredFileName))) {
      return "skipped";
    }
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
    this.assertRunActive(run);
    await this.app.vault.process(existing, () => {
      this.assertRunActive(run);
      return markdown;
    });
    articleIndex.bySourceKey.set(sourceKey, existing);
    articleIndex.markdownByBasename.set(existing.basename.toLocaleLowerCase(), existing);
    articleIndex.legacyBySourceTitle.delete(sourceTitle);
    return "updated";
  }

  private async saveAttachment(
    item: ExtractedArticle,
    destination: string,
    settings: Readonly<ImaSpeedSyncSettings>,
    run: SyncRun,
    allowCancellation: boolean,
    persistSettings = true,
  ): Promise<SaveStatus> {
    if (settings.contentMode !== "general" || !item.complete || !run.stagingDirectory ||
      !/^downloads\/file-[a-f0-9]{32}\.(pdf|png|jpe?g|gif|webp|mp3|wav|m4a|mp4|webm|ogg)$/.test(item.downloadedFile ?? "")) {
      throw new Error("原文件下载结果无效。");
    }
    const staging = await realpath(run.stagingDirectory);
    const stagedPath = await realpath(path.join(staging, item.downloadedFile!));
    const relative = path.relative(staging, stagedPath);
    if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") throw new Error("原文件不在本次暂存目录内。");
    const stat = await lstat(stagedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1024 * 1024) throw new Error("原文件为空、过大或类型无效。");
    const data = await readFile(stagedPath);
    const extension = path.extname(stagedPath).toLowerCase();
    const header = data.subarray(0, 16);
    const ascii = header.toString("latin1");
    const valid = extension === ".pdf" ? ascii.startsWith("%PDF-") && data.subarray(-2048).includes(Buffer.from("%%EOF"))
      : extension === ".png" ? header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : [".jpg", ".jpeg"].includes(extension) ? header[0] === 255 && header[1] === 216 && data.at(-2) === 255 && data.at(-1) === 217
      : extension === ".gif" ? /^GIF8[79]a/.test(ascii)
      : extension === ".webp" ? ascii.startsWith("RIFF") && ascii.slice(8,12) === "WEBP"
      : extension === ".wav" ? ascii.startsWith("RIFF") && ascii.slice(8,12) === "WAVE"
      : extension === ".ogg" ? ascii.startsWith("OggS")
      : extension === ".webm" ? header.subarray(0,4).equals(Buffer.from([26,69,223,163]))
      : [".mp4", ".m4a"].includes(extension) ? ascii.slice(4,8) === "ftyp"
      : ascii.startsWith("ID3") || (header[0] === 255 && (header[1]! & 224) === 224);
    if (!valid) throw new Error("下载内容不是有效原文件，未将错误页或残缺内容存入仓库。");
    this.assertRunActive(run, allowCancellation);
    if (extension === ".pdf") {
      const controller = new AbortController();
      run.pdfValidationAbort = controller;
      try {
        await validatePdfStructure(data, { signal: controller.signal, timeoutMs: 30_000 });
      } catch (error) {
        if (controller.signal.aborted) throw new SyncCanceledError();
        throw error;
      } finally {
        if (run.pdfValidationAbort === controller) run.pdfValidationAbort = undefined;
      }
      this.assertRunActive(run, allowCancellation);
    }
    const scope = this.createSourceScope(settings);
    const known = item.sourceId ? this.syncedAttachments.find((entry) => entry.sourceScope === scope && entry.sourceId === item.sourceId) : undefined;
    const knownFile = known ? this.app.vault.getAbstractFileByPath(known.path) : null;
    const title = this.normalizeSourceTitle(item.sourceTitle);
    const name = `${this.sanitizeBasename(title.replace(/\.[^.]+$/, ""))}${extension}`;
    const target = knownFile instanceof TFile && knownFile.path.startsWith(`${this.getEffectiveDestinationPath(settings)}/`)
      ? knownFile.path : normalizePath(`${destination}/${name}`);
    const parent = this.app.vault.getAbstractFileByPath(target.slice(0, target.lastIndexOf("/")));
    const existing = this.app.vault.getAbstractFileByPath(target) ?? (parent instanceof TFolder
      ? parent.children.find((file) => file.name.toLocaleLowerCase() === name.toLocaleLowerCase()) : undefined);
    if (existing && !settings.overwriteSameName) return "skipped";
    if (existing && (!(existing instanceof TFile) || existing !== knownFile)) return "conflict";
    this.assertRunActive(run, allowCancellation);
    const bytes = Uint8Array.from(data).buffer;
    if (existing instanceof TFile) {
      const current = await this.app.vault.readBinary(existing);
      // Completed new downloads may be preserved after extraction cancellation,
      // but cancellation never authorizes replacing an existing user file.
      this.assertRunActive(run);
      if (Buffer.from(current).equals(data)) {
        if (extension === ".pdf") {
          run.savedPdfFiles ??= [];
          run.savedPdfFiles.push({ path: target, title });
        }
        return "unchanged";
      }
      await this.app.vault.modifyBinary(existing, bytes);
    } else await this.app.vault.createBinary(target, bytes);
    if (extension === ".pdf") {
      run.savedPdfFiles ??= [];
      run.savedPdfFiles.push({ path: target, title });
    }
    this.syncedAttachments = this.syncedAttachments.filter((entry) => entry.path !== target);
    if (item.sourceId) this.syncedAttachments.push({ path: target, sourceId: item.sourceId, sourceScope: scope });
    if (persistSettings) await this.saveSettings();
    return existing ? "updated" : "created";
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
      : [this.createSourceScope(settings), settings.folderName.trim(), ...(item.relativeFolder ?? []), item.sourceTitle, "content", item.body.replace(/\r\n?/g, "\n").trim()];
    return `general:${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`;
  }

  private getExistingSourceIds(index: SyncedArticleIndex, settings: Readonly<ImaSpeedSyncSettings>): string[] {
    const scope = this.createSourceScope(settings);
    return [...new Set([...index.metadataByPath.values()]
      .filter((metadata) => metadata.sourceScope === scope && metadata.sourceId)
      .map((metadata) => metadata.sourceId!).concat(this.syncedAttachments.filter((entry) =>
        entry.sourceScope === scope && entry.path.startsWith(`${this.getEffectiveDestinationPath(settings)}/`) &&
        this.app.vault.getAbstractFileByPath(entry.path) instanceof TFile).map((entry) => entry.sourceId)))];
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

  private async buildArticleIndex(destinationPath: string, recursive = false): Promise<SyncedArticleIndex> {
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

    for (const child of recursive ? this.getDescendants(folder) : folder.children) {
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
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.items)) {
        for (const item of obj.items) {
          if (item && typeof item === "object") {
            const raw = item as Record<string, unknown>;
            if (Array.isArray(raw.downloadedFile)) {
              const fileStr = (raw.downloadedFile as unknown[]).filter((part): part is string => typeof part === "string").pop();
              raw.downloadedFile = fileStr;
            }
          }
        }
      }
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
            ((item as Record<string, unknown>).downloadedFile === undefined ||
              typeof (item as Record<string, unknown>).downloadedFile === "string" ||
              (Array.isArray((item as Record<string, unknown>).downloadedFile) &&
                ((item as Record<string, unknown>).downloadedFile as unknown[]).some((part) => typeof part === "string"))) &&
            ((item as Record<string, unknown>).complete === undefined || typeof (item as Record<string, unknown>).complete === "boolean") &&
            ((item as Record<string, unknown>).relativeFolder === undefined ||
              (Array.isArray((item as Record<string, unknown>).relativeFolder) &&
                ((item as Record<string, unknown>).relativeFolder as unknown[]).every((part) => typeof part === "string"))) &&
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
    run.stagingDirectory = runDirectory;
    try {
      const downloadDirectory = path.join(runDirectory, "downloads");
      await mkdir(downloadDirectory);
      const scriptPath = await this.writeRuntimeScript(runDirectory);
      const inputPath = path.join(runDirectory, "input.json");
      const outputPath = path.join(runDirectory, "output.json");
      const cancellationPath = path.join(runDirectory, "cancel");
      run.cancellationPath = cancellationPath;
      if (this.activeRun === run) this.cancellationPath = cancellationPath;

      await writeFile(inputPath, JSON.stringify({
        skipTitles, skipSourceIds,
        syncScopeMode: settings.syncScopeMode ?? "recent",
        generalSelectionMode: settings.generalSelectionMode,
        includeSubfolders: settings.includeSubfolders && settings.maxFolderDepth > 0,
        maxFolders: settings.maxFolders,
        maxFolderDepth: settings.includeSubfolders ? settings.maxFolderDepth : 0,
        downloadDirectory,
        existingFiles: settings.overwriteSameName ? [] : (() => {
          const destination = this.getEffectiveDestinationPath(settings);
          const folder = this.app.vault.getAbstractFileByPath(destination);
          return folder instanceof TFolder ? this.getDescendants(folder)
            .filter((file) => file instanceof TFile).map((file) => file.path.slice(destination.length + 1)) : [];
        })(),
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
      // sync() owns cleanup after binary files have been imported into the vault.
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

  async convertPdfFilesToMarkdown(
    pdfFiles: { path: string; title: string }[],
    showNotice = true,
    run?: SyncRun,
  ): Promise<ConvertResultSummary | undefined> {
    if (!this.settings.enableMarkdownConversion || !pdfFiles.length) return;
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;

    const vaultBase = this.app.vault.adapter.getBasePath();

    const tasks: ConvertTask[] = [];
    for (const file of pdfFiles) {
      const fullPdfPath = path.isAbsolute(file.path) ? file.path : path.join(vaultBase, file.path);
      const fullMdPath = fullPdfPath.replace(/\.pdf$/i, ".md");
      tasks.push({
        pdfPath: fullPdfPath,
        mdPath: fullMdPath,
        title: file.title,
        embedPdfLink: this.settings.embedPdfLinkInMarkdown,
        scope: this.settings.markdownConversionScope,
      });
    }

    let notice: Notice | undefined;
    if (showNotice) {
      notice = new Notice(`正在转换 Markdown 笔记 (0/${tasks.length})...`, 0);
    }

    const abortController = new AbortController();
    if (run) run.markdownAbort = abortController;

    try {
      const result = await runMarkdownConversion(
        tasks,
        markdownRunnerScript,
        (progress, total) => {
          if (notice) {
            notice.setMessage(`正在转换 Markdown 笔记 (${progress}/${total})...`);
          }
        },
        abortController.signal,
      );
      if (notice) notice.hide();
      if (showNotice) {
        new Notice(
          `Markdown 转换完成：新增/更新 ${result.completed} 篇，跳过 ${result.skipped} 篇${result.failed ? `，失败 ${result.failed} 篇` : ""}`,
        );
      }
      return result;
    } catch (err) {
      if (notice) notice.hide();
      console.error("Markdown 转换执行异常:", err);
      if (showNotice) {
        new Notice(`Markdown 转换失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (run) throw err;
    } finally {
      if (run && run.markdownAbort === abortController) {
        run.markdownAbort = undefined;
      }
    }
  }

  async convertAllVaultPdfFiles(interactive = true): Promise<void> {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    const vaultBase = this.app.vault.adapter.getBasePath();
    const targetDir = this.getEffectiveDestinationPath(this.settings);
    const fullTargetDir = path.join(vaultBase, targetDir);

    const pdfList: { path: string; title: string }[] = [];
    const walk = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullP = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullP);
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
            const relPath = path.relative(vaultBase, fullP).replace(/\\/g, "/");
            const title = entry.name.replace(/\.pdf$/i, "");
            pdfList.push({ path: relPath, title });
          }
        }
      } catch { /* Skip directories that cannot be read; preserve existing files. */ }
    };

    await walk(fullTargetDir);

    if (!pdfList.length) {
      if (interactive) new Notice(`未在目标目录 [${targetDir}] 下找到任何 PDF 文件。`);
      return;
    }

    if (interactive) new Notice(`扫描到 ${pdfList.length} 篇 PDF，开始生成 Markdown...`);
    await this.convertPdfFilesToMarkdown(pdfList, interactive);
  }
}
