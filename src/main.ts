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
  type SettingDefinitionItem,
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
import { isOcrProvider, processPdfWithOcr, type LocalOcrMode, type OcrProvider } from "./pdf-ocr-core";
import { OcrAccountError, OcrJobError, recognizeApi, type OcrJobFailure } from "./ocr-api";
import { confirmOcr, renderOcrSettings } from "./ocr-settings";
import { checkOcrRuntime, defaultOcrRuntime, LocalOcrMemoryError, LocalOcrSetupError, recognizeLocal } from "./ocr-local";
import { getAppLanguage, getStrings } from "./i18n";
import { calculateDashboardStats, localDateKey, restoreMetrics, type SyncMetrics } from "./dashboard-stats";
import { createSourceBinding, restoreSourceBinding, rebindSource, isSourceInspection, isSourceNeedsRebind,
  restorePendingSourceResume, isSourcePendingRecords,
  type SourceTargetKind, type SourceBinding, type SourceInspection, type SourceNeedsRebind, type SourcePendingRecord, type PendingSourceResume } from "./source-binding";

import { isSourceCatalog, type SourceCatalog } from "./source-catalog";
import { createScopeDraft, scopeDirty, scopeFingerprint, scopeValues, scopeKeys, sourcePath, sameSource, type ScopeDraft, type ScopeValues } from "./scope-draft";
import { ScopePicker } from "./scope-picker";
import { IdentityPicker } from "./identity-picker";
import { DesktopIdentityProvider, type NativeIdentityRequest } from "./desktop-identity-provider";
import { runSilentIdentity } from "./silent-identity-runner";
import { windowsPowerShellPath } from "./windows-runtime";
import { buildFolderDestinations, folderDestinationKey, resolveFolderDestination } from "./folder-destinations";
import { drawFlowMap, FlowSettingsModal, registerFlowIcon, type FlowPanels, type FlowGroup } from "./flow-settings";
import { sourceHealthKey, sourceProblemMessage } from "./source-health";
import { quantityPopover } from "./quantity-popover";
import { setQuietLabel, silenceHoverHints } from "./quiet-labels";
import { activeProfile, chooseIdentity, refreshIdentityLabels, updateIdentityOptions, verifyIdentity, acknowledgeIdentityRange, migrateDesktopIdentity, desktopSource,
  type IdentityProvider, type IdentityState, type IdentityChoice } from "./source-identity";

const GITHUB_REPOSITORY_URL = "https://github.com/oooing/ima-share-sync";

interface ImaSpeedSyncSettings {
  autoSync: boolean;
  hasConsented: boolean;
  knowledgeBaseName: string;
  folderName: string;
  sourceTargetKind: SourceTargetKind;
  sourceFolderPath?: string[];
  sourceCatalogPath?: string[];
  sourceBinding?: SourceBinding;
  sourceIdentity?: IdentityState;
  pendingSourceResume?: PendingSourceResume;
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
  imageOcrEnabled: boolean;
  embedPdfLinkInMarkdown: boolean;
  ocrProvider: OcrProvider;
  ocrRuntimePath: string;
  ocrMobileRuntimePath: string;
  ocrSecretId: string;
  language?: "auto" | "zh" | "en";
}

type NotificationSetting = "notificationsEnabled" | "notifyAutoSuccess" | "notifyAutoFailure" | "notifyManualResult" | "showErrorBadge" | "showOperationBefore" | "showOperationAfter";

interface SyncReport {
  action?: "source-settings";
  id?: string;
  read?: boolean;
  finishedAt: number;
  interactive: boolean;
  status: "success" | "failed" | "canceled";
  summary: string;
  errors: ExtractionError[];
  destination?: string;
  metrics?: SyncMetrics;
  kind?: "markdown";
  conversion?: MarkdownConversionMetrics;
}

interface MarkdownConversionMetrics {
  durationMs: number;
  uploadedFiles: number;
  uploadedBytes: number;
  unconfirmedFiles: number;
  unconfirmedPdfBytes: number;
}

export interface MarkdownDashboardState {
  status: "idle" | "converting" | "completed" | "canceled" | "failed";
  total: number;
  current: number;
  currentTitle?: string;
  completed: number;
  skipped: number;
  failed: number;
  deferred?: number;
  lastFinishedAt?: number;
}

const SYNC_REPORTS_PER_PAGE = 20;

function isPendingPdfPath(value: unknown): value is string {
  return typeof value === "string" && /\.pdf$/i.test(value) &&
    !/[:\\\0]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
}

function restoreConversionMetrics(value: unknown): MarkdownConversionMetrics | undefined {
  if (!value || typeof value !== "object") return;
  const fields = [
    "durationMs", "uploadedFiles", "uploadedBytes", "unconfirmedFiles", "unconfirmedPdfBytes",
  ] as const;
  const candidate = value as Record<string, unknown>;
  const restored = {} as MarkdownConversionMetrics;
  for (const field of fields) {
    const amount = candidate[field];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return;
    restored[field] = amount;
  }
  return restored;
}

