import { App, Modal, setIcon } from "obsidian";
import { silenceHoverHints } from "./quiet-labels";
import { type RemoteEntity, type RemoteFolder, type IdentityChoice, type IdentityProvider, type IdentityProfile, type IdentityProviderKind, verifyIdentity } from "./source-identity";

export interface IdentityPickerOptions {
  provider: IdentityProvider;
  identityProvider?: IdentityProviderKind;
  currentId?: string;
  startAtRoot?: boolean;
  profiles: Record<string, IdentityProfile>;
  mode: "knowledge-bases" | "folders" | "legacy";
  legacyDescription?: string;
  legacySourceIds: string[];
  commit(choice: IdentityChoice, linkLegacy: boolean, matchedRecords: number): Promise<void>;
  close?(): void;
}

/** Missing provider metadata belongs to the original API identity namespace. */
export function sourceIdentityNotice(base: RemoteEntity, profiles: Record<string, IdentityProfile>, kind: IdentityProviderKind = "ima-api"): string | undefined {
  const all = Object.values(profiles);
  const selected = all.find(profile => (profile.identityProvider ?? "ima-api") === kind && profile.knowledgeBaseId === base.id);
  const unresolved = all.filter(profile => {
    if (profile.knowledgeBaseName !== base.name) return false;
    const previousKind = profile.identityProvider ?? "ima-api";
    if (previousKind === kind) return profile.knowledgeBaseId !== base.id;
    if (kind === "ima-api" && profile.legacyKnowledgeBaseIds?.includes(base.id)) return false;
    if (kind === "desktop-uia" && selected?.legacyKnowledgeBaseIds?.includes(profile.knowledgeBaseId)) return false;
    return true;
  });
  if (!unresolved.length) return undefined;
  return unresolved.some(profile => (profile.identityProvider ?? "ima-api") === kind)
    ? "这是另一个同名知识库，原记录不会合并到这里。"
    : "与已有来源同名，尚未确认是否为原来源；原记录保持不变。";
}

/** Browse a single source path. Only using the current location commits it. */
export class IdentityPicker extends Modal {
  private closed = false;
  private busy = false;
  private loading = false;
  private loadVersion = 0;
  private linking = false;
  private bases: RemoteEntity[] = [];
  private folders: RemoteFolder[] = [];
  private base?: RemoteEntity;
  private folder?: RemoteFolder;
  private includeChildren = true;
  private error = "";
  private retrySelection = false;
  private query = "";
  private matched = 0;
  private verified?: IdentityChoice;
  private results?: HTMLElement;

  constructor(app: App, private readonly options: IdentityPickerOptions) {
    super(app);
    this.modalEl.addEventListener("cancel", event => { if (this.busy) event.preventDefault(); });
  }
  override onOpen(): void { void this.loadBases(true); }

  private async loadBases(restore = false): Promise<void> {
    if (this.busy) return;
    if (restore && this.options.mode !== "legacy" && this.options.currentId) {
      const profile = this.options.profiles[this.options.currentId];
      if (profile) { await this.selectBase({ id: profile.knowledgeBaseId, name: profile.knowledgeBaseName }); return; }
    }
    const version = ++this.loadVersion;
    this.bases = [];
    this.loading = true; this.error = ""; this.retrySelection = false; this.render();
    try {
      const bases = await this.options.provider.listKnowledgeBases();
      if (version !== this.loadVersion || this.closed) return;
      this.bases = bases;
    } catch (error) { if (version === this.loadVersion) this.error = (error as Error).message; }
    finally { if (version === this.loadVersion) { this.loading = false; this.render(); } }
  }

  private selectBase(base: RemoteEntity): Promise<void> {
    if (this.busy || this.loading) return Promise.resolve();
    this.base = base;
    const remembered = this.options.profiles[base.id];
    this.includeChildren = remembered?.includeSubfolders ?? true;
    let folder: RemoteFolder | undefined;
    if (!this.options.startAtRoot && remembered?.folderId && remembered.folderPathIds?.length === remembered.folderPath.length) {
      const path = remembered.folderPathIds.map((id, index) => ({ id, name: remembered.folderPath[index]! }));
      const last = path.at(-1);
      if (last?.id === remembered.folderId) folder = { ...last, path };
    }
    return this.browse(folder);
  }

