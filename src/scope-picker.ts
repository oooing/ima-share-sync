import { App, Modal, Setting, setIcon } from "obsidian";
import { silenceHoverHints } from "./quiet-labels";

export interface PickerList { names: string[]; ambiguousNames?: string[]; complete?: boolean }
export interface PickerOptions {
  title: string;
  selected: string[];
  browse?: boolean;
  rename?: boolean;
  preserveIdentity?: boolean;
  load: (parent: string[]) => Promise<PickerList>;
  choose: (path: string[], rename: boolean) => void;
  cancel?: () => void;
}

/** The dialog owns tentative selection. Only its primary button returns a value. */
export class ScopePicker extends Modal {
  private closed = false;
  private parent: string[] = [];
  private selected: string[];
  private preserve: boolean;
  private busy = false;
  private list?: PickerList;
  private query = "";
  private message = "";
  private results?: HTMLElement;
  private confirm?: HTMLButtonElement;

  constructor(app: App, private readonly options: PickerOptions) {
    super(app);
    this.selected = [...options.selected];
    this.preserve = !!options.preserveIdentity;
    this.parent = options.browse ? options.selected.slice(0, -1) : [];
  }

  override onOpen(): void { void this.read(this.parent); }

  private async read(parent: string[]): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true; this.parent = parent; this.list = undefined; this.query = ""; this.message = "正在读取…";
    this.render();
    try {
      this.list = await this.options.load([...parent]); this.message = "";
      if (this.selected.length && JSON.stringify(this.selected.slice(0, -1)) === JSON.stringify(parent) &&
        !this.list.names.includes(this.selected[this.selected.length - 1]!)) this.selected = [];
    }
    catch (error) { this.message = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }

  private render(): void {
    if (this.closed) return;
    this.titleEl.setText(this.options.title);
    this.contentEl.empty();
    this.contentEl.addClass("ima-scope-picker");
    this.modalEl.addClass("ima-palette-9");
    const top = this.contentEl.createDiv({ cls: "ima-picker-toolbar" });
    if (this.options.browse) {
      const parts = ["知识库", ...this.parent];
      parts.forEach((label, index) => {
        const b = top.createEl("button", { text: label, attr: { "aria-label": `返回 ${label}` } });
        b.disabled = this.busy || index === parts.length - 1;
        b.addEventListener("click", () => { this.selected = []; void this.read(this.parent.slice(0, index)); });
      });
    }
    const refresh = top.createEl("button", { text: "刷新" });
    refresh.disabled = this.busy;
    refresh.addEventListener("click", () => { void this.read(this.parent); });
    const search = this.contentEl.createEl("input", { attr: { type: "search", placeholder: "搜索名称", "aria-label": "搜索名称" } });
    search.value = this.query; search.disabled = this.busy;
    search.addEventListener("input", () => { this.query = search.value; this.renderResults(); });
    if (this.list?.complete === false) this.contentEl.createDiv({ text: "列出 IMA 中当前可见的知识库。未找到时，可在下方填写完整名称。", cls: "setting-item-description" });
    if (this.message) this.contentEl.createDiv({ text: this.message, attr: { role: "status" } });
    this.results = this.contentEl.createDiv({ cls: "ima-picker-results", attr: { role: "group", "aria-label": "可选目录" } });
    if (this.list?.complete === false) new Setting(this.contentEl).setName("完整知识库名称").addText(text => text
      .setPlaceholder("与 IMA 中的名称一致").onChange(value => { this.selected = value.trim() ? [value.trim()] : []; this.renderResults(); }));
    if (this.options.rename) new Setting(this.contentEl).setName("这是原来源改名")
      .setDesc("确认后沿用原同步记录。更换其他来源时请关闭。")
      .addToggle(toggle => toggle.setValue(this.preserve).onChange(value => { this.preserve = value; }));
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    this.confirm = actions.createEl("button", { text: "使用所选", cls: "mod-cta" });
    this.confirm.addEventListener("click", () => {
      if (this.busy || !this.selected.length) return;
      this.options.choose([...this.selected], this.preserve); this.close();
    });
    this.renderResults();
    silenceHoverHints(this.modalEl);
    if (!this.busy) search.focus();
  }

  private renderResults(): void {
    if (!this.results) return;
    this.results.empty();
    const same = (path: string[]) => JSON.stringify(path) === JSON.stringify(this.selected);
    const add = (label: string, path: string[], enter: boolean) => {
      const row = this.results!.createDiv({ cls: "ima-picker-row" });
      const pick = row.createEl("button", { cls: "ima-picker-option", attr: { "aria-pressed": String(same(path)) } });
      const icon = pick.createSpan(); setIcon(icon, this.options.browse ? "folder" : "book-open");
      pick.createSpan({ text: label });
      if (same(path)) { const check = pick.createSpan(); setIcon(check, "check"); }
      pick.addEventListener("click", () => { this.selected = path; this.renderResults(); });
      if (enter) {
        const open = row.createEl("button", { attr: { "aria-label": `打开 ${label}` } }); setIcon(open, "chevron-right");
        open.addEventListener("click", () => { this.selected = []; void this.read(path); });
      }
    };
    if (this.options.browse && this.parent.length && this.list) add("选择当前文件夹", this.parent, false);
    const names = this.list?.names.filter(name => name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())) ?? [];
    if (this.options.browse && this.parent.length >= 5) this.results.createDiv({ text: "已到可选目录的最深层级。", cls: "setting-item-description" });
    else names.forEach(name => add(name, [...this.parent, name], !!this.options.browse));
    if (this.list && !names.length) this.results.createDiv({ text: this.query ? "没有找到，换个名称试试。" : "没有子文件夹。", cls: "setting-item-description" });
    if (this.list?.ambiguousNames?.length) this.results.createDiv({ text: `以下同名目录无法唯一确认：${this.list.ambiguousNames.join("、")}`, cls: "setting-item-description" });
    if (this.confirm) this.confirm.disabled = this.busy || !this.list || !this.selected.length;
    silenceHoverHints(this.results);
  }

  override onClose(): void { this.closed = true; this.options.cancel?.(); this.contentEl.empty(); }
}