function formatConversionMetrics(metrics: MarkdownConversionMetrics): string {
  const seconds = Math.floor(metrics.durationMs / 1000);
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : seconds ? `${seconds} 秒` : "不足 1 秒";
  const pdfSize = (bytes: number) => bytes >= 1_000_000 || bytes === 0
    ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${(bytes / 1_000).toFixed(2)} KB`;
  const unconfirmed = metrics.unconfirmedFiles
    ? ` · 未确认受理 ${metrics.unconfirmedFiles} 份（原文件 ${pdfSize(metrics.unconfirmedPdfBytes)}）` : "";
  return `转换耗时 ${duration} · 已上传 ${metrics.uploadedFiles} 份（${pdfSize(metrics.uploadedBytes)}）${unconfirmed}`;
}

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
    for (const entry of report.errors) {
      if (entry && typeof entry.title === "string" && typeof entry.message === "string") {
        const ocr = entry.ocr;
        const jobId = typeof ocr?.jobId === "string" && /^[a-z0-9_-]{1,128}$/i.test(ocr.jobId) ? ocr.jobId : "";
        const reason = typeof ocr?.reason === "string" ? ocr.reason.trim().slice(0, 600) : undefined;
        errors.push({
          title: entry.title.slice(0, 200),
          message: entry.message.slice(0, 600),
          ...(jobId || reason ? { ocr: { jobId, reason } } : {}),
        });
      }
    }
    const conversion = restoreConversionMetrics(report.conversion);
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
      ...(report.kind === "markdown" ? { kind: "markdown" as const } : {}),
      ...(report.action === "source-settings" ? { action: "source-settings" as const } : {}),
      ...(typeof report.destination === "string" ? { destination: report.destination } : {}),
      ...(restoreMetrics(report.metrics) ? { metrics: restoreMetrics(report.metrics) } : {}),
      ...(conversion ? { conversion } : {}),
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
  relativeFolderIds?: string[];
  downloadedFile?: string;
}

interface ExtractionError {
  title: string;
  message: string;
  ocr?: OcrJobFailure;
}

interface ExtractionResult {
  identityResult?: unknown;
  identityErrorCode?: string;
  sourceFolderObservations?: { sourceId: string; relativeFolder: string[]; relativeFolderIds: string[] }[];
  sourceCatalog?: SourceCatalog;
  sourceInspection?: SourceInspection;
  sourceNeedsRebind?: SourceNeedsRebind;
  sourcePendingRecords?: SourcePendingRecord[];
  sourcePendingUnresumableCount?: number;
  busy?: boolean;
  canceled?: boolean;
  locked?: boolean;
  items?: ExtractedArticle[];
  errors?: ExtractionError[];
  skippedTitles?: string[];
  skippedSourceIds?: string[];
}

interface PdfConversionFile {
  path: string;
  title: string;
  /** Recovery of an already downloaded PDF never opts into a cloud upload. */
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
  savedPdfFiles?: PdfConversionFile[];
  markdownAbort?: AbortController;
  markdownErrors?: ExtractionError[];
  markdownMetrics?: MarkdownConversionMetrics;
  destination?: string;
  metrics?: SyncMetrics;
}

interface SyncedAttachment {
  path: string;
  sourceId: string;
  sourceScope: string;
}

interface SourceRebindSession {
  originalFolderPath?: string[];
  candidateFolderPath?: string[];
  readonly knowledgeBaseName: string;
  readonly originalFolderName: string;
  readonly localDestination: string;
  readonly sourceScope: string;
  candidateName: string;
  candidateKnowledgeBaseName: string;
  revision: number;
  inspection?: SourceInspection;
  originalTargetKind?: SourceTargetKind;
  candidateTargetKind?: SourceTargetKind;
  selection?: boolean;
  preserveIdentity?: boolean;
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
  sourceTargetKind: "folder",
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
  imageOcrEnabled: false,
  embedPdfLinkInMarkdown: true,
  ocrProvider: "api",
  ocrRuntimePath: "",
  ocrMobileRuntimePath: "",
  ocrSecretId: "ima-share-sync-baidu-ocr",
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
  silenceHoverHints(header);
}

class SyncHistoryPanel {
  contentEl!: HTMLElement;
  private page = 0;
  private focusedId?: string;
  private focusedRecord?: HTMLDetailsElement;
  private expandedIds = new Set<string>();
  private progressEl?: HTMLParagraphElement;

  constructor(private readonly getReports: () => readonly SyncReport[],
    focusedId: string | undefined, private readonly onViewed: (reports: readonly SyncReport[]) => void,
    private readonly onClosed: () => void, private readonly onSourceSettings: () => void,
    private readonly getProgress: () => string) {
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
    this.progressEl = this.contentEl.createEl("p", { attr: { role: "status" } });
    this.updateProgress();
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
        text: `${new Date(report.finishedAt).toLocaleString("zh-CN")} · ${report.kind === "markdown" ? "文档转换" : report.interactive ? "手动同步" : "自动同步"} · ${report.status === "failed" ? "存在异常" : report.status === "canceled" ? "已取消" : "已完成"}`,
      });
      record.createEl("p", { text: report.summary });
      if (report.conversion) {
        record.createEl("p", { text: formatConversionMetrics(report.conversion) });
      }
      if (report.action === "source-settings" && this.onSourceSettings) {
        record.createEl("button", { text: "检查来源" }).addEventListener("click", this.onSourceSettings);
      }
      for (const error of report.errors) {
        const title = error.title || "同步任务";
        if (!error.ocr) {
          record.createEl("p", { text: `${title}：${error.message}` });
          continue;
        }
        const failure = record.createEl("details", { cls: "ima-share-sync-ocr-failure" });
        failure.createEl("summary", { text: title });
        failure.createEl("p", { text: error.ocr.reason ? `百度返回：${error.ocr.reason}` : "百度未返回详细错误。" });
        if (error.ocr.jobId) failure.createEl("p", { text: `百度任务 ID：${error.ocr.jobId}` });
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

  updateProgress(): void {
    if (!this.progressEl) return;
    const progress = this.getProgress();
    this.progressEl.hidden = !progress;
    this.progressEl.textContent = progress;
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

class SourceSelectionModal extends Modal {
  private closed = false;
  private busy = false;
  private saving = false;
  private message = "";
  private knowledgeBases?: SourceCatalog;
  private folders?: SourceCatalog;
  private confirmButton?: HTMLButtonElement;
  private statusEl?: HTMLElement;
  private folderInput?: HTMLInputElement;
  private folderDropdown?: HTMLSelectElement;

  constructor(private readonly plugin: ImaSpeedSyncPlugin, private readonly session: SourceRebindSession) {
    super(plugin.app);
  }

  override onOpen(): void { this.render(); }

  private invalidate(): void {
    this.message = "";
    this.statusEl?.setText("");
    if (this.confirmButton) this.confirmButton.disabled = true;
  }

  private chooseKnowledgeBase(name: string): void {
    this.plugin.setSourceRebindKnowledgeBase(this.session, name);
    this.plugin.setSourceRebindCandidate(this.session, "");
    this.folders = undefined;
    if (this.folderInput) this.folderInput.value = "";
    if (this.folderDropdown) this.folderDropdown.disabled = true;
    this.invalidate();
  }

  private render(): void {
    if (this.closed) return;
    const s = getStrings();
    this.titleEl.setText(s.sourceSelectionTitle);
    this.contentEl.empty();
    this.folderInput = undefined;
    this.folderDropdown = undefined;
    const root = this.contentEl;
    new Setting(root).setName(s.kbName).setDesc(s.kbDesc)
      .addText((text) => text.setValue(this.session.candidateKnowledgeBaseName).setDisabled(this.busy)
        .onChange((value) => { this.chooseKnowledgeBase(value); }))
      .addButton((button) => button.setButtonText(s.sourceCatalogRead).setDisabled(this.busy)
        .onClick(() => { void this.read("knowledge-bases"); }));
    if (this.knowledgeBases) {
      new Setting(root).setName(s.sourceCatalogPrompt).setDesc(s.sourceCatalogVisible)
        .addDropdown((dropdown) => {
          dropdown.addOption("", s.sourceChoose);
          for (const name of this.knowledgeBases!.names) dropdown.addOption(name, name);
          dropdown.setDisabled(this.busy).onChange((value) => {
            if (value) { this.chooseKnowledgeBase(value); this.render(); }
          });
        });
    }
    new Setting(root).setName(s.sourceRange).setDesc(s.sourceRangeDesc)
      .addDropdown((dropdown) => dropdown.addOption("folder", s.sourceRangeFolder).addOption("knowledge-base", s.sourceRangeKnowledgeBase)
        .setValue(this.session.candidateTargetKind ?? "folder").setDisabled(this.busy).onChange((value) => {
          this.plugin.setSourceSelectionKind(this.session, value as SourceTargetKind); this.invalidate(); this.render();
        }));
    if (this.session.candidateTargetKind !== "knowledge-base") {
      new Setting(root).setName(s.sourceFolderName).setDesc(s.sourceFolderDesc)
        .addText((text) => { this.folderInput = text.inputEl; text.setValue(this.session.candidateName).setDisabled(this.busy).onChange((value) => {
          this.plugin.setSourceRebindCandidate(this.session, value); this.invalidate();
        }); })
        .addButton((button) => button.setButtonText(s.sourceCatalogRead).setDisabled(this.busy)
          .onClick(() => { void this.read("folders"); }));
      if (this.folders && this.folders.knowledgeBaseName === this.session.candidateKnowledgeBaseName) {
        new Setting(root).setName(s.sourceCatalogPrompt).setDesc(s.sourceCatalogFolders)
          .addDropdown((dropdown) => {
            this.folderDropdown = dropdown.selectEl;
            dropdown.addOption("", s.sourceChoose);
            for (const name of this.folders!.names) dropdown.addOption(name, name);
            dropdown.setDisabled(this.busy).onChange((value) => {
              if (value) { this.plugin.setSourceRebindCandidate(this.session, value); this.invalidate(); this.render(); }
            });
          });
      }
    }
    if (this.session.knowledgeBaseName) new Setting(root).setName(s.sourceSelectionRename).setDesc(s.sourceSelectionRenameDesc)
      .addToggle((toggle) => toggle.setValue(!!this.session.preserveIdentity).setDisabled(this.busy).onChange((value) => {
        this.plugin.setSourceSelectionIdentity(this.session, value); this.invalidate();
      }));
    new Setting(root).setName(s.sourceRebindDestination).setDesc(this.session.localDestination);
    const status = root.createDiv({ attr: { role: "status", "aria-live": "polite" } });
    this.statusEl = status;
    status.setText(this.message);
    const actions = root.createDiv({ cls: "modal-button-container" });
    const check = actions.createEl("button", { text: s.sourceRebindCheck });
    check.disabled = this.busy;
    check.addEventListener("click", () => { void this.check(); });
    const confirm = actions.createEl("button", { text: s.sourceSelectionConfirm, cls: "mod-cta" });
    this.confirmButton = confirm;
    confirm.disabled = this.busy || !this.session.inspection;
    confirm.addEventListener("click", () => { void this.confirm(); });
    const cancel = actions.createEl("button", { text: s.sourceRebindCancel });
    cancel.disabled = this.saving;
    cancel.addEventListener("click", () => this.close());
    silenceHoverHints(this.modalEl);
  }

  private async read(kind: "knowledge-bases" | "folders"): Promise<void> {
    this.busy = true; this.message = getStrings().sourceCatalogReading; this.render();
    try {
      const catalog = await this.plugin.readSourceCatalog(this.session, kind);
      if (this.closed) return;
      if (kind === "knowledge-bases") this.knowledgeBases = catalog; else this.folders = catalog;
      this.message = catalog.ambiguousNames.length ? getStrings().sourceCatalogAmbiguous : catalog.names.length ? "" : getStrings().sourceCatalogEmpty;
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.render(); }
  }

  private async check(): Promise<void> {
    this.busy = true; this.message = getStrings().sourceRebindChecking; this.render();
    try {
      const inspection = await this.plugin.inspectSourceFolder(this.session);
      this.message = `${inspection.knowledgeBaseName}\n${inspection.breadcrumb.join(" > ")}`;
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.render(); }
  }

  private async confirm(): Promise<void> {
    this.busy = true; this.saving = true; this.render();
    try {
      await this.plugin.confirmSourceBinding(this.session);
      this.saving = false; this.close(); new Notice(getStrings().sourceSelectionSaved);
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; this.saving = false; this.render(); }
  }

  override onClose(): void {
    this.closed = true;
    if (!this.saving) this.plugin.cancelSourceRebind(this.session);
    this.contentEl.empty();
  }
}

class SourceRebindModal extends Modal {
  private closed = false;
  private saving = false;

  constructor(private readonly plugin: ImaSpeedSyncPlugin, private readonly session: SourceRebindSession) {
    super(plugin.app);
  }

  override onOpen(): void {
    const s = getStrings();
    this.titleEl.setText(s.sourceRebind);
    const { contentEl } = this;
    new Setting(contentEl).setName(s.kbName).setDesc(this.session.knowledgeBaseName);
    new Setting(contentEl).setName(s.sourceRebindOld).setDesc(this.session.originalFolderName);
    new Setting(contentEl).setName(s.sourceRebindDestination).setDesc(this.session.localDestination);
    let kbInput: HTMLInputElement;
    new Setting(contentEl).setName(s.sourceRebindKnowledgeBase).addText((text) => {
      kbInput = text.inputEl;
      text.setValue(this.session.candidateKnowledgeBaseName).onChange((value) => {
        this.plugin.setSourceRebindKnowledgeBase(this.session, value);
        confirm.disabled = true;
        status.setText("");
      });
    });
    let input: HTMLInputElement;
    new Setting(contentEl).setName(s.sourceRebindNew).addText((text) => {
      input = text.inputEl;
      text.setValue(this.session.candidateName).onChange((value) => {
        this.plugin.setSourceRebindCandidate(this.session, value);
        confirm.disabled = true;
        status.setText("");
      });
    });
    const status = contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const check = actions.createEl("button", { text: s.sourceRebindCheck });
    const confirm = actions.createEl("button", { text: s.sourceRebindConfirm, cls: "mod-cta" });
    const cancel = actions.createEl("button", { text: s.sourceRebindCancel });
    confirm.disabled = true;
    check.addEventListener("click", () => { void (async () => {
      check.disabled = true;
      confirm.disabled = true;
      status.setText(s.sourceRebindChecking);
      try {
        const inspection = await this.plugin.inspectSourceFolder(this.session);
        if (this.closed) return;
        status.setText(`${s.kbName}: ${inspection.knowledgeBaseName}\n${s.sourceRebindVerified}: ${inspection.breadcrumb.join(" > ")}`);
        confirm.disabled = false;
      } catch (error) {
        if (!this.closed) status.setText(error instanceof Error ? error.message : String(error));
      } finally {
        if (!this.closed) check.disabled = false;
      }
    })(); });
    confirm.addEventListener("click", () => { void (async () => {
      this.saving = true;
      confirm.disabled = true;
      check.disabled = true;
      input.disabled = true;
      kbInput.disabled = true;
      cancel.disabled = true;
      try {
        await this.plugin.confirmSourceBinding(this.session);
        this.saving = false;
        this.close();
        new Notice(s.sourceRebindSaved);
      } catch (error) {
        if (!this.closed) status.setText(error instanceof Error ? error.message : String(error));
      } finally {
        this.saving = false;
        if (!this.closed) {
          check.disabled = false;
          input.disabled = false;
          kbInput.disabled = false;
          cancel.disabled = false;
        }
      }
    })(); });
    cancel.addEventListener("click", () => this.close());
    silenceHoverHints(this.modalEl);
  }

  override close(): void {
    if (!this.saving) super.close();
  }

  override onClose(): void {
    this.closed = true;
    this.plugin.cancelSourceRebind(this.session);
    this.contentEl.empty();
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
    silenceHoverHints(this.modalEl);
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
  private conversionProgressEl?: HTMLParagraphElement;
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
    this.conversionProgressEl = undefined;
    if (this.page === "history" && this.history) {
      this.history.mount(this.contentEl);
      return;
    }
    if (this.page === "articles") {
      renderPageHeader(this.contentEl, "文章", () => this.navigate("home", "文章"));
      this.renderArticles();
      return;
    }
    const heading = this.contentEl.createDiv({ cls: "ima-share-sync-heading ima-palette-9" });
    const logo = heading.createSpan({ cls: "ima-share-sync-brand-icon", attr: { "aria-hidden": "true" } });
    setIcon(logo, IMA_SHARE_SYNC_ICON_ID);
    const identity = heading.createDiv({ cls: "ima-share-sync-brand-text" });
    identity.createEl("h3", { text: this.getDisplayText() });
    identity.createSpan({
      cls: "ima-share-sync-version",
      text: `v${this.plugin.manifest.version}`,
      attr: { "aria-label": `当前版本 ${this.plugin.manifest.version}` },
    });

    const toolbar = this.contentEl.createDiv({ cls: "ima-speed-sync-toolbar ima-palette-9" });
    const syncGroup = toolbar.createDiv({ cls: `ima-speed-sync-split-button${this.plugin.isRunning ? " is-running" : ""}` });
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
    modeButton.addEventListener("click", (event) => this.showCollisionModeMenu(event));

    const settingsButton = toolbar.createEl("button", { text: "设置", cls: "ima-speed-sync-settings-button" });
    settingsButton.addEventListener("click", () => this.plugin.openSettings());

    this.plugin.renderSyncStatus(this.contentEl);
    this.conversionProgressEl = this.contentEl.createEl("p", { attr: { role: "status" } });
    this.updateConversionProgress();

    const entry = this.contentEl.createEl("button", {
      text: `文章（${this.plugin.getSortedArticles().length}）`, cls: "ima-share-sync-nav-entry",
      attr: { "data-nav-key": "文章" },
    });
    entry.addEventListener("click", () => this.navigate("articles"));
    this.plugin.renderHistoryEntry(this.contentEl);
    silenceHoverHints(this.contentEl);
  }

  updateConversionProgress(): void {
    if (this.page === "history") this.history?.updateProgress();
    if (!this.conversionProgressEl) return;
    const progress = this.plugin.getConversionProgressText();
    this.conversionProgressEl.hidden = !progress;
    this.conversionProgressEl.textContent = progress;
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
  private renderRoot?: HTMLElement;

  override getSettingDefinitions(): SettingDefinitionItem[] {
    // Index names only: registering settings must not read IMA or change saved options.
    const aliases = ["IMA", "同步", "知识库", "文件夹", "同名覆盖", "PDF", "Markdown", "自动同步", "日志", "OCR", "扫描 PDF", "访问令牌", "云端识别", "Baidu API", "AI Studio", "access token"];
    for (const language of ["zh", "en"] as const) {
      for (const [key, value] of Object.entries(getStrings(language))) {
        if (typeof value === "string" && (key.endsWith("Name") || key.startsWith("tab"))) aliases.push(value);
      }
    }
    return [{
      name: "IMA Share Sync",
      aliases: [...new Set(aliases)],
      render: setting => {
        // Reuse the custom UI and its validated save paths on both host generations.
        setting.settingEl.empty();
        setting.settingEl.addClass("ima-settings-host");
        const root = setting.settingEl.createDiv({ cls: "ima-settings-surface" });
        this.renderRoot = root;
        this.renderSettings();
        if (this.plugin.identityProvider) void this.refreshIdentitySource();
        return () => {
          if (this.renderRoot === root) { this.hide(); this.renderRoot = undefined; }
        };
      },
    }];
  }
  private flowModal?: FlowSettingsModal;
  private flowPanels?: FlowPanels;
  private updateFlowMap?: () => void;
  private activeTabId: "stats" | "scope" | "markdown" | "notifications" | "general" = "stats";
  private updateScopeSummary?: () => void;
  private quantitySelect?: HTMLSelectElement;
  private tabButtons = new Map<string, HTMLElement>();
  private panels: Record<"stats" | "scope" | "markdown" | "notifications" | "general", HTMLElement> | null = null;
  private kbInputEl?: HTMLElement;
  private scopeDraft?: ScopeDraft;
  private scopeSaving = false;
  private scopeSaveFailed = false;
  private scopeFooter?: HTMLElement;
  private scopeStatus = "";
  private sourcePicker?: ScopePicker | IdentityPicker;
  private identityLoading = false;
  private identityMessage = "";
  private identityError = false;
  private identitySavesPending = 0;
  private identitySaveFailed = false;
  private identitySaveQueue: Promise<void> = Promise.resolve();

  private queueIdentitySave(): void {
    const values = scopeValues(this.getScopeDraft().values);
    this.identitySavesPending++; this.identitySaveFailed = false; this.scopeStatus = "";
    this.renderScopeFooter();
    this.identitySaveQueue = this.identitySaveQueue.then(async () => {
      try {
        await this.plugin.saveIdentityOptions(values);
        const draft = this.getScopeDraft();
        draft.original = scopeValues(values); draft.fingerprint = scopeFingerprint(this.plugin.settings);
        this.identitySaveFailed = false; this.scopeStatus = "已自动保存";
      } catch (error) {
        this.identitySaveFailed = true;
        this.scopeStatus = "未保存：" + (error instanceof Error ? error.message : String(error));
      } finally { this.identitySavesPending--; this.renderScopeFooter(); }
    });
  }

  async refreshIdentitySource(): Promise<void> {
    if (!this.plugin.identityProvider || this.identitySavesPending || this.sourcePicker || this.identityLoading) return;
    this.identityMessage = ""; this.identityError = false;
    const profile = activeProfile(this.plugin.settings);
    if (!profile) return;
    this.identityLoading = true;
    try {
      const choice = await this.plugin.resolveActiveIdentity();
      const next = refreshIdentityLabels(this.plugin.settings, choice);
      if (next.knowledgeBaseName !== this.plugin.settings.knowledgeBaseName || next.folderName !== this.plugin.settings.folderName ||
        JSON.stringify(sourcePath(next)) !== JSON.stringify(sourcePath(this.plugin.settings))) {
        await this.plugin.persistIdentitySettings(next);
        if (profile.knowledgeBaseName !== choice.knowledgeBase.name || JSON.stringify(profile.folderPath) !== JSON.stringify(choice.folder?.path.map(part => part.name) ?? []))
          this.identityMessage = "来源名称已更新，原保存位置和同步记录已保留。";
      }
      this.scopeDraft = createScopeDraft(this.plugin.settings);
    } catch (error) {
      this.identityError = true; this.identityMessage = this.plugin.currentSourceProblem || (error instanceof Error ? error.message : String(error));
    } finally {
      this.identityLoading = false;
    }
    if (this.panels) this.renderSettings();
  }

  private async chooseIdentity(mode: "knowledge-bases" | "folders" | "legacy"): Promise<void> {
    await this.identitySaveQueue;
    if (!this.plugin.identityProvider || this.identitySaveFailed) return;
    const settings = this.plugin.settings;
    const state = settings.sourceIdentity;
    const legacy = state?.legacy;
    const binding = legacy?.binding ?? settings.sourceBinding;
    const picker = new IdentityPicker(this.app, {
      provider: this.plugin.identityProvider, mode,
      identityProvider: this.plugin.identityProvider instanceof DesktopIdentityProvider ? "desktop-uia" : "ima-api",
      currentId: this.plugin.currentSourceProblem ? undefined : state?.activeKnowledgeBaseId, profiles: state?.profiles ?? {},
      startAtRoot: Boolean(this.plugin.currentSourceProblem),
      legacySourceIds: this.plugin.syncedAttachments.filter(item => !binding || item.sourceScope === binding.sourceScope).map(item => item.sourceId),
      legacyDescription: "原保存位置：" + (binding?.localDestination ?? settings.destinationPath),
      commit: async (choice, link, matched) => {
        await this.plugin.commitIdentityChoice(choice, link, matched);
        this.scopeDraft = createScopeDraft(this.plugin.settings); this.identityMessage = "";
        this.identityError = false; this.scopeStatus = "已自动保存"; this.renderSettings();
      },
      close: () => {
        this.sourcePicker = undefined; if (this.panels) this.renderSettings();
        const reminder = this.containerEl.querySelector<HTMLElement>(".ima-range-review");
        if (reminder) { reminder.scrollIntoView({ block: "nearest" }); reminder.focus(); } else this.kbInputEl?.focus();
      },
    });
    this.sourcePicker = picker; picker.open();
  }

  private locationChooser(root: HTMLElement, label: string, value: string, accessibleLabel: string, action: () => void) {
    const row = new Setting(root).setName(label);
    row.settingEl.addClass("ima-source-location-row");
    const b = row.controlEl.createEl("button", { cls: "ima-source-chooser",
      attr: { type: "button", "aria-label": accessibleLabel, "aria-haspopup": "dialog" } });
    b.createSpan({ cls: "ima-source-path-label", text: value }); setIcon(b.createSpan(), "chevron-down");
    b.disabled = this.scopeSaving;
    b.addEventListener("click", action);
    return { row, b };
  }

  private renderIdentitySource(root: HTMLElement): void {
    const values = this.getScopeDraft().values;
    const location = [values.knowledgeBaseName, ...(values.sourceTargetKind === "folder" ? sourcePath(values) : [])].filter(Boolean).join(" / ");
    const kb = this.locationChooser(root, "知识库与文件夹", location || "选择来源", "选择来源", () => { void this.chooseIdentity("knowledge-bases"); });
    this.kbInputEl = kb.b;
    const refresh = kb.row.infoEl.createEl("button", { cls: "ima-source-refresh", attr: { type: "button", "aria-label": "刷新来源" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => { void this.refreshIdentitySource(); });
    const problem = this.plugin.currentSourceProblem || (this.identityError ? this.identityMessage : "");
    if (problem || this.identityMessage) {
      const notice = root.createDiv({ cls: "ima-identity-inline" + (problem ? " is-error ima-source-problem" : ""),
        attr: { role: problem ? "alert" : "status" } });
      if (problem) setIcon(notice.createSpan({ attr: { "aria-hidden": "true" } }), "alert-triangle");
      notice.createSpan({ text: problem || this.identityMessage });
      if (problem) {
        notice.createEl("button", { text: "重新选择", attr: { type: "button" } })
          .addEventListener("click", () => { void this.chooseIdentity("knowledge-bases"); });
      } else {
        const dismiss = notice.createEl("button", { attr: { "aria-label": "关闭改名提示", type: "button" } });
        setIcon(dismiss, "x"); dismiss.addEventListener("click", () => { this.identityMessage = ""; notice.remove(); });
      }
    }
    if ((!activeProfile(this.plugin.settings) && values.knowledgeBaseName) || this.plugin.settings.sourceIdentity?.legacy) {
      const row = new Setting(root).setName("关联原同步记录").setDesc("确认一次原来源，以后改名会自动跟随。");
      row.addButton(button => button.setButtonText("关联原记录").onClick(() => { void this.chooseIdentity("legacy"); }));
    }

  }

  private getScopeDraft(): ScopeDraft {
    return this.scopeDraft ??= createScopeDraft(this.plugin.settings);
  }

  private scopeChanged(): void {
    this.scopeSaveFailed = false;
    this.updateFlowMap?.();
    if (this.plugin.identityProvider) { this.queueIdentitySave(); return; }
    this.scopeStatus = "";
    this.renderScopeFooter();
  }

  private renderScopeFooter(): void {
    const saveFailed = this.identitySaveFailed || this.scopeSaveFailed;
    this.flowModal?.setStatus(saveFailed ? this.scopeStatus || "保存失败，请重试。" : "");
    if (!this.scopeFooter) return;
    this.scopeFooter.empty();
    if (this.plugin.identityProvider) {
      // Keep the overview quiet after saving; failures still expose recovery actions.
      if (!this.identitySaveFailed) return;
      this.scopeFooter.createSpan({ text: this.identitySavesPending ? "正在保存…" : this.scopeStatus || "更改会自动保存",
        attr: { role: "status", "aria-live": "polite" } });
      if (this.identitySaveFailed && !this.identitySavesPending) {
        const retry = this.scopeFooter.createEl("button", { text: "重试", attr: { type: "button" } });
        retry.addEventListener("click", () => this.queueIdentitySave());
        const undo = this.scopeFooter.createEl("button", { text: "恢复已保存设置", attr: { type: "button" } });
        undo.addEventListener("click", () => { this.scopeDraft = createScopeDraft(this.plugin.settings);
          this.identitySaveFailed = false; this.scopeStatus = ""; this.renderSettings(); });
      }
      return;
    }
    const draft = this.getScopeDraft();
    const dirty = scopeDirty(draft);
    this.scopeFooter.createSpan({ text: this.scopeSaving ? "正在检查并保存…" : this.scopeStatus || (dirty ? "有未保存的更改" : "设置已保存"), attr: { role: "status", "aria-live": "polite" } });
    const actions = this.scopeFooter.createDiv();
    const undo = actions.createEl("button", { text: "撤销更改" });
    undo.disabled = !dirty || this.scopeSaving;
    undo.addEventListener("click", () => { this.scopeDraft = createScopeDraft(this.plugin.settings); this.scopeStatus = ""; this.scopeSaveFailed = false; this.renderSettings(); });
    const save = actions.createEl("button", { text: "保存设置", cls: "mod-cta" });
    save.disabled = !dirty || this.scopeSaving || !draft.values.knowledgeBaseName ||
      !draft.values.destinationPath.trim() || (draft.values.sourceTargetKind === "folder" && !draft.values.folderName);
    save.addEventListener("click", () => { void this.saveScope(); });
  }

  private async saveScope(): Promise<void> {
    if (this.scopeSaving) return;
    this.scopeSaveFailed = false;
    this.scopeSaving = true; this.renderSettings();
    try {
      await this.plugin.saveScopeDraft(this.getScopeDraft());
      this.scopeDraft = createScopeDraft(this.plugin.settings);
      this.scopeStatus = "设置已保存";
    } catch (error) { this.scopeSaveFailed = true; this.scopeStatus = error instanceof Error ? error.message : String(error); }
    finally { this.scopeSaving = false; if (this.panels) this.renderSettings(); }
  }

  private chooseScope(kind: "knowledge-bases" | "folders" | "destination"): void {
    if (this.scopeSaving) return;
    if (this.plugin.identityProvider && kind !== "destination") { void this.chooseIdentity(kind); return; }
    const draft = this.getScopeDraft();
    const values = draft.values;
    let session: SourceRebindSession | undefined;
    try {
      if (kind !== "destination") session = this.plugin.beginScopeSelection(values);
      const picker = new ScopePicker(this.app, {
        title: kind === "knowledge-bases" ? "选择知识库" : kind === "folders" ? "选择源文件夹" : "选择保存位置",
        selected: kind === "knowledge-bases" ? [values.knowledgeBaseName] : kind === "folders" ? sourcePath(values) : [values.destinationPath],
        browse: kind === "folders", rename: kind !== "destination" && !!draft.original.knowledgeBaseName,
        editablePath: kind === "destination",
        preserveIdentity: draft.preserveIdentity,
        load: async parent => {
          if (kind === "destination") return { names: this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder && !!file.path && file.path !== "/" &&
              file.path !== this.app.vault.configDir && !file.path.startsWith(`${this.app.vault.configDir}/`))
            .map(file => file.path).sort(), complete: true };
          return await this.plugin.readSourceCatalog(session!, kind, parent);
        },
        choose: (parts, rename) => {
          if (kind === "knowledge-bases" && values.knowledgeBaseName !== parts[0]) {
            values.knowledgeBaseName = parts[0]!; values.folderName = "";
            delete values.sourceFolderPath; values.sourceTargetKind = "knowledge-base";
          } else if (kind === "folders") {
            values.folderName = parts[parts.length - 1]!; values.sourceFolderPath = parts;
            values.sourceTargetKind = "folder";
          } else if (kind === "destination") values.destinationPath = parts[0]!;
          if (kind !== "destination") draft.preserveIdentity = rename;
          this.scopeChanged(); this.renderSettings();
        },
        cancel: () => { if (session) this.plugin.cancelSourceRebind(session); this.sourcePicker = undefined; },
      });
      this.sourcePicker = picker; picker.open();
    } catch (error) { if (session) this.plugin.cancelSourceRebind(session); new Notice(error instanceof Error ? error.message : String(error)); }
  }

  private renderScopeSource(root: HTMLElement): void {
    if (this.plugin.identityProvider) { this.renderIdentitySource(root); return; }
    const values = this.getScopeDraft().values;
    const chooser = (name: string, value: string, action: () => void): HTMLButtonElement => {
      const row = new Setting(root).setName(name);
      const button = row.controlEl.createEl("button", { cls: "ima-source-chooser", attr: { "aria-label": `选择${name}`, "aria-haspopup": "dialog" } });
      button.createSpan({ text: value });
      const arrow = button.createSpan(); setIcon(arrow, "chevron-down");
      button.disabled = this.scopeSaving; button.addEventListener("click", action);
      return button;
    };
    this.kbInputEl = chooser("知识库", values.knowledgeBaseName || "选择知识库", () => this.chooseScope("knowledge-bases"));
    const range = new Setting(root).setName("同步范围");
    this.segmented(range.controlEl, "同步范围", [["knowledge-base", "整个知识库"], ["folder", "指定文件夹"]], values.sourceTargetKind, value => {
      values.sourceTargetKind = value as SourceTargetKind;
      this.scopeChanged(); this.renderSettings();
    });
    if (values.sourceTargetKind === "folder") {
      chooser("源文件夹", sourcePath(values).join(" / ") || "选择文件夹", () => this.chooseScope("folders"));
      if (this.plugin.sourceNeedsRebind) root.createDiv({ text: getStrings().sourceRebindNeeded, cls: "setting-item-description" });
    }
  }

  private segmented(root: HTMLElement, label: string, options: [string, string][], value: string, change: (value: string) => void): void {
    const group = root.createDiv({ cls: "ima-scope-segmented", attr: { role: "group", "aria-label": label } });
    for (const [key, name] of options) {
      const button = group.createEl("button", { text: name, attr: { "aria-pressed": String(value === key) } });
      button.disabled = this.scopeSaving;
      button.addEventListener("click", () => {
        for (const child of Array.from(group.children)) child.setAttribute("aria-pressed", String(child === button));
        change(key);
      });
    }
  }
  private mdDashboardEl?: HTMLElement;
  private mdStatusTextEl?: HTMLElement;
  private mdProgressSectionEl?: HTMLElement;
  private mdProgressBarEl?: HTMLElement;
  private mdProgressTextEl?: HTMLElement;
  private mdCurrentTitleEl?: HTMLElement;
  private mdKpiConvertedEl?: HTMLElement;
  private mdKpiSkippedEl?: HTMLElement;
  private mdKpiFailedEl?: HTMLElement;
  private mdLastTimeEl?: HTMLElement;
  private mdScanBtnEl?: HTMLButtonElement;

  constructor(
    app: Plugin["app"],
    private readonly plugin: ImaSpeedSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.renderRoot = undefined;
    this.renderSettings();
    if (this.plugin.identityProvider) void this.refreshIdentitySource();
  }

  switchTab(tabId: "stats" | "scope" | "markdown" | "notifications" | "general", focusKb = false): void {
    this.activeTabId = tabId;
    if (tabId === "stats") this.refreshDashboard();
    this.tabButtons.forEach((b, id) => b.toggleClass("is-active", id === tabId));
    if (this.panels) {
      Object.entries(this.panels).forEach(([id, p]) => p.toggleClass("is-hidden", id !== tabId));
    }
    if (focusKb && tabId === "scope" && this.kbInputEl) {
      window.setTimeout(() => {
        this.kbInputEl?.focus();
      }, 60);
    }
  }

  refreshDashboard(): void {
    if (!this.panels || this.activeTabId !== "stats") return;
    this.panels.stats.empty();
    this.renderDashboard(this.panels.stats);
  }

  refreshSourceSettings(): void {
    if (this.panels) this.renderSettings();
  }

  sourceHealthChanged(): void {
    this.identityMessage = this.plugin.currentSourceProblem;
    this.identityError = Boolean(this.identityMessage);
    if (this.panels && !this.sourcePicker) this.renderSettings();
  }

  override hide(): void {
    this.sourcePicker?.close();
    this.flowModal?.close();
    if (!this.scopeSaving) this.scopeDraft = undefined;
    this.scopeFooter = undefined;
    this.panels = null;
    this.tabButtons.clear();
    this.kbInputEl = undefined;
  }

  private renderGeneralScope(containerEl: HTMLElement, sourceControls: HTMLElement, saveControls: HTMLElement, sourceAdvanced: HTMLElement, syncAdvanced: HTMLElement, notices: HTMLElement): void {
    const s = getStrings(this.plugin.settings.language);
    const settings = this.getScopeDraft().values;
    const legacy = settings.generalSelectionMode === "per-folder";
    const currentMode = settings.syncScopeMode ?? "recent";
    let folderControl: { setDisabled(value: boolean): unknown } | undefined;
    let depthControl: { setDisabled(value: boolean): unknown; setValue(value: string): unknown } | undefined;
    let scopeDetails: HTMLElement | undefined;
    
    let maxFoldersSetting: Setting | undefined;
    if (legacy) {
      new Setting(containerEl)
        .setName("正在沿用旧版数量规则")
        .setDesc(`原设置未改变：每个文件夹最多 ${settings.maxItems} 个。切换后改为每次合计最多 ${settings.maxItems} 个，文件夹范围不变。`)
        .addButton((button) => button.setButtonText(`改为每次共 ${settings.maxItems} 个`).onClick(async () => {
          settings.generalSelectionMode = "total";
          this.scopeChanged();
          this.renderSettings();
          this.quantitySelect?.focus();
        }));
    }

    if (this.plugin.identityProvider && this.plugin.settings.sourceIdentity?.rangeReviewRequired) {
      const warning = notices.createDiv({ cls: "ima-identity-alert ima-range-review", attr: { role: "alert", tabindex: "-1" } });
      warning.createEl("strong", { text: "来源已更换，请确认下面的同步范围。" });
      warning.createEl("p", { text: "原文件和记录已保留。确认后关闭此提示，才能开始同步。" });
      const ack = warning.createEl("button", { cls: "ima-identity-alert-close", attr: { type: "button", "aria-label": "关闭并确认同步范围" } });
      setIcon(ack, "x");
      ack.addEventListener("click", () => {
        ack.disabled = true;
        void this.identitySaveQueue.then(async () => {
          if (this.identitySaveFailed) throw new Error("范围尚未保存，请先重试保存。");
          await this.plugin.persistIdentitySettings(acknowledgeIdentityRange(this.plugin.settings));
          this.scopeStatus = "已自动保存"; this.renderSettings();
        }).catch(error => { ack.disabled = false; new Notice(error instanceof Error ? error.message : String(error)); });
      });
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
    const recentArrow = recentSummaryRow.createSpan({ cls: "ima-card-arrow" });
    setIcon(recentArrow, "chevron-down");

    // 级联下沉面板（与右卡片天然等宽，绝对定位悬浮层）
    const cascadePanel = colRight.createDiv({ cls: "ima-cascade-popover-panel is-hidden" });

    const togglePanel = quantityPopover(cascadePanel, cardRecent, recentArrow);
    for (const card of [cardAll, cardRecent]) {
      card.setAttribute("role", "button"); card.tabIndex = 0;
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); card.click(); }
      });
    }
    cardRecent.setAttribute("aria-expanded", "false");

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
      this.scopeChanged();
    };

    presets.forEach((preset) => {
      const isSelected = settings.maxItems === preset;
      const row = itemsList.createEl("button", { cls: `ima-cascade-option-row${isSelected ? " is-active" : ""}`, attr: { type: "button" } });
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
      this.scopeChanged();
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
      const folder = settings.sourceTargetKind === "knowledge-base" ? s.sourceRangeKnowledgeBase : settings.folderName || s.sourceRangeFolder;
      const folderNameDesc = settings.folderName ? settings.folderName : "";
      try {
        sourceFolderSetting?.setDesc(`${s.sourceRebindDestination}: ${this.plugin.previewScopeDestination(this.getScopeDraft())}`);
      } catch { sourceFolderSetting?.setDesc(settings.includeSourceFolder ? s.includeFolderDescTrue(folderNameDesc) : s.includeFolderDescFalse); }
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
      this.updateFlowMap?.();

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

    const sourceFolderSetting = new Setting(saveControls)
      .setName(s.includeFolderOption)
      .addToggle((toggle) => toggle.setValue(settings.includeSourceFolder).onChange(async (value) => {
        settings.includeSourceFolder = value;
        
        updateSummary();
        this.scopeChanged();
      }));

    const childRow = new Setting(sourceControls).setName("同步范围");
    childRow.settingEl.addClass("ima-child-range");
    if (this.plugin.identityProvider && !activeProfile(this.plugin.settings)) childRow.settingEl.addClass("ima-hidden-setting");
    this.segmented(childRow.controlEl, "子文件夹范围", [["false", settings.sourceTargetKind === "knowledge-base" ? "仅知识库本层" : "仅当前文件夹"], ["true", "包含子文件夹"]], String(settings.includeSubfolders), value => {
      settings.includeSubfolders = value === "true";
      if (settings.includeSubfolders && settings.maxFolderDepth === 0) settings.maxFolderDepth = 1;
      if (!settings.includeSubfolders && legacy) settings.maxFolderDepth = 0;
      depthControl?.setDisabled(!settings.includeSubfolders);
      depthControl?.setValue(String(settings.maxFolderDepth || 1));
      updateSummary(); this.scopeChanged();
    });
    updateSummary();

    const content = sourceAdvanced;
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
          this.scopeChanged();
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
          this.scopeChanged();
        });
      });
    const sortSetting = new Setting(syncAdvanced)
      .setName(s.sortSettingName)
      .setDesc(s.sortSettingDesc);
    if (sortSetting.settingEl) sortSetting.settingEl.toggleClass("ima-advanced-info-item", true);
    new Setting(syncAdvanced)
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
          this.scopeChanged();
          this.renderSettings();
        }));
    if (settings.titleFilterMode !== "all") {
      new Setting(syncAdvanced).setName(s.filterContentName).setDesc(s.filterContentDesc)
        .addText((text) => text.setValue(settings.titleFilter).onChange(async (value) => {
          settings.titleFilter = value;
          this.scopeChanged();
        }));
    }
  }

  openFlowSettings(group: FlowGroup): void {
    if (!this.flowPanels) return;
    this.flowModal?.close();
    const modal = new FlowSettingsModal(this.app, group, this.flowPanels, () => {
      this.flowModal = undefined;
      this.updateFlowMap?.();
    });
    this.flowModal = modal; modal.open(); this.renderScopeFooter();
    if (group === "source") void this.refreshIdentitySource();
  }

  private createScopeSection(parent: HTMLElement, title: string, kind: "source" | "sync" | "save"): HTMLElement {
    const section = parent.createDiv({ cls: "ima-scope-section", attr: { role: "group", "aria-label": title, "data-scope-group": kind } });
    new Setting(section).setName(title).setHeading().settingEl.toggleClass("ima-scope-section-title", true);
    return section.createDiv({ cls: kind === "sync" ? "ima-scope-sync-controls" : "ima-scope-card" });
  }

  private renderSettings(): void {
    // A clean page follows changes made by other settings or the existing rebind dialog.
    // An edited page keeps its draft; Save checks the original snapshot before writing.
    if (this.scopeDraft && !scopeDirty(this.scopeDraft) && scopeFingerprint(this.plugin.settings) !== this.scopeDraft.fingerprint) {
      this.scopeDraft = createScopeDraft(this.plugin.settings);
    }
    const s = getStrings(this.plugin.settings.language);
    const containerEl = this.renderRoot ?? this.containerEl;
    containerEl.empty();
    containerEl.addClass("ima-flow-ui"); containerEl.addClass("ima-palette-9");
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
    const panelStats = containerEl.createDiv({
      cls: `ima-settings-tab-content${this.activeTabId === "stats" ? "" : " is-hidden"}`,
      attr: { "data-tab-content": "stats" },
    });
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

    this.panels = {
      stats: panelStats,
      scope: panelScope,
      markdown: panelMarkdown,
      notifications: panelNotifications,
      general: panelGeneral,
    };

    this.tabButtons.clear();
    const tabConfigs: { id: "stats" | "scope" | "markdown" | "notifications" | "general"; label: string; icon: string }[] = [
      { id: "stats", label: s.tabStats, icon: "bar-chart-2" },
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
        this.switchTab(tab.id);
      });
      this.tabButtons.set(tab.id, btn);
    }

    this.renderDashboard(panelStats);

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

    const isScopeConfigured = Boolean(
      this.plugin.settings.knowledgeBaseName.trim() && (this.plugin.settings.sourceTargetKind === "knowledge-base" || this.plugin.settings.folderName.trim()),
    );
    if (!isScopeConfigured) {
      const scopeTip = panelScope.createDiv({ cls: "ima-scope-empty-tip" });
      const tipIcon = scopeTip.createSpan({ cls: "ima-scope-tip-icon" });
      setIcon(tipIcon, "info");
      scopeTip.createSpan({ text: this.plugin.identityProvider ? "先选择来源，再设置同步范围和保存位置。" : s.scopeEmptyTip });
    }

    this.updateFlowMap = drawFlowMap(panelScope, () => {
      const values = this.getScopeDraft().values;
      const parts = [values.knowledgeBaseName, ...sourcePath(values)].filter(Boolean);
      let destination = values.destinationPath;
      try { destination = this.plugin.previewScopeDestination(this.getScopeDraft()); } catch { /* Editable draft may be incomplete. */ }
      return { sourceTitle: parts.at(-1) || "选择来源", sourcePath: parts.slice(0, -1).join(" / ") || "IMA 知识库",
        sourceWarning: this.plugin.currentSourceProblem || (this.identityError ? this.identityMessage : ""),
        syncTitle: (values.syncScopeMode ?? "recent") === "all" ? "全部同步" : "仅同步新增",
        syncDetail: (values.syncScopeMode ?? "recent") === "all" ? "补齐范围内未同步的文件" : "检查最新 " + values.maxItems + " 个，跳过已同步",
        saveTitle: destination.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "选择位置",
        savePath: "Obsidian · " + destination.replace(/\\/g, "/") };
    }, group => this.openFlowSettings(group));
    const staging = panelScope.createDiv({ cls: "ima-flow-staging", attr: { hidden: "" } });
    const sourceControls = this.createScopeSection(staging, s.sourceSection, "source");
    const syncControls = this.createScopeSection(staging, s.syncSection, "sync");
    const saveControls = this.createScopeSection(staging, s.saveSection, "save");
    const sourceAdvanced = staging.createDiv({ cls: "ima-flow-advanced" });
    const syncAdvanced = staging.createDiv({ cls: "ima-flow-advanced" });
    const saveAdvanced = staging.createDiv({ cls: "ima-flow-advanced" });
    this.flowPanels = { source: { basic: sourceControls, advanced: sourceAdvanced },
      sync: { basic: syncControls, advanced: syncAdvanced }, save: { basic: saveControls, advanced: saveAdvanced } };
    const scopeValues = this.getScopeDraft().values;
    this.renderScopeSource(sourceControls);

    if (this.plugin.settings.pendingSourceResume) {
      let description = s.sourceResumeInvalid;
      try {
        const pending = this.plugin.getPendingSourceResume();
        if (pending) description = s.sourceResumeDesc(pending.records.length, pending.unresumableCount);
      } catch { /* Keep the invalid-batch explanation visible until explicitly discarded. */ }
      new Setting(syncControls).setName(s.sourceResume).setDesc(description)
        .addButton((button) => button.setButtonText(s.sourceResume).setDisabled(this.plugin.isRunning)
          .onClick(() => { void this.plugin.sync(true); }))
        .addButton((button) => button.setButtonText(s.sourceResumeDiscard).setDisabled(this.plugin.isRunning)
          .onClick(async () => {
            try { await this.plugin.discardPendingSourceResume(); }
            catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
          }));
    }

    this.locationChooser(saveControls, s.destPathName, scopeValues.destinationPath || s.destPathPlaceholder,
      "选择保存位置", () => this.chooseScope("destination"));
    new Setting(saveAdvanced).setName(s.overwriteName).setDesc(s.overwriteDesc)
      .addToggle(toggle => toggle.setValue(scopeValues.overwriteSameName).setDisabled(this.scopeSaving).onChange(value => {
        scopeValues.overwriteSameName = value; this.scopeChanged();
      }));
    if (this.plugin.settings.contentMode === "general") {
      this.renderGeneralScope(syncControls, sourceControls, saveAdvanced, sourceAdvanced, syncAdvanced, panelScope);
    } else {
      new Setting(syncControls).setName(s.maxItemsName).setDesc(s.maxItemsDesc)
        .addSlider(slider => slider.setLimits(1, 30, 1).setValue(scopeValues.maxItems).setDisabled(this.scopeSaving)
          .onChange(value => { scopeValues.maxItems = value; this.scopeChanged(); }));
    }
    // Keep the original sync cards/popover. The fieldset locks all settings while committing.
    panelScope.toggleClass("ima-scope-saving", this.scopeSaving);
    for (const section of Array.from(panelScope.querySelectorAll(".ima-scope-section"))) {
      if (this.scopeSaving) section.setAttribute("inert", ""); else section.removeAttribute("inert");
    }
    this.scopeFooter = panelScope.createDiv({ cls: "ima-scope-footer" });
    this.flowModal?.replacePanels(this.flowPanels);
    this.renderScopeFooter();

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
          if (!value) {
            this.plugin.cancelMarkdownConversion();
          }
          await this.plugin.saveSettings();
          this.renderSettings();
        }),
      );

    if (this.plugin.settings.enableMarkdownConversion) {
      renderOcrSettings(panelMarkdown, this.plugin, () => this.updateMarkdownDashboard());
      this.renderMarkdownDashboard(panelMarkdown);

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
          button
            .setButtonText(s.manualScanBtn)
            .onClick(() => {
              void this.plugin.convertAllVaultPdfFiles(true);
            }),
        );
    }

    containerEl.createDiv({
      cls: "ima-share-sync-settings-version",
      text: s.versionText(this.plugin.manifest.version),
    });
    silenceHoverHints(containerEl);
  }

  updateMarkdownDashboard(): void {
    if (!this.mdDashboardEl || !this.mdDashboardEl.isConnected) return;
    const s = getStrings(this.plugin.settings.language);
    const state = this.plugin.markdownDashboardState;
    const converting = state.status === "converting";

    if (this.mdStatusTextEl) {
      const badge = this.mdStatusTextEl.parentElement;
      const issue = state.status === "failed" || (state.status === "completed" && (state.failed > 0 || !!state.deferred));
      if (badge) {
        badge.className = `ima-md-status-badge is-${issue ? "issue" : state.status}`;
      }
      let statusText = s.mdStatusIdle;
      switch (state.status) {
        case "converting": statusText = s.mdStatusConverting; break;
        case "completed": statusText = s.mdStatusCompleted(state.failed, state.deferred ?? 0); break;
        case "canceled": statusText = s.mdStatusCanceled; break;
        case "failed": statusText = s.mdStatusFailed; break;
      }
      this.mdStatusTextEl.textContent = statusText;
    }

    if (this.mdProgressSectionEl) {
      this.mdProgressSectionEl.style.display = converting ? "block" : "none";

      const pct = converting && state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
      if (this.mdProgressBarEl) {
        this.mdProgressBarEl.style.width = `${pct}%`;
      }
      if (this.mdProgressTextEl) {
        this.mdProgressTextEl.textContent = converting ? s.mdProgressText(state.current, state.total, pct) : "";
      }
      if (this.mdCurrentTitleEl) {
        this.mdCurrentTitleEl.style.display = converting && state.currentTitle ? "block" : "none";
        this.mdCurrentTitleEl.textContent = converting ? state.currentTitle ?? "" : "";
      }
    }

    if (this.mdKpiConvertedEl) {
      this.mdKpiConvertedEl.textContent = String(state.completed);
    }
    if (this.mdKpiSkippedEl) {
      this.mdKpiSkippedEl.textContent = String(state.skipped);
    }
    if (this.mdKpiFailedEl) {
      this.mdKpiFailedEl.textContent = String(state.failed);
      this.mdKpiFailedEl.className = `ima-md-kpi-val${state.failed > 0 ? " is-failed" : ""}`;
    }

    if (this.mdLastTimeEl) {
      this.mdLastTimeEl.textContent = state.lastFinishedAt
        ? s.mdLastConverted(new Date(state.lastFinishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }))
        : s.mdNeverConverted;
    }

    if (this.mdScanBtnEl) {
      const pending = this.plugin.pendingOcrCount;
      this.mdScanBtnEl.disabled = !converting && (!this.plugin.settings.imageOcrEnabled || pending === 0);
      this.mdScanBtnEl.textContent = converting ? s.mdStopConversion : s.mdProcessPending(pending);
    }
  }

  private renderMarkdownDashboard(containerEl: HTMLElement): void {
    const s = getStrings(this.plugin.settings.language);
    const card = containerEl.createDiv({ cls: "ima-md-dashboard-card" });
    this.mdDashboardEl = card;

    const header = card.createDiv({ cls: "ima-md-card-header" });
    header.createDiv({ cls: "ima-md-card-title", text: s.mdStatusHeading });
    const badge = header.createDiv({ cls: "ima-md-status-badge is-idle" });
    badge.createSpan({ cls: "ima-md-status-dot" });
    this.mdStatusTextEl = badge.createSpan({ text: s.mdStatusIdle, attr: { role: "status" } });

    this.mdProgressSectionEl = card.createDiv({ cls: "ima-md-progress-section" });
    const meta = this.mdProgressSectionEl.createDiv({ cls: "ima-md-progress-meta" });
    this.mdProgressTextEl = meta.createSpan({ text: "" });
    const track = this.mdProgressSectionEl.createDiv({ cls: "ima-md-progress-track" });
    this.mdProgressBarEl = track.createDiv({ cls: "ima-md-progress-bar" });
    this.mdCurrentTitleEl = this.mdProgressSectionEl.createDiv({ cls: "ima-md-current-title" });

    const kpiGrid = card.createDiv({ cls: "ima-md-kpi-grid" });

    const itemConverted = kpiGrid.createDiv({ cls: "ima-md-kpi-item" });
    this.mdKpiConvertedEl = itemConverted.createDiv({ cls: "ima-md-kpi-val", text: "0" });
    itemConverted.createDiv({ cls: "ima-md-kpi-lbl", text: s.mdKpiConverted });

    const itemSkipped = kpiGrid.createDiv({ cls: "ima-md-kpi-item" });
    this.mdKpiSkippedEl = itemSkipped.createDiv({ cls: "ima-md-kpi-val", text: "0" });
    itemSkipped.createDiv({ cls: "ima-md-kpi-lbl", text: s.mdKpiSkipped });

    const itemFailed = kpiGrid.createDiv({ cls: "ima-md-kpi-item" });
    this.mdKpiFailedEl = itemFailed.createDiv({ cls: "ima-md-kpi-val", text: "0" });
    itemFailed.createDiv({ cls: "ima-md-kpi-lbl", text: s.mdKpiFailed });

    const footer = card.createDiv({ cls: "ima-md-card-footer" });
    this.mdLastTimeEl = footer.createDiv({ cls: "ima-md-last-time", text: s.mdNeverConverted });

    this.mdScanBtnEl = footer.createEl("button", {
      cls: "mod-cta ima-md-scan-btn",
      text: s.mdProcessPending(this.plugin.pendingOcrCount),
      attr: { type: "button" },
    });
    this.mdScanBtnEl.addEventListener("click", () => {
      if (this.plugin.markdownDashboardState.status === "converting") this.plugin.cancelMarkdownConversion();
      else void this.plugin.retryPendingMarkdown();
    });

    this.updateMarkdownDashboard();
  }

  private renderDashboard(containerEl: HTMLElement): void {
    const s = getStrings(this.plugin.settings.language);
    const settings = this.plugin.settings;
    let destination = "";
    try { destination = this.plugin.getEffectiveDestinationPath(settings); }
    catch { /* Invalid/incomplete settings have no local scope yet. */ }
    const reports = this.plugin.syncReports;
    const stats = calculateDashboardStats(this.app.vault.getFiles(), reports, destination);
    const mdCount = stats.markdown;
    const totalScanned = stats.checked;
    const totalSynced = stats.files;
    const totalRuns = reports.length;
    const dateMap = stats.dateMap;
    const displayStreak = stats.streak;
    const today = new Date();
    const savedHours = (stats.saved * 10 / 60).toFixed(1);
    const savedDays = (Number(savedHours) / 8).toFixed(1);
    const mbSize = (stats.bytes / 1024 / 1024).toFixed(1);
    const autoRate = stats.successRate;

    const isConfigured = Boolean(settings.knowledgeBaseName.trim() && (settings.sourceTargetKind === "knowledge-base" || settings.folderName.trim()));
    const isNeverSynced = totalRuns === 0 && totalSynced === 0;

    // 2. DOM 渲染
    const dashWrapper = containerEl.createDiv({ cls: "ima-dashboard-container" });

    // 醒目空状态引导横幅 (Onboarding Empty State)
    if (!isConfigured) {
      const emptyBanner = dashWrapper.createDiv({ cls: "ima-dash-empty-banner ima-empty-unconfigured" });
      const left = emptyBanner.createDiv({ cls: "ima-empty-left" });
      const iconWrap = left.createDiv({ cls: "ima-empty-icon" });
      setIcon(iconWrap, "sparkles");
      const textWrap = left.createDiv({ cls: "ima-empty-text" });
      textWrap.createDiv({ cls: "ima-empty-title", text: s.dashEmptyUnconfiguredTitle });
      textWrap.createDiv({ cls: "ima-empty-desc", text: s.dashEmptyUnconfiguredDesc });
      const btn = emptyBanner.createEl("button", {
        cls: "ima-empty-btn",
        text: s.dashEmptyUnconfiguredBtn,
        attr: { type: "button" },
      });
      btn.addEventListener("click", () => {
        this.switchTab("scope", true);
      });
    } else if (isNeverSynced) {
      const emptyBanner = dashWrapper.createDiv({ cls: "ima-dash-empty-banner ima-empty-ready" });
      const left = emptyBanner.createDiv({ cls: "ima-empty-left" });
      const iconWrap = left.createDiv({ cls: "ima-empty-icon" });
      setIcon(iconWrap, "zap");
      const textWrap = left.createDiv({ cls: "ima-empty-text" });
      textWrap.createDiv({ cls: "ima-empty-title", text: s.dashEmptyNeverSyncedTitle });
      textWrap.createDiv({ cls: "ima-empty-desc", text: s.dashEmptyNeverSyncedDesc });
      const btn = emptyBanner.createEl("button", {
        cls: "ima-empty-btn",
        text: s.dashEmptyNeverSyncedBtn,
        attr: { type: "button" },
      });
      btn.addEventListener("click", () => {
        void this.plugin.sync(true);
      });
    }

    // 2.1 顶部 Profile
    const profile = dashWrapper.createDiv({ cls: "ima-dash-profile" });
    const avatar = profile.createDiv({ cls: "ima-dash-avatar" });
    setIcon(avatar, IMA_SHARE_SYNC_ICON_ID);
    profile.createDiv({
      cls: "ima-dash-title",
      text: "IMA Share Sync",
    });
    const subTitle = profile.createDiv({ cls: "ima-dash-subtitle" });
    subTitle.createSpan({ cls: `ima-dash-status-dot${isNeverSynced ? " is-idle" : ""}` });
    subTitle.createSpan({
      text: isNeverSynced ? s.dashProfileNeverSynced : s.dashProfileSubtitle(totalSynced, savedHours),
    });

    // 2.2 核心 5 列 KPI 胶囊横条
    const kpiStrip = dashWrapper.createDiv({ cls: "ima-kpi-strip" });
    const kpis = [
      { val: `${totalScanned}`, label: s.dashKpiScanned },
      { val: `${totalSynced}`, label: s.dashKpiSynced },
      { val: `${mdCount}`, label: s.dashKpiToMd },
      { val: `~${savedHours} h`, label: s.dashKpiSavedHours },
      { val: `${displayStreak}`, label: s.dashKpiStreak },
    ];
    for (const item of kpis) {
      const col = kpiStrip.createDiv({ cls: "ima-kpi-col" });
      col.createDiv({ cls: "ima-kpi-val", text: item.val });
      col.createDiv({ cls: "ima-kpi-label", text: item.label });
    }

    // 2.3 核心价值回报三大卡片
    const valHeader = dashWrapper.createDiv({ cls: "ima-dash-section-header" });
    const valTitle = valHeader.createDiv({ cls: "ima-dash-section-title" });
    setIcon(valTitle.createSpan(), "award");
    valTitle.createSpan({ text: s.dashSecValue });
    valHeader.createDiv({ cls: "ima-dash-section-tip", text: s.dashValFormula });

    const valGrid = dashWrapper.createDiv({ cls: "ima-val-grid" });

    // 卡片 1：挽回工作时间
    const card1 = valGrid.createDiv({ cls: "ima-val-card ima-card-amber" });
    const c1Head = card1.createDiv({ cls: "ima-val-card-header" });
    c1Head.createSpan({ cls: "ima-val-icon", text: "⏱" });
    c1Head.createSpan({ cls: "ima-val-tag-text", text: s.dashCard1Title });
    const c1Hero = card1.createDiv({ cls: "ima-val-hero" });
    c1Hero.createSpan({ cls: "ima-val-num", text: savedHours });
    c1Hero.createSpan({ cls: "ima-val-unit", text: s.dashUnitHours });
    card1.createDiv({ cls: "ima-val-badge", text: s.dashCard1Sub(savedDays) });
    card1.createDiv({ cls: "ima-val-desc", text: s.dashCard1Desc });

    // 卡片 2：构筑知识资产
    const card2 = valGrid.createDiv({ cls: "ima-val-card ima-card-green" });
    const c2Head = card2.createDiv({ cls: "ima-val-card-header" });
    c2Head.createSpan({ cls: "ima-val-icon", text: "📚" });
    c2Head.createSpan({ cls: "ima-val-tag-text", text: s.dashCard2Title });
    const c2Hero = card2.createDiv({ cls: "ima-val-hero" });
    c2Hero.createSpan({ cls: "ima-val-num", text: mbSize });
    c2Hero.createSpan({ cls: "ima-val-unit", text: "MB" });
    card2.createDiv({ cls: "ima-val-badge", text: s.dashCard2Sub(String(totalSynced)) });
    card2.createDiv({ cls: "ima-val-desc", text: s.dashCard2Desc });

    // 卡片 3：心智负担释放
    const card3 = valGrid.createDiv({ cls: "ima-val-card ima-card-blue" });
    const c3Head = card3.createDiv({ cls: "ima-val-card-header" });
    c3Head.createSpan({ cls: "ima-val-icon", text: "🧠" });
    c3Head.createSpan({ cls: "ima-val-tag-text", text: s.dashCard3Title });
    const c3Hero = card3.createDiv({ cls: "ima-val-hero" });
    c3Hero.createSpan({ cls: "ima-val-num", text: autoRate === null ? "—" : `${autoRate}%` });
    c3Hero.createSpan({ cls: "ima-val-unit", text: s.dashUnitAutoRate });
    card3.createDiv({ cls: "ima-val-badge", text: s.dashCard3Sub(displayStreak) });
    card3.createDiv({ cls: "ima-val-desc", text: s.dashCard3Desc });

    // 2.4 同步活动热力图
    const actHeader = dashWrapper.createDiv({ cls: "ima-dash-section-header" });
    const actTitle = actHeader.createDiv({ cls: "ima-dash-section-title" });
    setIcon(actTitle.createSpan(), "activity");
    actTitle.createSpan({ text: s.dashSecActivity });

    const filterRow = actHeader.createDiv({ cls: "ima-dash-filter-row" });
    const btnDay = filterRow.createEl("button", { cls: "ima-dash-pill is-active", text: s.dashFilterDay });
    const btnWeek = filterRow.createEl("button", { cls: "ima-dash-pill", text: s.dashFilterWeek });
    const btnTotal = filterRow.createEl("button", { cls: "ima-dash-pill", text: s.dashFilterTotal });

    // 立即检查同步按钮
    const btnSyncNow = filterRow.createEl("button", { cls: "ima-dash-pill ima-pill-sync", attr: { type: "button" } });
    setIcon(btnSyncNow.createSpan(), "refresh-cw");
    btnSyncNow.createSpan({ text: s.dashBtnCheckSync });
    btnSyncNow.addEventListener("click", () => {
      void this.plugin.sync(true);
    });

    const heatCard = dashWrapper.createDiv({ cls: "ima-heat-card" });
    const heatBody = heatCard.createDiv({ cls: "ima-heat-body" });
    const heatLeft = heatBody.createDiv({ cls: "ima-heat-left" });
    const heatWrapper = heatLeft.createDiv({ cls: "ima-heat-wrapper" });
    const heatGrid = heatWrapper.createDiv({ cls: "ima-heat-grid" });
    const monthsRow = heatWrapper.createDiv({ cls: "ima-heat-months" });
    const insightsPanel = heatBody.createDiv({ cls: "ima-heat-insights" });

    const heatFooter = heatCard.createDiv({ cls: "ima-heat-footer" });
    const summarySpan = heatFooter.createSpan({ cls: "ima-heat-summary" });

    const legend = heatFooter.createDiv({ cls: "ima-heat-legend" });
    legend.createSpan({ text: s.dashLegendLess });
    for (let lv = 0; lv <= 5; lv++) {
      legend.createDiv({ cls: `ima-legend-dot ima-heat-lv-${lv}` });
    }
    legend.createSpan({ text: s.dashLegendMore });

    const renderHeatmap = (weeks: number) => {
      heatGrid.empty();
      monthsRow.empty();
      insightsPanel.empty();

      const totalDays = weeks * 7;
      let periodRuns = 0;
      let maxDayStr = "";
      let maxDayCount = 0;
      const monthNames: string[] = [];
      let lastMonth = -1;

      for (let i = 0; i < totalDays; i++) {
        const daysAgo = totalDays - 1 - i;
        const d = new Date(today);
        d.setDate(today.getDate() - daysAgo);
        const dStr = localDateKey(d);
        const count = (dStr ? dateMap[dStr] : 0) ?? 0;
        if (count > 0) {
          periodRuns += count;
          if (count > maxDayCount) {
            maxDayCount = count;
            maxDayStr = dStr;
          }
        }

        const currentMonth = d.getMonth() + 1;
        if (currentMonth !== lastMonth) {
          lastMonth = currentMonth;
          monthNames.push(s.dashMonth(currentMonth));
        }

        let level = 0;
        if (count > 0) {
          if (count === 1) level = 1;
          else if (count <= 2) level = 2;
          else if (count <= 4) level = 3;
          else if (count <= 7) level = 4;
          else level = 5;
        }
        const cell = heatGrid.createDiv({ cls: `ima-heat-cell ima-heat-lv-${level}` });
        const tipText = s.dashHeatTip(dStr, count);
        setQuietLabel(cell, tipText);
      }

      for (const m of monthNames) {
        monthsRow.createSpan({ text: m });
      }

      const isFullYear = weeks === 52;
      heatCard.toggleClass("is-full-year", isFullYear);

      if (isFullYear) {
        insightsPanel.toggleClass("is-hidden", true);
        summarySpan.setText(s.dashHeatSummary(periodRuns, (periodRuns * 10 / 60).toFixed(1)));
      } else {
        insightsPanel.toggleClass("is-hidden", false);
        const periodHours = ((periodRuns * 10) / 60).toFixed(1);
        summarySpan.setText(s.dashPeriodSummary(weeks === 13 ? 3 : 6, periodRuns, periodHours));

        // 渲染右侧 3 个指标卡（撑满红框空白区域）
        const avgPerWeek = (periodRuns / (weeks || 1)).toFixed(1);
        let peakDayFormatted = "-";
        if (maxDayStr) {
          const parts = maxDayStr.split("-");
          peakDayFormatted = parts.length === 3 ? s.dashMonthDay(Number(parts[1]), Number(parts[2])) : maxDayStr;
        }

        // 卡片 1：本期存入
        const card1 = insightsPanel.createDiv({ cls: "ima-insight-card" });
        card1.createDiv({ cls: "ima-insight-label", text: s.dashInsightPeriodSynced });
        const v1 = card1.createDiv({ cls: "ima-insight-val" });
        v1.createSpan({ text: String(periodRuns) });
        v1.createSpan({ cls: "ima-insight-unit", text: s.dashItemsUnit });
        card1.createDiv({ cls: "ima-insight-sub", text: s.dashInsightAvgWeek(avgPerWeek) });

        // 卡片 2：省下时间
        const card2 = insightsPanel.createDiv({ cls: "ima-insight-card" });
        card2.createDiv({ cls: "ima-insight-label", text: s.dashInsightPeriodHours });
        const v2 = card2.createDiv({ cls: "ima-insight-val" });
        v2.createSpan({ text: periodHours });
        v2.createSpan({ cls: "ima-insight-unit", text: "h" });
        card2.createDiv({ cls: "ima-insight-sub", text: s.dashInsightSavedDesc });

        // 卡片 3：单日最高
        const card3 = insightsPanel.createDiv({ cls: "ima-insight-card" });
        card3.createDiv({ cls: "ima-insight-label", text: s.dashInsightPeakDay });
        const v3 = card3.createDiv({ cls: "ima-insight-val" });
        v3.createSpan({ text: peakDayFormatted });
        card3.createDiv({ cls: "ima-insight-sub", text: maxDayCount > 0 ? s.dashInsightPeakDesc(maxDayCount) : s.dashNoPeak });
      }
    };

    const filterOptions = [
      { btn: btnDay, weeks: 13 },
      { btn: btnWeek, weeks: 26 },
      { btn: btnTotal, weeks: 52 },
    ];

    filterOptions.forEach(({ btn, weeks }) => {
      btn.addEventListener("click", () => {
        filterOptions.forEach((opt) => opt.btn.toggleClass("is-active", opt.btn === btn));
        renderHeatmap(weeks);
      });
    });

    renderHeatmap(13);

    if (isNeverSynced) {
      const emptyNote = heatCard.createDiv({ cls: "ima-heat-empty-note" });
      const emptyIcon = emptyNote.createSpan({ cls: "ima-heat-empty-icon" });
      setIcon(emptyIcon, "calendar");
      emptyNote.createSpan({ text: s.dashHeatEmptyTip });
    }
  }
}

export default class ImaSpeedSyncPlugin extends Plugin {
  private settingsTab?: ImaSpeedSyncSettingTab;
  private sourceHealth?: { key: string; message: string };
  get currentSourceProblem(): string {
    const profile = activeProfile(this.settings);
    return profile && this.sourceHealth?.key === sourceHealthKey(profile) ? this.sourceHealth.message : "";
  }
  override settings: ImaSpeedSyncSettings = { ...DEFAULT_SETTINGS };
  private running = false;
  private currentProcess: ChildProcess | null = null;
  private cancellationPath: string | null = null;
  private cancellationRequested = false;
  private consentPromise: Promise<boolean> | null = null;
  private activeRun: SyncRun | null = null;
  private nextRunId = 1;
  private unloaded = false;
  private markdownController: AbortController | null = null;
  private pendingMarkdown = new Set<string>();
  syncReports: SyncReport[] = [];
  syncedAttachments: SyncedAttachment[] = [];
  private historyPanel: SyncHistoryPanel | null = null;
  private ribbonEl: HTMLElement | null = null;
  private activeNotice: { notice: Notice; interactive: boolean; failed: boolean } | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private reportSaveFailed = false;
  private operationCards = new Set<DesktopOperationCard>();
  private deferredSyncTimer: number | null = null;
  private automaticSyncChecking = false;
  private desktopProbeProcess: ChildProcess | null = null;
  private sourceRebindSession: SourceRebindSession | null = null;
  private sourceInspectionRun: SyncRun | null = null;
  private sourceRebindSaving = false;
  sourceNeedsRebind: SourceNeedsRebind | null = null;
  // The Web host replaces this read-only native adapter with isolated scenarios.
  identityProvider?: IdentityProvider;

  private createDesktopIdentityProvider(run?: SyncRun): DesktopIdentityProvider {
    return new DesktopIdentityProvider(request => this.runNativeIdentity(request, run), Object.values(this.settings.sourceIdentity?.profiles ?? {}));
  }

  private silentIdentityCall = runSilentIdentity;
  private async runNativeIdentity(request: NativeIdentityRequest, parentRun?: SyncRun): Promise<unknown> {
    if (!request.cacheOnly && !(await this.ensureConsent(true))) throw new SyncCanceledError();
    if (parentRun) this.assertRunActive(parentRun);
    const result = await this.silentIdentityCall(request);
    if (parentRun) this.assertRunActive(parentRun);
    return result;
  }

  /** API profiles are migrated only by exact folder identity plus existing article identities. */
  async resolveActiveIdentity(provider = this.identityProvider): Promise<IdentityChoice> {
    const profile = activeProfile(this.settings);
    try {
      const choice = await this.resolveActiveIdentityUnchecked(provider);
      this.sourceHealth = undefined;
      return choice;
    } catch (error) {
      if (profile && !(error instanceof SyncCanceledError)) {
        const message = sourceProblemMessage(error, profile);
        this.sourceHealth = { key: sourceHealthKey(profile), message };
        throw Object.assign(new Error(message), { action: "source-settings", code: (error as { code?: string })?.code });
      }
      throw error;
    } finally {
      this.settingsTab?.sourceHealthChanged();
    }
  }

  private async resolveActiveIdentityUnchecked(provider = this.identityProvider): Promise<IdentityChoice> {
    if (!provider) throw new Error("尚未连接 IMA 客户端。");
    const profile = activeProfile(this.settings);
    if (!profile) throw new Error("请先选择同步来源。");
    if (!(provider instanceof DesktopIdentityProvider) || profile.identityProvider === "desktop-uia") {
      if (provider instanceof DesktopIdentityProvider) provider.seedProfile(profile);
      return await verifyIdentity(provider, profile.knowledgeBaseId, profile.folderId);
    }
    const oldIds = [...new Set(this.syncedAttachments.filter(item => item.sourceScope === profile.sourceScope).map(item => item.sourceId))];
    const index = await this.buildArticleIndex(profile.localDestination, true);
    for (const item of index.metadataByPath.values()) if (item.sourceScope === profile.sourceScope && item.sourceId && !oldIds.includes(item.sourceId)) oldIds.push(item.sourceId);
    if (!oldIds.length) throw new Error("旧来源尚无可核对的文章身份，原配置已保留。请在来源设置中核对后关联原记录。");
    const matches: {choice: IdentityChoice; count: number}[] = [];
    for (const base of await provider.listKnowledgeBases()) {
      let choice: IdentityChoice;
      try { choice = await provider.resolve(base.id, profile.folderId); }
      catch (error) { if ((error as {code?: string}).code === "not-found") continue; throw error; }
      choice.includeSubfolders = profile.includeSubfolders;
      const count = await provider.matchRecords(choice, oldIds);
      if (count > 0) matches.push({ choice, count });
    }
    if (matches.length !== 1) throw new Error("旧来源身份尚未唯一核实，原保存位置和同步记录已保留。");
    const match = matches[0]!;
    const next = migrateDesktopIdentity(this.settings, match.choice, { previousKnowledgeBaseId: profile.knowledgeBaseId,
      matchedRecords: match.count, candidateKnowledgeBaseIds: matches.map(item => item.choice.knowledgeBase.id) });
    await this.persistIdentitySettings(next);
    provider.seedProfile(activeProfile(next)!);
    if (this.identityProvider instanceof DesktopIdentityProvider) this.identityProvider.seedProfile(activeProfile(next)!);
    return match.choice;
  }

  async persistIdentitySettings(next: ImaSpeedSyncSettings): Promise<void> {
    const previous = this.settings;
    const oldProfile = activeProfile(previous), newProfile = activeProfile(next), pending = previous.pendingSourceResume;
    if (pending && oldProfile && newProfile && oldProfile.folderId === newProfile.folderId &&
        oldProfile.sourceScope === newProfile.sourceScope && oldProfile.localDestination === newProfile.localDestination &&
        (oldProfile.knowledgeBaseId === newProfile.knowledgeBaseId || newProfile.legacyKnowledgeBaseIds?.includes(oldProfile.knowledgeBaseId))) {
      next = { ...next, pendingSourceResume: { ...pending, knowledgeBaseName: next.knowledgeBaseName,
        folderName: next.folderName, folderPath: [...sourcePath(next)] } };
    }
    this.settings = next;
    try { await this.saveSettings(); }
    catch (error) { this.settings = previous; throw error; }
  }

  async saveIdentityOptions(values: ScopeValues): Promise<void> {
    if (!values.destinationPath.trim()) throw new Error("请填写保存位置。");
    if (this.settings.pendingSourceResume && (values.destinationPath !== this.settings.destinationPath ||
      values.includeSourceFolder !== this.settings.includeSourceFolder)) throw new Error("请先处理待补齐记录，再更改保存位置。");
    await this.persistIdentitySettings(updateIdentityOptions(this.settings, values));
  }

  async commitIdentityChoice(choice: IdentityChoice, linkLegacy: boolean, matchedRecords: number): Promise<void> {
    if (!this.identityProvider) throw new Error("尚未连接来源识别服务。");
    if (this.running || this.settings.pendingSourceResume) throw new Error("请先完成当前同步或待补齐记录，再切换来源。");
    const verified = await verifyIdentity(this.identityProvider, choice.knowledgeBase.id, choice.folder?.id);
    verified.includeSubfolders = choice.includeSubfolders;
    const next = chooseIdentity(this.settings, verified, value => createHash("sha256").update(value, "utf8").digest("hex"), linkLegacy, matchedRecords);
    await this.persistIdentitySettings(next);
    this.sourceHealth = undefined;
    this.settingsTab?.sourceHealthChanged();
  }
  markdownDashboardState: MarkdownDashboardState = {
    status: "idle",
    total: 0,
    current: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
  };

  updateMarkdownDashboardUI(): void {
    this.settingsTab?.updateMarkdownDashboard();
    for (const leaf of this.app.workspace?.getLeavesOfType?.(VIEW_TYPE) ?? []) {
      if (leaf.view instanceof ImaSpeedSyncView) leaf.view.updateConversionProgress();
    }
  }

  getConversionProgressText(): string {
    const state = this.markdownDashboardState;
    const pending = this.pendingMarkdown.size;
    if (state.status !== "converting") return pending ? `图片 OCR 待转换 ${pending} 份 · 在文档转换中手动补转` : "";
    const counts = `已生成 ${state.completed} · 跳过 ${state.skipped} · 失败 ${state.failed} · 待转换 ${state.deferred ?? 0}`;
    return `正在生成 Markdown：已处理 ${state.current}/${state.total} · ${counts}` +
      (state.currentTitle ? ` · ${state.currentTitle}` : "");
  }

  get isRunning(): boolean {
    return this.running;
  }

  getSourceBinding(settings: Readonly<ImaSpeedSyncSettings> = this.settings): SourceBinding | undefined {
    const binding = restoreSourceBinding(settings.sourceBinding, settings.knowledgeBaseName);
    return binding && (binding.targetKind ?? "folder") === (settings.sourceTargetKind ?? "folder") ? binding : undefined;
  }

  private initializeSourceBinding(): boolean {
    if (this.getSourceBinding() || !this.settings.knowledgeBaseName.trim() || (this.settings.sourceTargetKind !== "knowledge-base" && !this.settings.folderName.trim())) return false;
    const binding = createSourceBinding(this.settings.knowledgeBaseName, this.settings.folderName,
      this.getLegacyDestinationPath(this.settings),
      createHash("sha256").update(this.settings.knowledgeBaseName.trim(), "utf8").digest("hex"), this.settings.sourceTargetKind);
    if (!binding) return false;
    this.settings.sourceBinding = binding;
    return true;
  }

  updateSourceBindingDestination(): void {
    const binding = this.getSourceBinding();
    if (binding) this.settings.sourceBinding = { ...binding, localDestination: this.getLegacyDestinationPath(this.settings) };
  }

  getPendingSourceResume(settings: Readonly<ImaSpeedSyncSettings> = this.settings): PendingSourceResume | undefined {
    if (settings.pendingSourceResume === undefined) return undefined;
    const pending = restorePendingSourceResume(settings.pendingSourceResume);
    if (!pending) throw new Error(getStrings().sourceResumeInvalid);
    return pending;
  }

  private assertPendingSourceContext(pending: PendingSourceResume, settings: Readonly<ImaSpeedSyncSettings>): void {
    if (pending.sourceScope !== this.createSourceScope(settings) ||
      pending.localDestination !== this.getEffectiveDestinationPath(settings) ||
      pending.knowledgeBaseName !== settings.knowledgeBaseName.trim() || pending.folderName !== settings.folderName.trim() ||
      (pending.targetKind ?? "folder") !== (settings.sourceTargetKind ?? "folder") ||
      JSON.stringify(pending.folderPath ?? (pending.folderName ? [pending.folderName] : [])) !== JSON.stringify(sourcePath(settings))) {
      throw new Error(getStrings().sourceResumeInvalid);
    }
  }

  async discardPendingSourceResume(): Promise<void> {
    if (this.running || this.sourceRebindSession || this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    const previous = this.settings.pendingSourceResume;
    delete this.settings.pendingSourceResume;
    try { await this.saveSettings(); }
    catch (error) { this.settings.pendingSourceResume = previous; throw error; }
    this.settingsTab?.refreshSourceSettings();
  }

  private capturePendingSourceResume(result: ExtractionResult, settings: Readonly<ImaSpeedSyncSettings>, previous?: PendingSourceResume): void {
    if (previous) {
      // Downloads are not durable vault imports. Keep every original target until the
      // post-import ledger confirms its file exists, including canceled/failed saves.
      this.settings.pendingSourceResume = previous;
      return;
    }
    if (!result.sourceNeedsRebind) return;
    const records = result.sourcePendingRecords ?? [];
    const unresumableCount = result.sourcePendingUnresumableCount ?? 0;
    if (!records.length && !unresumableCount) return;
    this.settings.pendingSourceResume = { version: 1,
      sourceScope: this.createSourceScope(settings), localDestination: this.getEffectiveDestinationPath(settings),
      knowledgeBaseName: settings.knowledgeBaseName.trim(), folderName: settings.folderName.trim(),
      ...(settings.sourceFolderPath ? { folderPath: [...settings.sourceFolderPath] } : {}),
      ...(settings.sourceTargetKind === "knowledge-base" ? { targetKind: "knowledge-base" as const } : {}),
      records: records.map((record) => ({ ...record, relativeFolder: [...record.relativeFolder],
        ...(record.relativeFolderIds ? { relativeFolderIds: [...record.relativeFolderIds] } : {}) })), unresumableCount };
  }

  private async persistPendingSourceResume(): Promise<void> {
    const pending = this.getPendingSourceResume();
    if (!pending) return;
    this.assertPendingSourceContext(pending, this.settings);
    const index = await this.buildArticleIndex(pending.localDestination, true);
    const savedIds = new Set(this.getExistingSourceIds(index, this.settings));
    const remaining = pending.records.filter((record) => !savedIds.has(record.sourceId));
    if (remaining.length || pending.unresumableCount) this.settings.pendingSourceResume = { ...pending, records: remaining };
    else delete this.settings.pendingSourceResume;
    await this.saveSettings();
  }

  beginSourceRebind(): SourceRebindSession {
    if (this.running || this.sourceRebindSession || this.unloaded) throw new Error(getStrings().sourceRebindBusy);
    const binding = this.getSourceBinding() ?? createSourceBinding(this.settings.knowledgeBaseName,
      this.settings.folderName, this.getEffectiveDestinationPath(), this.createSourceScope(this.settings), this.settings.sourceTargetKind);
    if (!binding) throw new Error(getStrings().sourceRebindChanged);
    const session: SourceRebindSession = {
      knowledgeBaseName: binding.knowledgeBaseName, originalFolderName: this.settings.folderName.trim(),
      localDestination: binding.localDestination, sourceScope: binding.sourceScope,
      candidateName: this.settings.folderName.trim(), candidateKnowledgeBaseName: binding.knowledgeBaseName, revision: 0,
      originalTargetKind: this.settings.sourceTargetKind, candidateTargetKind: this.settings.sourceTargetKind,
      originalFolderPath: this.settings.sourceFolderPath, candidateFolderPath: this.settings.sourceFolderPath,
    };
    this.sourceRebindSession = session;
    return session;
  }

  beginScopeSelection(values: ScopeValues): SourceRebindSession {
    if (this.running || this.sourceRebindSession || this.sourceRebindSaving || this.unloaded) throw new Error(getStrings().sourceRebindBusy);
    const session: SourceRebindSession = {
      knowledgeBaseName: this.settings.knowledgeBaseName.trim(), originalFolderName: this.settings.folderName.trim(),
      originalFolderPath: this.settings.sourceFolderPath ? [...this.settings.sourceFolderPath] : undefined,
      localDestination: this.getEffectiveDestinationPath(), sourceScope: this.createSourceScope(this.settings),
      originalTargetKind: this.settings.sourceTargetKind, candidateTargetKind: values.sourceTargetKind,
      candidateName: values.sourceTargetKind === "knowledge-base" ? "" : values.folderName.trim(),
      candidateFolderPath: values.sourceTargetKind === "knowledge-base" ? undefined : values.sourceFolderPath ? [...values.sourceFolderPath] : undefined,
      candidateKnowledgeBaseName: values.knowledgeBaseName.trim(), revision: 0, selection: true, preserveIdentity: false,
    };
    this.sourceRebindSession = session;
    return session;
  }

  async saveScopeDraft(input: ScopeDraft): Promise<void> {
    if (scopeFingerprint(this.settings) !== input.fingerprint) throw new Error("设置已在其他位置更改，请撤销草稿后重新选择。");
    const draft = { ...input, values: scopeValues(input.values), original: scopeValues(input.original) };
    draft.values.knowledgeBaseName = draft.values.knowledgeBaseName.trim();
    draft.values.folderName = draft.values.sourceTargetKind === "knowledge-base" ? "" : draft.values.folderName.trim();
    if (draft.values.sourceTargetKind === "knowledge-base") delete draft.values.sourceFolderPath;
    draft.values.destinationPath = draft.values.destinationPath.trim();
    this.validateSettings({ ...this.settings, ...draft.values });
    const session = this.beginScopeSelection(draft.values);
    session.preserveIdentity = draft.preserveIdentity;
    try {
      if (!sameSource(draft.original, draft.values)) {
        await this.inspectSourceFolder(session);
        await this.confirmSourceBinding(session, draft);
      } else {
        await this.persistScopeDraft(draft, this.getSourceBinding(), this.getPendingSourceResume());
      }
    } finally { this.cancelSourceRebind(session); }
    this.refreshView();
  }

  previewScopeDestination(draft: ScopeDraft): string {
    return draft.values.destinationPath === draft.original.destinationPath && draft.values.includeSourceFolder === draft.original.includeSourceFolder
      ? this.getEffectiveDestinationPath() : this.getLegacyDestinationPath({ ...this.settings, ...draft.values });
  }

  private applyScopeValues(values: ScopeValues, binding?: SourceBinding, pending?: PendingSourceResume): void {
    Object.assign(this.settings, values);
    for (const key of scopeKeys) if (values[key] === undefined) delete (this.settings as unknown as Record<string, unknown>)[key];
    if (binding) this.settings.sourceBinding = binding; else delete this.settings.sourceBinding;
    if (pending) this.settings.pendingSourceResume = pending; else delete this.settings.pendingSourceResume;
  }

  private async persistScopeDraft(draft: ScopeDraft, binding?: SourceBinding, pending?: PendingSourceResume): Promise<void> {
    if (scopeFingerprint(this.settings) !== draft.fingerprint) throw new Error("设置已在其他位置更改，请撤销草稿后重新选择。");
    const next = { ...this.settings, ...scopeValues(draft.values), sourceBinding: binding };
    if (binding && (draft.values.destinationPath !== draft.original.destinationPath || draft.values.includeSourceFolder !== draft.original.includeSourceFolder)) {
      next.sourceBinding = { ...binding, localDestination: this.getLegacyDestinationPath(next) };
    }
    const destination = this.validateSettings(next);
    if (pending && destination !== pending.localDestination) throw new Error("还有待补齐的同步记录，请先完成或放弃该批次，再更改保存位置。");
    const previous = { ...scopeValues(this.settings), sourceBinding: this.settings.sourceBinding, pendingSourceResume: this.settings.pendingSourceResume };
    this.sourceRebindSaving = true;
    try {
      this.applyScopeValues(scopeValues(next), next.sourceBinding, pending);
      await this.saveSettings();
    } catch (error) { this.applyScopeValues(previous, previous.sourceBinding, previous.pendingSourceResume); throw error; }
    finally { this.sourceRebindSaving = false; }
  }

  openSourceSelection(targetKind?: SourceTargetKind): void {
    try {
      if (this.running || this.sourceRebindSession || this.unloaded) throw new Error(getStrings().sourceRebindBusy);
      const binding = this.getSourceBinding();
      const session: SourceRebindSession = {
        knowledgeBaseName: this.settings.knowledgeBaseName.trim(), originalFolderName: this.settings.folderName.trim(),
        localDestination: this.getEffectiveDestinationPath(), sourceScope: this.createSourceScope(this.settings),
        originalTargetKind: this.settings.sourceTargetKind,
        originalFolderPath: this.settings.sourceFolderPath, candidateFolderPath: this.settings.sourceFolderPath,
        candidateTargetKind: targetKind ?? this.settings.sourceTargetKind,
        candidateName: (targetKind ?? this.settings.sourceTargetKind) === "knowledge-base" ? "" : this.settings.folderName.trim(),
        candidateKnowledgeBaseName: binding?.knowledgeBaseName ?? this.settings.knowledgeBaseName.trim(),
        revision: 0, selection: true, preserveIdentity: false,
      };
      this.sourceRebindSession = session;
      new SourceSelectionModal(this, session).open();
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }

  setSourceSelectionKind(session: SourceRebindSession, kind: SourceTargetKind): void {
    this.assertSourceRebindCurrent(session);
    if (this.running || this.sourceRebindSaving || !["folder", "knowledge-base"].includes(kind)) throw new Error(getStrings().sourceRebindBusy);
    session.candidateTargetKind = kind;
    this.setSourceRebindCandidate(session, "");
  }

  setSourceSelectionIdentity(session: SourceRebindSession, preserve: boolean): void {
    this.assertSourceRebindCurrent(session);
    if (this.running || this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    session.preserveIdentity = preserve;
    this.setSourceRebindCandidate(session, session.candidateName);
  }

  async readSourceCatalog(session: SourceRebindSession, kind: "knowledge-bases" | "folders", parentPath: string[] = []): Promise<SourceCatalog> {
    this.assertSourceRebindCurrent(session);
    if (this.running || this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    const revision = ++session.revision;
    session.inspection = undefined;
    const candidate = session.candidateKnowledgeBaseName;
    if (kind === "folders" && !candidate) throw new Error(getStrings().sourceCatalogChooseKnowledgeBase);
    const run: SyncRun = { id: this.nextRunId++, cancellationPath: null, cancellationRequested: false, process: null };
    this.activeRun = run; this.sourceInspectionRun = run; this.running = true;
    try {
      if (!(await this.ensureConsent(true))) throw new SyncCanceledError();
      this.assertRunActive(run);
      const settings = Object.freeze({ ...this.settings, knowledgeBaseName: candidate, sourceCatalogPath: [...parentPath] });
      const result = this.parseExtractionResult(await this.runPowerShell(1, [], settings, run, [], kind === "folders" ? "list-source-folders" : "list-knowledge-bases"));
      this.assertRunActive(run); this.assertSourceRebindCurrent(session);
      if (session.revision !== revision || session.candidateKnowledgeBaseName !== candidate) throw new Error(getStrings().sourceRebindChanged);
      const catalog = result.sourceCatalog;
      if (result.busy || result.locked || result.canceled || result.errors?.length || result.items?.length || !isSourceCatalog(catalog) ||
        catalog.kind !== kind || (kind === "folders" && (catalog.knowledgeBaseName !== candidate || !catalog.complete || JSON.stringify(catalog.parentPath ?? []) !== JSON.stringify(parentPath)))) {
        throw new Error(result.errors?.[0]?.message ?? getStrings().sourceCatalogFailed);
      }
      return catalog;
    } finally {
      if (run.stagingDirectory) await rm(run.stagingDirectory, { recursive: true, force: true }).catch((error) => console.error("清理来源读取目录失败", error));
      if (this.activeRun === run) {
        this.activeRun = null; this.running = false; this.currentProcess = null;
        this.cancellationPath = null; this.cancellationRequested = false;
      }
      if (this.sourceInspectionRun === run) this.sourceInspectionRun = null;
    }
  }

  openSourceRebind(): void {
    try { new SourceRebindModal(this, this.beginSourceRebind()).open(); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }

  private assertSourceRebindCurrent(session: SourceRebindSession): void {
    if (this.unloaded || this.sourceRebindSession !== session ||
      this.settings.knowledgeBaseName.trim() !== session.knowledgeBaseName ||
      this.settings.folderName.trim() !== session.originalFolderName ||
      JSON.stringify(this.settings.sourceFolderPath) !== JSON.stringify(session.originalFolderPath) ||
      (this.settings.sourceTargetKind ?? "folder") !== (session.originalTargetKind ?? "folder") ||
      this.getEffectiveDestinationPath() !== session.localDestination ||
      this.createSourceScope(this.settings) !== session.sourceScope) throw new Error(getStrings().sourceRebindChanged);
  }

  setSourceRebindCandidate(session: SourceRebindSession, name: string): void {
    this.assertSourceRebindCurrent(session);
    if (this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    session.candidateName = name.trim();
    session.candidateFolderPath = name.trim() && session.candidateFolderPath
      ? [...session.candidateFolderPath.slice(0, -1), name.trim()] : undefined;
    session.revision++;
    session.inspection = undefined;
    if (this.sourceInspectionRun) void this.cancelSync().catch((error) => console.error("取消来源检查失败", error));
  }

  setSourceRebindKnowledgeBase(session: SourceRebindSession, name: string): void {
    this.assertSourceRebindCurrent(session);
    if (this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    session.candidateKnowledgeBaseName = name.trim();
    this.setSourceRebindCandidate(session, session.candidateName);
  }

  async inspectSourceFolder(session: SourceRebindSession): Promise<SourceInspection> {
    this.assertSourceRebindCurrent(session);
    if (this.running || this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    if ((!session.candidateName && session.candidateTargetKind !== "knowledge-base") || !session.candidateKnowledgeBaseName) throw new Error(getStrings().sourceRebindChanged);
    const revision = ++session.revision;
    session.inspection = undefined;
    const candidate = session.candidateTargetKind === "knowledge-base" ? "" : session.candidateName;
    const candidateKnowledgeBase = session.candidateKnowledgeBaseName;
    const run: SyncRun = { id: this.nextRunId++, cancellationPath: null, cancellationRequested: false, process: null };
    this.activeRun = run;
    this.sourceInspectionRun = run;
    this.running = true;
    try {
      if (!(await this.ensureConsent(true))) throw new SyncCanceledError();
      this.assertRunActive(run);
      const settings = Object.freeze({ ...this.settings, knowledgeBaseName: candidateKnowledgeBase, folderName: candidate, sourceTargetKind: session.candidateTargetKind ?? "folder", sourceFolderPath: session.candidateFolderPath });
      const result = this.parseExtractionResult(await this.runPowerShell(1, [], settings, run, [], "inspect-source"));
      this.assertRunActive(run);
      this.assertSourceRebindCurrent(session);
      if (revision !== session.revision || candidate !== session.candidateName || candidateKnowledgeBase !== session.candidateKnowledgeBaseName) throw new Error(getStrings().sourceRebindChanged);
      const inspection = result.sourceInspection;
      if (result.sourceNeedsRebind) throw new Error(result.sourceNeedsRebind.message);
      if (result.busy || result.locked || result.canceled || result.errors?.length || result.items?.length ||
        !isSourceInspection(inspection) || inspection.knowledgeBaseName !== candidateKnowledgeBase ||
        inspection.folderName !== candidate || JSON.stringify(inspection.folderPath ?? (candidate ? [candidate] : [])) !== JSON.stringify(session.candidateFolderPath ?? (candidate ? [candidate] : [])) || (inspection.targetKind ?? "folder") !== (session.candidateTargetKind ?? "folder")) {
        throw new Error(result.errors?.[0]?.message ?? getStrings().sourceRebindChanged);
      }
      session.inspection = { ...inspection, breadcrumb: [...inspection.breadcrumb] };
      return session.inspection;
    } finally {
      if (run.stagingDirectory) await rm(run.stagingDirectory, { recursive: true, force: true }).catch((error) => console.error("清理来源检查暂存文件失败", error));
      if (this.activeRun === run) {
        this.activeRun = null;
        this.running = false;
        this.currentProcess = null;
        this.cancellationPath = null;
        this.cancellationRequested = false;
      }
      if (this.sourceInspectionRun === run) this.sourceInspectionRun = null;
    }
  }

  async confirmSourceBinding(session: SourceRebindSession, draft?: ScopeDraft): Promise<void> {
    this.assertSourceRebindCurrent(session);
    if (this.running || this.sourceRebindSaving) throw new Error(getStrings().sourceRebindBusy);
    if (!session.inspection || session.inspection.folderName !== session.candidateName ||
      session.inspection.knowledgeBaseName !== session.candidateKnowledgeBaseName ||
      (session.inspection.targetKind ?? "folder") !== (session.candidateTargetKind ?? "folder")) throw new Error(getStrings().sourceRebindChanged);
    const binding = createSourceBinding(session.knowledgeBaseName, session.originalFolderName,
      session.localDestination, session.sourceScope, session.originalTargetKind ?? "folder") ?? { version: 1 as const, knowledgeBaseName: session.knowledgeBaseName, remoteFolderName: session.originalFolderName, localDestination: session.localDestination, sourceScope: session.sourceScope };
    const nextBinding = rebindSource(binding, session.inspection);
    if (session.selection && !session.preserveIdentity && session.candidateKnowledgeBaseName !== session.knowledgeBaseName) {
      nextBinding.sourceScope = createHash("sha256").update(session.candidateKnowledgeBaseName, "utf8").digest("hex");
    }
    const previousFolder = this.settings.folderName;
    const previousFolderPath = this.settings.sourceFolderPath;
    const previousTargetKind = this.settings.sourceTargetKind;
    const previousKnowledgeBase = this.settings.knowledgeBaseName;
    const previousBinding = this.settings.sourceBinding;
    const previousPending = this.settings.pendingSourceResume;
    const pending = this.getPendingSourceResume();
    if (pending) {
      this.assertPendingSourceContext(pending, this.settings);
      if ((nextBinding.targetKind ?? "folder") !== (pending.targetKind ?? "folder") ||
        nextBinding.sourceScope !== pending.sourceScope || (session.selection && !session.preserveIdentity && (nextBinding.remoteFolderName !== previousFolder || JSON.stringify(nextBinding.folderPath ?? [nextBinding.remoteFolderName]) !== JSON.stringify(previousFolderPath ?? [previousFolder])))) {
        throw new Error(getStrings().sourceSelectionPending);
      }
    }
    if (draft) {
      await this.persistScopeDraft(draft, nextBinding, pending ? { ...pending,
        knowledgeBaseName: nextBinding.knowledgeBaseName, folderName: nextBinding.remoteFolderName,
        folderPath: nextBinding.folderPath } : undefined);
      this.sourceNeedsRebind = null; this.sourceRebindSession = null;
      return;
    }
    this.sourceRebindSaving = true;
    try {
      this.settings.folderName = nextBinding.remoteFolderName;
      this.settings.sourceFolderPath = nextBinding.folderPath;
      this.settings.sourceTargetKind = nextBinding.targetKind ?? "folder";
      this.settings.knowledgeBaseName = nextBinding.knowledgeBaseName;
      this.settings.sourceBinding = nextBinding;
      if (pending) this.settings.pendingSourceResume = { ...pending,
        knowledgeBaseName: nextBinding.knowledgeBaseName, folderName: nextBinding.remoteFolderName, folderPath: nextBinding.folderPath };
      await this.saveSettings();
    } catch (error) {
      this.settings.folderName = previousFolder;
      this.settings.sourceFolderPath = previousFolderPath;
      this.settings.sourceTargetKind = previousTargetKind;
      this.settings.knowledgeBaseName = previousKnowledgeBase;
      this.settings.sourceBinding = previousBinding;
      this.settings.pendingSourceResume = previousPending;
      throw error;
    } finally {
      this.sourceRebindSaving = false;
    }
    this.sourceNeedsRebind = null;
    this.sourceRebindSession = null;
    this.settingsTab?.refreshSourceSettings();
    this.refreshView();
  }

  cancelSourceRebind(session: SourceRebindSession): void {
    if (this.sourceRebindSession !== session || this.sourceRebindSaving) return;
    session.revision++;
    session.inspection = undefined;
    this.sourceRebindSession = null;
    if (this.sourceInspectionRun) void this.cancelSync().catch((error) => console.error("取消来源检查失败", error));
  }

  override async onload(): Promise<void> {
    this.unloaded = false;
    addIcon(IMA_SHARE_SYNC_ICON_ID, IMA_SHARE_SYNC_ICON_SVG);
    registerFlowIcon();
    const stored = (await this.loadData()) as (Partial<ImaSpeedSyncSettings> & { syncReports?: unknown; syncedAttachments?: unknown }) | null;
    const { syncReports, syncedAttachments, ...saved } = stored ?? {};
    const pendingFile = this.getPendingMarkdownFile();
    try {
      if (await this.app.vault.adapter.exists(pendingFile)) {
        const pending: unknown = JSON.parse(await this.app.vault.adapter.read(pendingFile));
        if (Array.isArray(pending)) this.pendingMarkdown = new Set(pending.filter(isPendingPdfPath));
      }
    } catch (error) { console.error("读取待转换队列失败", error); }
    this.syncedAttachments = Array.isArray(syncedAttachments) ? syncedAttachments.filter((entry: unknown): entry is SyncedAttachment => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return typeof value.path === "string" && typeof value.sourceId === "string" && typeof value.sourceScope === "string";
    }) : [];
    this.syncReports = restoreSyncReports(syncReports);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      imageOcrEnabled: saved.imageOcrEnabled === true,
      ocrProvider: typeof saved.imageOcrEnabled === "boolean" && isOcrProvider(saved.ocrProvider) ? saved.ocrProvider : "api",
      ocrRuntimePath: typeof saved.ocrRuntimePath === "string" ? saved.ocrRuntimePath : "",
      ocrMobileRuntimePath: typeof saved.ocrMobileRuntimePath === "string" ? saved.ocrMobileRuntimePath : "",
      ocrSecretId: typeof saved.ocrSecretId === "string" ? saved.ocrSecretId : "ima-share-sync-baidu-ocr",
      // An existing installation must not silently expand from speed-reader titles to all articles.
      contentMode: saved.contentMode ?? (stored ? "speed-reader" : "general"),
      // Do not silently expand the scope of an existing general-mode installation.
      includeSubfolders: typeof saved.includeSubfolders === "boolean" ? saved.includeSubfolders : saved.contentMode === "general" ? false : true,
      sourceTargetKind: saved.sourceTargetKind === "knowledge-base" ? "knowledge-base" : "folder",
      includeSourceFolder: typeof saved.includeSourceFolder === "boolean" ? saved.includeSourceFolder : (stored ? false : true),
      maxFolders: saved.maxFolders ?? DEFAULT_SETTINGS.maxFolders,
      // Preserve an explicit old opt-out instead of enabling traversal on upgrade.
      maxFolderDepth: saved.maxFolderDepth ?? (saved.includeSubfolders === false ||
        (saved.contentMode === "general" && saved.includeSubfolders === undefined) ? 0 : DEFAULT_SETTINGS.maxFolderDepth),
      // Keep existing per-folder quantities until the user explicitly switches.
      generalSelectionMode: saved.generalSelectionMode ?? (stored ? "per-folder" : "total"),
      syncScopeMode: saved.syncScopeMode ?? "recent",
    };
    this.identityProvider = this.createDesktopIdentityProvider();
    this.settings.includeSubfolders = this.settings.maxFolderDepth > 0 &&
      (this.settings.generalSelectionMode !== "total" || saved.includeSubfolders !== false);
    for (const key of ["notificationsEnabled", "notifyAutoSuccess", "notifyAutoFailure", "notifyManualResult", "showErrorBadge", "showOperationBefore", "showOperationAfter"] as const) {
      if (typeof this.settings[key] !== "boolean") this.settings[key] = DEFAULT_SETTINGS[key];
    }

    // Freeze the existing effective directory and legacy scope before remote labels change.
    // No attachment, article metadata, or sync history is rewritten during migration.
    try {
      if (this.initializeSourceBinding()) await this.saveSettings();
    } catch (error) { console.error("保存来源绑定失败，原文件和同步记录未改动", error); }

    const s = getStrings();
    this.settingsTab = new ImaSpeedSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
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
          window.setTimeout(() => {
            if (!this.unloaded && this.settings.autoSync && this.settings.hasConsented) {
              void this.tryAutomaticSync();
            }
          }, 10000);
        }
      });

      if (typeof this.registerDomEvent === "function") {
        this.registerDomEvent(window, "focus", () => {
          if (
            this.deferredSyncTimer !== null &&
            !this.running &&
            !this.unloaded &&
            this.settings.autoSync &&
            this.settings.hasConsented
          ) {
            window.clearTimeout(this.deferredSyncTimer);
            this.deferredSyncTimer = null;
            void this.tryAutomaticSync();
          }
        });
      }
    }
  }

  override onunload(): void {
    this.unloaded = true;
    this.markdownController?.abort();
    this.desktopProbeProcess?.kill();
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
    run.markdownAbort?.abort();
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
      const detailsButton = notice.messageEl.createEl("button", { text: report.action === "source-settings" ? "检查来源" : "查看详情", cls: "ima-share-sync-notice-details" });
      detailsButton.addEventListener("click", () => {
        notice.hide();
        if (report.action === "source-settings") this.openSourceSettings();
        else this.openSyncHistory([report]);
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
    if (this.ribbonEl) setQuietLabel(this.ribbonEl, showBadge ? "IMA Share Sync：有未读异常，点击查看记录" : "打开 IMA Share Sync");
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
    }, () => this.openSourceSettings(), () => this.getConversionProgressText());
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
        if (latest.action === "source-settings") status.createEl("button", { text: "检查来源" }).addEventListener("click", () => this.openSourceSettings());
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
    if (this.activeRun?.metrics) {
      report.metrics = { ...this.activeRun.metrics };
      report.destination = this.activeRun.destination;
    }
    if (report.kind !== "markdown" && this.activeRun?.markdownMetrics) {
      report.conversion = this.activeRun.markdownMetrics;
    }
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
    const card = new DesktopOperationCard(
      () => {
        if (this.activeRun === run && !run.report) void this.cancelSync().catch((error) => console.error("停止同步失败", error));
      },
      () => {
        if (run.report) void this.markSyncReportsRead([run.report]);
      },
      () => this.operationCards.delete(card),
      () => {
        void (async () => {
          this.settings.showOperationBefore = false;
          this.settings.showOperationAfter = false;
          await this.saveSettings();
          if (this.canNotify(false, true)) {
            this.notifyManual("已开启全静默模式：桌面不再弹出卡片，后台自动同步。", 4000);
          }
        })().catch((error) => console.error("保存静默设置失败", error));
      },
    );
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

  private async checkDesktopReady(): Promise<boolean> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(os.tmpdir(), "ima-desktop-check-"));
      const scriptPath = await this.writeRuntimeScript(directory);
      if (this.unloaded) return false;
      return await new Promise<boolean>((resolve) => {
        let output = "";
        let settled = false;
        const child = spawn(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-CheckDesktop"],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        this.desktopProbeProcess = child;
        const finish = (ready: boolean): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(ready);
        };
        const timer = window.setTimeout(() => { child.kill(); finish(false); }, 10000);
        child.stdout?.setEncoding?.("utf8");
        child.stdout?.on("data", (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-1024); });
        child.stderr?.on("data", () => undefined);
        child.once("error", () => finish(false));
        child.once("close", (code) => {
          try {
            const result: unknown = JSON.parse(output.trim());
            finish(code === 0 && !!result && typeof result === "object" && "desktopReady" in result && result.desktopReady === true);
          } catch { finish(false); }
        });
      });
    } catch { return false; }
    finally {
      this.desktopProbeProcess = null;
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }

  private async tryAutomaticSync(maxItems?: number): Promise<void> {
    if (this.unloaded || this.running || this.automaticSyncChecking || !this.settings.autoSync || !this.settings.hasConsented) return;
    this.automaticSyncChecking = true;
    try {
      const ready = await this.checkDesktopReady().catch(() => false);
      if (this.unloaded || this.running || !this.settings.autoSync || !this.settings.hasConsented) return;
      if (!ready) {
        // Waiting is not a failed sync: no desktop card, source read, vault write or report.
        this.scheduleDeferredSync(false, maxItems, 30000);
        return;
      }
      await this.sync(false, maxItems);
    } finally { this.automaticSyncChecking = false; }
  }

  private scheduleDeferredSync(interactive: boolean, maxItems?: number, delay = 5 * 60 * 1000): void {
    if (this.deferredSyncTimer !== null) window.clearTimeout(this.deferredSyncTimer);
    this.deferredSyncTimer = window.setTimeout(() => {
      this.deferredSyncTimer = null;
      if (!this.unloaded && !this.running) {
        if (interactive) void this.sync(true, maxItems);
        else void this.tryAutomaticSync(maxItems);
      }
    }, delay);
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

  openSourceSettings(): void {
    this.openSettings();
    this.settingsTab?.switchTab("scope");
    this.settingsTab?.openFlowSettings("source");
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
    this.settingsTab?.refreshDashboard();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ImaSpeedSyncView) view.render();
    }
  }

  async sync(interactive: boolean, maxItems?: number): Promise<void> {
    // A suspended batch is resumed only by an explicit manual action.
    if (!interactive && this.settings.pendingSourceResume !== undefined) return;
    if (this.settings.sourceIdentity?.rangeReviewRequired) {
      if (interactive) this.notifyManual("请在“同步与保存”中确认同步范围，并关闭范围提醒。");
      return;
    }
    if (this.running || this.sourceRebindSession || this.markdownController) {
      if (interactive) this.notifyManual("IMA Share Sync 正在运行，请稍候。");
      else if (this.markdownController && this.settings.autoSync) this.scheduleDeferredSync(false, maxItems);
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

    let settings = Object.freeze({
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
    let pendingResume: PendingSourceResume | undefined;
    let resumeAlreadySaved = 0;
    try {
      if (!(await this.ensureConsent(interactive))) {
        await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "canceled", summary: "未开始：尚未授权。", errors: [] }, false);
        return;
      }
      this.assertRunActive(run);
      const profile = activeProfile(settings);
      if (!profile && this.identityProvider instanceof DesktopIdentityProvider) throw new Error("请先在“同步与保存”中选择并确认来源，原保存位置和记录已保留。");
      if (profile) {
        const provider = this.identityProvider instanceof DesktopIdentityProvider
          ? this.createDesktopIdentityProvider(run) : this.identityProvider;
        if (!provider) throw new Error("来源识别服务尚未连接，未开始同步。");
        const current = await this.resolveActiveIdentity(provider);
        this.assertRunActive(run);
        const refreshed = refreshIdentityLabels(this.settings, current);
        if (JSON.stringify(refreshed) !== JSON.stringify(this.settings)) await this.persistIdentitySettings(refreshed);
        settings = Object.freeze({ ...refreshIdentityLabels({ ...settings, sourceIdentity: this.settings.sourceIdentity, pendingSourceResume: this.settings.pendingSourceResume }, current), maxItems: settings.maxItems });
      }
      if (this.initializeSourceBinding()) await this.saveSettings();
      pendingResume = this.getPendingSourceResume(settings);
      if (pendingResume) {
        this.assertPendingSourceContext(pendingResume, settings);
        if (!pendingResume.records.length) throw new Error(getStrings().sourceResumeUnidentified);
      }
      const destinationPath = this.validateSettings(settings);
      run.destination = destinationPath;
      run.metrics = { checked: 0, saved: 0 };
      await this.ensureFolder(destinationPath);
      this.assertRunActive(run);
      const articleIndex = await this.buildArticleIndex(destinationPath, settings.contentMode === "general");
      this.assertRunActive(run);
      const skipTitles = settings.overwriteSameName
        ? []
        : settings.contentMode === "speed-reader" ? this.getExistingArticleTitles(articleIndex) : [];
      const existingSourceIds = this.getExistingSourceIds(articleIndex, settings);
      const skipSourceIds = settings.overwriteSameName && !pendingResume ? [] : existingSourceIds;
      if (pendingResume) {
        const savedIds = new Set(existingSourceIds);
        const remaining = pendingResume.records.filter((record) => !savedIds.has(record.sourceId));
        resumeAlreadySaved = pendingResume.records.length - remaining.length;
        pendingResume = { ...pendingResume, records: remaining };
        this.settings.pendingSourceResume = pendingResume;
        if (!remaining.length) {
          if (pendingResume.unresumableCount) {
            await this.saveSettings();
            throw new Error(getStrings().sourceResumeUnidentified);
          }
          delete this.settings.pendingSourceResume;
          await this.saveSettings();
          run.metrics.checked = resumeAlreadySaved;
          counts.skipped = resumeAlreadySaved;
          await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "success",
            summary: `同步完成：跳过 ${resumeAlreadySaved} 篇，未完成批次已补齐。`, errors: [] });
          return;
        }
        if (resumeAlreadySaved) await this.saveSettings();
      }
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
      const effectiveMaxItems = pendingResume?.records.length ?? maxItems ?? (
        settings.contentMode === "general" && (settings.syncScopeMode ?? "recent") === "all"
          ? 1000
          : settings.maxItems
      );
      const rawResult = await this.runPowerShell(effectiveMaxItems, skipTitles, settings, run, skipSourceIds, "sync", pendingResume?.records);
      this.assertRunActive(run, true);
      const result = this.parseExtractionResult(rawResult);
      if (result.sourceNeedsRebind) {
        this.sourceNeedsRebind = result.sourceNeedsRebind;
        result.errors = [...(result.errors ?? []), { title: "", message: getStrings().sourceRebindNeeded }];
      }
      if (result.busy) {
        await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "canceled", summary: "未开始：已有其他同步任务运行。", errors: [] }, false);
        if (interactive) this.notifyManual("另一个窗口正在运行 IMA Share Sync。");
        return;
      }
      if (result.locked) {
        await this.recordSyncReport({
          finishedAt: Date.now(),
          interactive,
          status: "canceled",
          summary: "已推迟：Windows 桌面当前处于锁定状态，等待解锁后同步。",
          errors: [],
        }, false);
        if (!interactive && !this.unloaded && this.settings.autoSync) {
          this.scheduleDeferredSync(false, maxItems);
        }
        if (interactive) this.notifyManual("当前 Windows 桌面处于锁定状态，请解锁后重试。");
        return;
      }
      const nativeProfile = activeProfile(settings);
      if (settings.contentMode === "general" && nativeProfile?.identityProvider === "desktop-uia") {
        for (const item of result.items ?? []) {
          if (!Array.isArray(item.relativeFolderIds) || item.relativeFolderIds.length !== (item.relativeFolder ?? []).length) {
            throw new Error("文章来源目录 ID 缺失或层级不一致，未保存文件。");
          }
          folderDestinationKey(item.relativeFolderIds);
        }
        const observations = [...(result.sourceFolderObservations ?? []), ...(result.items ?? []).filter(item => item.sourceId && item.relativeFolderIds).map(item => ({
          sourceId: item.sourceId!, relativeFolder: item.relativeFolder ?? [], relativeFolderIds: item.relativeFolderIds!,
        }))];
        const oldRecords: { id: string; path: string[] }[] = [];
        const addOldPath = (id: string, filePath: string): void => {
          const normalized = filePath.replace(/\\/g, "/");
          if (!normalized.startsWith(destinationPath + "/")) return;
          oldRecords.push({ id, path: normalized.slice(destinationPath.length + 1).split("/").slice(0, -1) });
        };
        for (const record of this.syncedAttachments) {
          if (record.sourceScope === nativeProfile.sourceScope && this.app.vault.getAbstractFileByPath(record.path) instanceof TFile) {
            addOldPath(record.sourceId, record.path);
          }
        }
        for (const [filePath, metadata] of articleIndex.metadataByPath) if (metadata.sourceScope === nativeProfile.sourceScope && metadata.sourceId) addOldPath(metadata.sourceId, filePath);
        const mapping = buildFolderDestinations(nativeProfile.folderDestinations, observations.map(item => ({ ...item,
          relativeFolder: this.resolveItemDestination(destinationPath, item.relativeFolder).slice(destinationPath.length + 1).split("/").filter(Boolean),
        })), oldRecords);
        const state = this.settings.sourceIdentity!;
        const next = { ...this.settings, sourceIdentity: { ...state, profiles: { ...state.profiles,
          [nativeProfile.knowledgeBaseId]: { ...activeProfile(this.settings)!, folderDestinations: mapping } } } };
        if (JSON.stringify(mapping) !== JSON.stringify(nativeProfile.folderDestinations)) await this.persistIdentitySettings(next);
        settings = Object.freeze({ ...settings, sourceIdentity: next.sourceIdentity });
      }
      this.capturePendingSourceResume(result, settings, pendingResume);
      this.updateOperationCard(run, "正在保存文章…");
      const extractionCanceled = result.canceled === true;
      if (!extractionCanceled) this.assertRunActive(run);

      counts.skipped = (result.skippedTitles?.length ?? 0) + resumeAlreadySaved;
      run.metrics.checked = (result.items?.length ?? 0) + counts.skipped + (result.errors ?? []).filter(error => error.title.trim()).length;
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
            ? activeProfile(settings)?.identityProvider === "desktop-uia"
              ? this.resolveDestinationPath([destinationPath, ...resolveFolderDestination(activeProfile(settings)!.folderDestinations ?? {}, item.relativeFolderIds!)].join("/"))
              : this.resolveItemDestination(destinationPath, item.relativeFolder)
            : destinationPath;
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
          run.metrics.saved = counts.created + counts.updated;
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

      if (this.settings.pendingSourceResume) {
        try {
          await this.persistPendingSourceResume();
          const remaining = this.getPendingSourceResume();
          if (remaining && !result.errors?.length && !saveErrors.length) {
            const message = remaining.records.length
              ? getStrings().sourceResumeDesc(remaining.records.length, remaining.unresumableCount)
              : getStrings().sourceResumeUnidentified;
            issues.push({ title: "", message });
            saveErrors.push({ title: "", message });
          }
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          issues.push({ title: "", message });
          saveErrors.push({ title: "", message });
          console.error("保存未完成批次失败", error);
        }
      } else if (!extractionCanceled) {
        try {
          await this.saveSettings();
        } catch (error) {
          console.error("保存 IMA Share Sync 附件索引失败", error);
        }
      }

      let convertedMarkdown = 0;
      let deferredMarkdown = 0;
      let failedMarkdown = 0;
      const markdownErrors: ExtractionError[] = [];
      if (!extractionCanceled && settings.enableMarkdownConversion) {
        const recovered = await this.findMissingMarkdownPdfs(result.skippedSourceIds ?? [], settings);
        this.assertRunActive(run);
        const queued = new Set((run.savedPdfFiles ?? []).map(file => file.path.toLocaleLowerCase()));
        for (const file of recovered) {
          if (queued.has(file.path.toLocaleLowerCase())) continue;
          (run.savedPdfFiles ??= []).push(file);
          queued.add(file.path.toLocaleLowerCase());
        }
      }
      if (!extractionCanceled && settings.enableMarkdownConversion && run.savedPdfFiles && run.savedPdfFiles.length > 0) {
        const hasErrors = issues.length > 0 || saveErrors.length > 0 || counts.conflict > 0;
        if (!hasErrors && run.card && this.settings.notificationsEnabled && this.settings.showOperationAfter) {
          const mdTotal = run.savedPdfFiles.length;
          const textParts = [
            counts.created ? `新增 ${counts.created} 篇` : "",
            counts.updated ? `更新 ${counts.updated} 篇` : "",
            counts.unchanged ? `无变化 ${counts.unchanged} 篇` : "",
            counts.skipped ? `跳过 ${counts.skipped} 篇` : "",
          ].filter(Boolean).join(" · ");
          const successText = (textParts || "已是最新内容") + `（后台正在转换 ${mdTotal} 篇为 Markdown）`;
          await run.card.finish({
            phase: "success",
            text: successText,
          }).catch(() => undefined);
          run.card = undefined;
        } else if (hasErrors && run.card) {
          const mdTotal = run.savedPdfFiles.length;
          this.updateOperationCard(run, `正在后台转换 ${mdTotal} 篇为 Markdown（本轮有部分异常）…`);
        }
        try {
          const converted = await this.convertPdfFilesToMarkdown(run.savedPdfFiles, interactive, run);
          this.assertRunActive(run);
          convertedMarkdown = converted?.completed ?? 0;
          deferredMarkdown = converted?.deferred ?? 0;
          if (converted?.failed) {
            failedMarkdown = converted.failed;
            markdownErrors.push(...(run.markdownErrors?.length ? run.markdownErrors :
              [{ title: "PDF → Markdown", message: `${converted.failed} 个 PDF 转换失败，原 PDF 已保留。` }]));
            issues.push(...markdownErrors);
          }
        } catch (err) {
          this.assertRunActive(run);
          const error = { title: "PDF → Markdown", message: `转换阶段失败，原 PDF 已保留：${err instanceof Error ? err.message : String(err)}` };
          saveErrors.push(error);
          issues.push(error);
        }
      }

      const syncErrors = [...(result.errors ?? []), ...saveErrors];
      const failedCount = syncErrors.filter(error => error.title.trim()).length + failedMarkdown;
      const errors = [...syncErrors, ...markdownErrors];
      const taskErrors = syncErrors.filter((error) => !error.title.trim());
      const firstTaskError = taskErrors[0];
      const preserved = counts.created + counts.updated + counts.unchanged;
      const resultParts = [
        counts.created ? `新增 ${counts.created} 篇` : "",
        counts.updated ? `更新 ${counts.updated} 篇` : "",
        counts.unchanged ? `无变化 ${counts.unchanged} 篇` : "",
        counts.skipped ? `跳过 ${counts.skipped} 篇` : "",
        counts.conflict ? `同名冲突 ${counts.conflict} 篇（未覆盖）` : "",
        convertedMarkdown ? `生成 Markdown ${convertedMarkdown} 篇` : "",
        deferredMarkdown ? `图片 OCR 待转换 ${deferredMarkdown} 篇` : "",
        failedCount ? `失败 ${failedCount} 篇` : "",
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
      const desktopState = (error as { code?: string })?.code;
      if (desktopState === "desktop-locked" || desktopState === "desktop-busy") {
        const locked = desktopState === "desktop-locked";
        await this.recordSyncReport({ finishedAt: Date.now(), interactive, status: "canceled",
          summary: locked ? "已推迟：Windows 桌面当前处于锁定状态，等待解锁后同步。" : "未开始：已有其他同步任务运行。", errors: [] }, false);
        if (locked && !interactive && !this.unloaded && this.settings.autoSync) this.scheduleDeferredSync(false, maxItems);
        if (interactive) this.notifyManual(locked ? "当前 Windows 桌面处于锁定状态，请解锁后重试。" : "另一个窗口正在运行 IMA Share Sync。");
        return;
      }
      if (this.settings.pendingSourceResume) {
        try { await this.persistPendingSourceResume(); }
        catch (pendingError) { console.error("保留未完成批次失败", pendingError); }
      }
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
        ...((error as { action?: string })?.action === "source-settings" ? { action: "source-settings" as const } : {}),
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
            if (!run.card.isFinished) {
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
            }
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
        if (!this.unloaded) {
          if (this.sourceNeedsRebind || pendingResume || this.settings.pendingSourceResume) this.settingsTab?.refreshSourceSettings();
          this.refreshView();
        }
      }
    }
  }

  private validateSettings(settings: Readonly<ImaSpeedSyncSettings>): string {
    this.resolveDestinationPath(settings.destinationPath);
    if (!settings.knowledgeBaseName.trim()) {
      throw new Error("请先填写完整的 IMA 知识库名称。");
    }
    if (!["folder", "knowledge-base"].includes(settings.sourceTargetKind ?? "folder")) throw new Error("来源范围无效。");
    if (settings.sourceTargetKind !== "knowledge-base" && !settings.folderName.trim()) {
      throw new Error("请先填写完整的 IMA 文件夹名称。");
    }
    if (settings.sourceFolderPath !== undefined && (!Array.isArray(settings.sourceFolderPath) || settings.sourceFolderPath.length > 5 ||
      settings.sourceFolderPath.some(part => typeof part !== "string" || !part.trim()) ||
      (settings.sourceTargetKind !== "knowledge-base" && settings.sourceFolderPath.at(-1) !== settings.folderName))) throw new Error("来源目录路径无效。");
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
    const binding = this.getSourceBinding(settings);
    if (binding) return this.resolveDestinationPath(binding.localDestination);
    return this.getLegacyDestinationPath(settings);
  }

  private getLegacyDestinationPath(settings: Readonly<ImaSpeedSyncSettings>): string {
    const base = this.resolveDestinationPath(settings.destinationPath);
    if (settings.sourceTargetKind !== "knowledge-base" && settings.includeSourceFolder && settings.folderName.trim()) {
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
    const binding = this.getSourceBinding(settings);
    if (binding) return binding.sourceScope;
    return createHash("sha256").update(settings.knowledgeBaseName.trim(), "utf8").digest("hex");
  }

  private createGeneralSourceKey(item: ExtractedArticle, settings: Readonly<ImaSpeedSyncSettings>): string {
    // A UI card identity is independent of the article title and folder. Without one,
    // exact content + source location is only a conservative same-content fallback.
    const identity = item.sourceId
      ? [this.createSourceScope(settings), "card", item.sourceId]
      : [this.createSourceScope(settings), ...[...sourcePath(settings), ...(item.relativeFolder ?? [])].filter(Boolean), item.sourceTitle, "content", item.body.replace(/\r\n?/g, "\n").trim()];
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
      // PowerShell serializes its unset optional rebind state as JSON null.
      if (obj.sourceNeedsRebind === null) delete obj.sourceNeedsRebind;
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
    const hasKnownField = ["busy", "canceled", "locked", "items", "errors", "skippedTitles", "sourceInspection", "sourceNeedsRebind", "identityResult"]
      .some((key) => Object.prototype.hasOwnProperty.call(result, key));
    if (!hasKnownField) return false;
    if (result.sourceCatalog !== undefined && !isSourceCatalog(result.sourceCatalog)) return false;
    if (result.sourceInspection !== undefined && !isSourceInspection(result.sourceInspection)) return false;
    if (result.sourceNeedsRebind !== undefined && !isSourceNeedsRebind(result.sourceNeedsRebind)) return false;
    if (result.sourcePendingRecords !== undefined && !isSourcePendingRecords(result.sourcePendingRecords)) return false;
    if (result.sourcePendingUnresumableCount !== undefined &&
      (typeof result.sourcePendingUnresumableCount !== "number" || !Number.isInteger(result.sourcePendingUnresumableCount) || result.sourcePendingUnresumableCount < 0)) return false;
    if (result.busy !== undefined && typeof result.busy !== "boolean") return false;
    if (result.canceled !== undefined && typeof result.canceled !== "boolean") return false;
    if (result.locked !== undefined && typeof result.locked !== "boolean") return false;
    if (result.skippedSourceIds !== undefined && (!Array.isArray(result.skippedSourceIds) ||
      !result.skippedSourceIds.every(id => typeof id === "string" && id.length > 0))) return false;
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
    operation: "sync" | "inspect-source" | "list-knowledge-bases" | "list-source-folders" | "native-identity" = "sync",
    resumeRecords?: SourcePendingRecord[],
    nativeIdentity?: NativeIdentityRequest,
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
        operation,
        ...(nativeIdentity ? { nativeIdentity } : {}),
        ...(operation === "sync" && activeProfile(settings)?.identityProvider === "desktop-uia" ? { nativeSource: desktopSource(activeProfile(settings)!) } : {}),
        sourceTargetKind: settings.sourceTargetKind ?? "folder",
        ...(settings.sourceFolderPath ? { sourceFolderPath: settings.sourceFolderPath } : {}),
        ...(settings.sourceCatalogPath ? { sourceCatalogPath: settings.sourceCatalogPath } : {}),
        ...(resumeRecords ? { resumeRecords } : {}),
        skipTitles, skipSourceIds,
        syncScopeMode: settings.syncScopeMode ?? "recent",
        generalSelectionMode: settings.generalSelectionMode,
        includeSubfolders: settings.includeSubfolders && settings.maxFolderDepth > 0,
        maxFolders: settings.maxFolders,
        maxFolderDepth: settings.includeSubfolders ? settings.maxFolderDepth : 0,
        downloadDirectory,
        existingFiles: operation !== "sync" || settings.overwriteSameName ? [] : (() => {
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
        ...(settings.knowledgeBaseName ? ["-KnowledgeBaseName", settings.knowledgeBaseName] : []),
        ...(settings.sourceTargetKind !== "knowledge-base" && settings.folderName ? ["-FolderName", settings.folderName] : []),
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
          child = spawn(windowsPowerShellPath(), args, {
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

  cancelMarkdownConversion(): void {
    this.markdownController?.abort();
  }

  private localOcrRuntime(mode: LocalOcrMode): string {
    const configured = mode === "local-mobile" ? this.settings.ocrMobileRuntimePath : this.settings.ocrRuntimePath;
    return configured.trim() || defaultOcrRuntime(mode);
  }

  get supportsLocalOcr(): boolean {
    return Platform.isWin && this.app.vault.adapter instanceof FileSystemAdapter;
  }

  async isLocalOcrReady(mode: LocalOcrMode): Promise<boolean> {
    if (!this.supportsLocalOcr) return false;
    try { await checkOcrRuntime(this.localOcrRuntime(mode), mode); return true; }
    catch { return false; }
  }

  get pendingOcrCount(): number {
    return this.pendingMarkdown.size;
  }

  private async findMissingMarkdownPdfs(sourceIds: string[], settings: Readonly<ImaSpeedSyncSettings>): Promise<PdfConversionFile[]> {
    const selected = new Set(sourceIds);
    const scope = this.createSourceScope(settings);
    const destination = this.getEffectiveDestinationPath(settings) + "/";
    const found = new Map<string, PdfConversionFile>();
    for (const entry of this.syncedAttachments) {
      if (!selected.has(entry.sourceId) || entry.sourceScope !== scope || !entry.path.startsWith(destination)) continue;
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (!(file instanceof TFile) || file.extension.toLocaleLowerCase() !== "pdf") continue;
      const mdPath = file.path.replace(/\.pdf$/i, ".md");
      // Check disk as well as the index: a note written by a user may not be indexed yet.
      if (this.app.vault.getAbstractFileByPath(mdPath) || await this.app.vault.adapter.exists(mdPath)) continue;
      found.set(file.path.toLocaleLowerCase(), { path: file.path, title: file.basename });
    }
    return [...found.values()];
  }


  private getPendingMarkdownFile(): string {
    const dir = this.manifest?.dir ?? `${this.app.vault.configDir}/plugins/ima-speed-sync`;
    return `${dir}/pending-markdown.json`;
  }

  async retryPendingMarkdown(): Promise<void> {
    if (this.unloaded || this.running || this.markdownController) {
      this.notifyManual("请等当前任务结束后再补转");
      return;
    }
    if (!this.settings.enableMarkdownConversion || !this.settings.imageOcrEnabled) {
      this.notifyManual("请先手动开启图片 OCR");
      return;
    }
    if (!this.pendingMarkdown.size) return;
    if (this.settings.ocrProvider === "api" && !this.app.secretStorage?.getSecret(this.settings.ocrSecretId)?.trim()) {
      const en = getAppLanguage(this.settings.language) === "en";
      this.notifyManual(en ? "Set up your Baidu AI Studio API token before running cloud OCR." : "请先配置百度 AI Studio API 令牌，再运行云端补转。");
      return;
    }
    const files = [...this.pendingMarkdown].map(pdfPath => ({
      path: pdfPath, title: path.posix.basename(pdfPath, path.posix.extname(pdfPath)),
    }));
    await this.convertPdfFilesToMarkdown(files, true, undefined, "ocr-pending");
  }

  async convertPdfFilesToMarkdown(
    pdfFiles: PdfConversionFile[],
    showNotice = true,
    run?: SyncRun,
    intent: "text-and-queue" | "ocr-pending" = "text-and-queue",
  ): Promise<ConvertResultSummary | undefined> {
    if (!this.settings.enableMarkdownConversion || !pdfFiles.length) return;
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    if (this.markdownController) {
      if (showNotice) this.notifyManual("已有转换正在运行");
      return;
    }

    const started = performance.now();
    const conversion: MarkdownConversionMetrics = {
      durationMs: 0,
      uploadedFiles: 0,
      uploadedBytes: 0,
      unconfirmedFiles: 0,
      unconfirmedPdfBytes: 0,
    };
    const finishConversion = () => {
      conversion.durationMs = Math.round(performance.now() - started);
      if (run) run.markdownMetrics = conversion;
      return Date.now();
    };
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
        scope: "all",
      });
    }

    let notice: Notice | undefined;
    const canNotifyManual = this.canNotify(true, false);
    if (showNotice && canNotifyManual) {
      notice = new Notice(`正在转换 Markdown 笔记 (0/${tasks.length})...`, 0);
    }

    const abortController = new AbortController();
    this.markdownController = abortController;
    if (run) run.markdownAbort = abortController;
    let batchHold = "";
    const secretId = this.settings.ocrSecretId;
    const interactive = showNotice;
    const allowOcr = intent === "ocr-pending" && interactive && !run && this.settings.imageOcrEnabled;
    const provider = this.settings.ocrProvider;
    const conversionErrors: ExtractionError[] = [];
    let queueChanged = false;
    let uploadApproval: Promise<boolean> | undefined;

    this.markdownDashboardState = {
      status: "converting",
      total: tasks.length,
      current: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
    };
    this.updateMarkdownDashboardUI();

    if (run) {
      this.updateOperationCard(run, `正在生成 Markdown 笔记 (0/${tasks.length})…`);
    }

    try {
      const result = await runMarkdownConversion(
        tasks,
        "", // Desktop supplies the async text/OCR processor; no worker eval is needed.
        (progress, total) => {
          this.markdownDashboardState.current = progress;
          this.markdownDashboardState.currentTitle = undefined;
          this.updateMarkdownDashboardUI();
          notice?.setMessage(`正在转换 Markdown 笔记 (${progress}/${total})…`);
          if (run) this.updateOperationCard(run, `正在生成 Markdown 笔记 (${progress}/${total})…`);
        },
        abortController.signal,
        async task => {
          const state = this.markdownDashboardState;
          const relative = path.relative(vaultBase, task.pdfPath).split(path.sep).join("/");
          state.currentTitle = task.title;
          this.updateMarkdownDashboardUI();
          let deferredReason = "";
          let ocrFailure: OcrJobFailure | undefined;
          const result = await processPdfWithOcr(task, async request => {
            const actualPath = path.relative(await realpath(vaultBase), await realpath(request.pdfPath)).split(path.sep).join("/");
            if (!isPendingPdfPath(actualPath) || !isPendingPdfPath(relative)) throw new Error("PDF 不在当前笔记库内");
            if (!this.pendingMarkdown.has(relative)) {
              this.pendingMarkdown.add(relative);
              queueChanged = true;
            }
            if (!allowOcr || batchHold) {
              deferredReason = batchHold || (this.settings.imageOcrEnabled ? "等待手动补转" : "图片 OCR 未开启");
              throw new Error(deferredReason);
            }
            const stillAllowed = () => !abortController.signal.aborted && this.settings.enableMarkdownConversion &&
              this.settings.imageOcrEnabled && this.settings.ocrProvider === provider;
            try {
              if (!stillAllowed()) throw new Error("图片 OCR 设置已变更，本轮未继续");
              if (provider !== "api") {
                if (!this.supportsLocalOcr) throw new LocalOcrSetupError("本地 OCR 需要 Windows 桌面端");
                return await recognizeLocal(request, this.localOcrRuntime(provider), (page, total) => {
                  state.currentTitle = `${task.title} · OCR ${page}/${total} 页`;
                  this.updateMarkdownDashboardUI();
                }, provider);
              }

              // Legacy persistent upload permissions are deliberately ignored.
              const token = this.app.secretStorage?.getSecret(secretId)?.trim();
              if (!token) throw new OcrAccountError("请先配置百度 AI Studio 访问令牌");
              uploadApproval ??= confirmOcr(this.app, "上传到百度 AI Studio？",
                `本轮最多 ${tasks.length} 份。需要 OCR 的整份 PDF 将发给百度，仅识别所需页，使用你的账户额度。`,
                "仅允许本轮", abortController.signal);
              if (!(await uploadApproval)) { abortController.abort(); throw new Error("已取消上传"); }
              if (!stillAllowed() || this.settings.ocrSecretId !== secretId) throw new Error("云端 OCR 授权已变更，未上传");
              return await recognizeApi(request, token, true, undefined, undefined, (bytes, accepted) => {
                if (accepted) {
                  conversion.uploadedFiles++;
                  conversion.uploadedBytes += bytes;
                } else {
                  conversion.unconfirmedFiles++;
                  conversion.unconfirmedPdfBytes += bytes;
                }
              });
            } catch (error) {
              if (error instanceof OcrAccountError || error instanceof LocalOcrMemoryError || error instanceof LocalOcrSetupError) {
                batchHold = deferredReason = error.message;
              }
              if (error instanceof OcrJobError) ocrFailure = error.diagnostic;
              throw error;
            }
          }, provider, abortController.signal);
          if (deferredReason && isPendingPdfPath(relative)) {
            if (!conversionErrors.some(item => item.message === deferredReason)) {
              conversionErrors.push({ title: "图片 OCR 待转换", message: deferredReason });
            }
            state.deferred = (state.deferred ?? 0) + 1;
            return { success: false, skipped: false, deferred: true };
          }
          if ((result.success || result.skipped) && this.pendingMarkdown.delete(relative)) queueChanged = true;
          if (result.skipped) state.skipped++;
          else if (result.success) state.completed++;
          else {
            state.failed++;
            conversionErrors.push({
              title: task.title,
              message: result.error ?? "OCR 失败",
              ...(ocrFailure ? { ocr: ocrFailure } : {}),
            });
          }
          return result;
        },
      );
      if (notice) notice.hide();
      const finishedAt = finishConversion();
      this.markdownDashboardState = {
        status: "completed",
        total: tasks.length,
        current: tasks.length,
        completed: result.completed,
        skipped: result.skipped,
        failed: result.failed,
        deferred: result.deferred,
        lastFinishedAt: finishedAt,
      };
      this.updateMarkdownDashboardUI();

      const summary = `文档转换：完成 ${result.completed}，跳过 ${result.skipped}，失败 ${result.failed}` +
        (result.deferred ? `，图片 OCR 待转换 ${result.deferred}（${conversionErrors.find(e => e.title === "图片 OCR 待转换")?.message ?? "请查看文档转换设置"}）` : "");
      if (run) run.markdownErrors = conversionErrors;
      else {
        await this.recordSyncReport({ finishedAt, interactive, kind: "markdown", status: result.failed ? "failed" : "success",
          summary, errors: conversionErrors, conversion }, !interactive && result.failed > 0);
      }

      if (showNotice && canNotifyManual) {
        this.notifyManual(summary);
      }
      return result;
    } catch (err) {
      const canceled = abortController.signal.aborted;
      const finishedAt = finishConversion();
      this.markdownDashboardState = {
        ...this.markdownDashboardState, status: canceled ? "canceled" : "failed", currentTitle: undefined, lastFinishedAt: finishedAt,
      };
      this.updateMarkdownDashboardUI();
      if (notice) notice.hide();
      const message = err instanceof Error ? err.message : String(err);
      if (!canceled) console.error("Markdown 转换执行异常:", err);
      if (!run) await this.recordSyncReport({ finishedAt, interactive, kind: "markdown",
        status: canceled ? "canceled" : "failed", summary: canceled ? "文档转换已取消" : "文档转换失败",
        errors: canceled ? [] : [{ title: "文档转换", message }], conversion }, false);
      if (showNotice && this.canNotify(true, !canceled)) {
        this.notify(canceled ? "文档转换已取消" : `Markdown 转换失败: ${message}`, true, !canceled, 8000);
      }
      if (run) throw err;
    } finally {
      if (queueChanged && !this.unloaded) {
        try { await this.app.vault.adapter.write(this.getPendingMarkdownFile(), JSON.stringify([...this.pendingMarkdown], null, 2)); }
        catch (error) {
          console.error("保存待转换队列失败", error);
          this.notify("待转换队列保存失败，重启后可能需要重新加入。", interactive, true, 8000);
        }
      }
      if (this.markdownController === abortController) this.markdownController = null;
      if (run && run.markdownAbort === abortController) {
        run.markdownAbort = undefined;
      }
      if (!run && !this.unloaded && this.app.workspace) this.refreshView();
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
      if (interactive && this.canNotify(interactive, false)) this.notifyManual(`未在目标目录 [${targetDir}] 下找到任何 PDF 文件。`);
      return;
    }

    if (interactive && this.canNotify(interactive, false)) this.notifyManual(`扫描到 ${pdfList.length} 篇 PDF，开始生成 Markdown...`);
    await this.convertPdfFilesToMarkdown(pdfList, interactive);
  }
}