  private async browse(folder?: RemoteFolder): Promise<void> {
    if (this.busy || !this.base) return;
    const version = ++this.loadVersion, base = this.base;
    this.folder = folder; this.folders = []; this.query = "";
    this.loading = true; this.error = ""; this.retrySelection = false; this.render();
    try {
      const folders = await this.options.provider.listFolders(base.id, folder?.id);
      if (version !== this.loadVersion || this.closed) return;
      this.folders = folders;
      if (folder && folders[0]) {
        const path = folders[0].path.slice(0, -1), last = path.at(-1);
        if (last?.id === folder.id) this.folder = { ...last, path };
      }
    } catch (error) { if (version === this.loadVersion) this.error = (error as Error).message; }
    finally { if (version === this.loadVersion) { this.loading = false; this.render(); } }
  }

  private async useSelection(): Promise<void> {
    if (this.closed || this.busy || this.loading || !this.base || this.error) return;
    ++this.loadVersion; this.loading = false;
    this.busy = true; this.error = ""; this.retrySelection = false; this.render();
    try {
      const choice = await verifyIdentity(this.options.provider, this.base.id, this.folder?.id);
      if (this.closed) return;
      choice.includeSubfolders = this.includeChildren;
      if (this.options.mode === "legacy" && !this.linking) {
        this.matched = await this.options.provider.matchRecords(choice, this.options.legacySourceIds);
        if (this.matched < 1) throw new Error("这里没有找到原来同步过的文章。请选择原来源，原记录不会改变。");
        this.verified = choice; this.linking = true;
      } else {
        await this.options.commit(choice, this.options.mode === "legacy", this.matched);
        this.close();
      }
    } catch (error) { this.error = (error as Error).message; this.retrySelection = true; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }

  private render(): void {
    if (this.closed) return;
    this.titleEl.setText(this.linking ? "关联原同步记录" : this.options.mode === "legacy" ? "选择原来源" : "选择来源");
    this.contentEl.empty(); this.contentEl.addClass("ima-scope-picker");
    this.modalEl.addClass("ima-identity-dialog", "ima-palette-9");
    const exit = this.contentEl.createEl("button", { cls: "ima-identity-close", attr: { type: "button", "aria-label": "取消并关闭" } });
    setIcon(exit, "x"); exit.addEventListener("click", () => this.close());
    if (this.error) {
      const error = this.contentEl.createDiv({ cls: "ima-identity-alert", text: this.error, attr: { role: "alert" } });
      const retry = error.createEl("button", { text: this.retrySelection ? "重试" : "重新读取", attr: { type: "button" } });
      retry.disabled = this.busy;
      retry.addEventListener("click", () => {
        this.error = "";
        if (this.retrySelection || this.linking) { void this.useSelection(); }
        else if (this.base) void this.browse(this.folder);
        else void this.loadBases();
      });
    }
    if (this.linking) {
      const details = this.contentEl.createDiv({ cls: "ima-identity-review" });
      details.createEl("p", { text: this.options.legacyDescription ?? "保留原保存位置和同步记录。" });
      details.createEl("strong", { text: this.verified!.knowledgeBase.name + (this.verified!.folder ? " / " + this.verified!.folder.path.map(p => p.name).join(" / ") : "") });
      details.createEl("p", { text: `已找到 ${this.matched} 篇原同步文章。关联后继续沿用原记录和保存位置。` });
    } else {
      const breadcrumb = this.contentEl.createEl("nav", { cls: "ima-picker-toolbar ima-identity-breadcrumb", attr: { "aria-label": "来源路径" } });
      const crumb = (name: string, current: boolean, action: () => void) => {
        if (breadcrumb.childElementCount) setIcon(breadcrumb.createSpan({ attr: { "aria-hidden": "true" } }), "chevron-right");
        const b = breadcrumb.createEl("button", { text: name, attr: { type: "button", ...(current ? { "aria-current": "location" } : {}) } });
        b.disabled = this.busy; b.addEventListener("click", action);
      };
      crumb("全部知识库", !this.base, () => {
        this.base = undefined; this.folder = undefined; this.folders = []; this.query = ""; this.error = "";
        void this.loadBases();
      });
      if (this.base) crumb(this.base.name, !this.folder, () => { void this.browse(); });
      const path = this.folder?.path ?? [];
      path.forEach((part, index) => crumb(part.name, index === path.length - 1, () => {
        void this.browse({ ...part, path: path.slice(0, index + 1) });
      }));
      const search = this.contentEl.createEl("input", { attr: { type: "search", placeholder: this.base ? "搜索当前目录" : "搜索知识库", "aria-label": "搜索名称" } });
      search.value = this.query; search.disabled = this.busy || this.loading || Boolean(this.error);
      search.addEventListener("input", () => { this.query = search.value; this.renderRows(); });
      this.results = this.contentEl.createDiv({ cls: "ima-picker-results" }); this.renderRows();
      if (this.busy || this.loading) this.contentEl.createDiv({ text: this.busy ? "正在确认来源…" : "正在读取最新目录…", attr: { role: "status" } });
      const identityNotice = this.base && sourceIdentityNotice(this.base, this.options.profiles, this.options.identityProvider);
      if (identityNotice) {
        this.contentEl.createDiv({ cls: "ima-identity-alert", text: identityNotice, attr: { role: "note" } });
      }
    }
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const back = actions.createEl("button", { text: this.linking ? "返回" : "取消" });
    back.addEventListener("click", () => { if (this.linking) { this.linking = false; this.error = ""; this.render(); } else this.close(); });
    const confirm = actions.createEl("button", {
      text: this.busy ? "正在读取…" : this.linking ? "关联并保留记录" : this.options.mode === "legacy" ? "核对原记录" : this.base ? `使用「${this.folder?.name ?? this.base.name}」` : "请选择来源",
      cls: "mod-cta", attr: { type: "button", "aria-label": this.linking ? "关联并保留记录" : this.options.mode === "legacy" ? "核对原记录" : "使用此来源" },
    });
    confirm.disabled = this.busy || this.loading || !this.base || Boolean(this.error);
    confirm.addEventListener("click", () => { void this.useSelection(); });
    silenceHoverHints(this.modalEl);
  }

  private renderRows(): void {
    if (!this.results) return;
    this.results.empty();
    const items = (this.base ? this.folders : this.bases).filter(item => item.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase()));
    for (const item of items) {
      const row = this.results.createDiv({ cls: "ima-picker-row" });
      const pick = row.createEl("button", { cls: "ima-picker-option", attr: { type: "button", "aria-label": "进入 " + item.name + (item.detail ? " " + item.detail : "") } });
      pick.disabled = this.busy || this.loading || Boolean(this.error); setIcon(pick.createSpan(), this.base ? "folder" : "book-open");
      const text = pick.createSpan(); text.createSpan({ text: item.name });
      if (item.detail) text.createEl("small", { text: item.detail });
      setIcon(pick.createSpan(), "chevron-right");
      pick.addEventListener("click", () => { if (this.base) void this.browse(item as RemoteFolder); else void this.selectBase(item); });
    }
    if (!this.busy && !this.loading && !this.error && !items.length) this.results.createEl("p", { text: this.query ? "没有找到匹配项。" : this.base ? "没有子文件夹，可以直接使用当前位置。" : "没有可用的知识库。" });
    silenceHoverHints(this.results);
  }
  override onClose(): void { this.closed = true; ++this.loadVersion; this.options.close?.(); this.contentEl.empty(); }
}
