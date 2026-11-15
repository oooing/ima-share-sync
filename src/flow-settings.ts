import { App, Modal, addIcon, setIcon } from "obsidian";
import { FLOW_OBSIDIAN_LOGO } from "./flow-brand";
import { silenceHoverHints } from "./quiet-labels";

export type FlowGroup = "source" | "sync" | "save";
export type FlowPanels = Record<FlowGroup, { basic: HTMLElement; advanced: HTMLElement }>;
const labels: Record<FlowGroup, string> = { source: "来源", sync: "同步规则", save: "保存" };
const folderId = "ima-flow-folder";
let flowLabelId = 0;
export function registerFlowIcon(): void {
  addIcon(folderId, '<path d="M15 22V15a6 6 0 0 1 6-6h28l8 8h33a7 7 0 0 1 7 7v49H15Z" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".25"/><path d="M8 31a7 7 0 0 1 7-7h23l9 8h50a7 7 0 0 1 7 7v35a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7Z" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-width="1.6"/>');
}
export interface FlowSummary {
  sourceTitle: string; sourcePath: string; syncTitle: string; syncDetail: string;
  saveTitle: string; savePath: string;
  sourceWarning?: string;
}
export function drawFlowMap(root: HTMLElement, read: () => FlowSummary, open: (group: FlowGroup) => void): () => void {
  const map = root.createDiv({ cls: "ima-flow-map", attr: { role: "group", "aria-label": "从 IMA 来源到 Obsidian 保存位置" } });
  const text = new Map<FlowGroup, { title: HTMLElement; detail: HTMLElement }>();
  let sourceNode: HTMLButtonElement;
  let sourceHint: HTMLElement;
  (["source", "sync", "save"] as const).forEach((group, index) => {
    if (index) { const arrow = map.createSpan({ cls: "ima-flow-connector", attr: { "aria-hidden": "true" } }); setIcon(arrow, "chevron-right"); }
    const labelId = `ima-flow-label-${++flowLabelId}`;
    const button = map.createEl("button", { cls: "ima-flow-node", attr: { type: "button", "aria-haspopup": "dialog", "aria-labelledby": labelId } });
    button.createSpan({ cls: "ima-visually-hidden", attr: { id: labelId },
      text: group === "source" ? "设置来源" : group === "save" ? "设置保存位置" : "设置同步规则" });
    button.createEl("h2", { text: labels[group] });
    if (group === "sync") {
      const art = button.createSpan({ cls: "ima-flow-sync-art", attr: { "aria-hidden": "true" } });
      setIcon(art.createSpan({ cls: "ima-flow-sync-ring" }), "refresh-cw");
    } else {
      const art = button.createSpan({ cls: "ima-flow-folder-art", attr: { "aria-hidden": "true" } });
      const frame = art.createSpan({ cls: "ima-flow-folder-frame" }); setIcon(frame, folderId);
      frame.querySelector("svg")?.setAttribute("viewBox", "0 0 112 90");
      const content = art.createSpan({ cls: "ima-flow-folder-content" });
      if (group === "source") setIcon(content, "folder");
      else content.createEl("img", { attr: { src: FLOW_OBSIDIAN_LOGO, alt: "" } });
    }
    text.set(group, { title: button.createEl("strong"), detail: button.createSpan({ cls: "ima-flow-path" }) });
    const hint = button.createSpan({ cls: "ima-flow-hint", text: group === "source" ? "选择来源" : group === "save" ? "选择位置" : "设置规则" });
    if (group === "source") { sourceNode = button; sourceHint = hint; }
    setIcon(hint.createSpan(), "chevron-right");
    button.addEventListener("click", () => open(group));
  });
  const update = () => {
    const v = read();
    text.get("source")!.title.setText(v.sourceTitle); text.get("source")!.detail.setText(v.sourcePath);
    sourceNode.toggleClass("ima-flow-source-error", Boolean(v.sourceWarning));
    sourceHint.setText(v.sourceWarning || "选择来源");
    setIcon(sourceHint.createSpan(), v.sourceWarning ? "alert-triangle" : "chevron-right");
    text.get("sync")!.title.setText(v.syncTitle); text.get("sync")!.detail.setText(v.syncDetail);
    text.get("save")!.title.setText(v.saveTitle); text.get("save")!.detail.setText(v.savePath);
  };
  silenceHoverHints(map);
  update(); return update;
}
export class FlowSettingsModal extends Modal {
  private level: "basic" | "advanced" = "basic";
  private body?: HTMLElement;
  private tabs = new Map<"basic" | "advanced", HTMLButtonElement>();
  private status?: HTMLElement;
  private footer?: HTMLElement;
  constructor(app: App, readonly group: FlowGroup, private panels: FlowPanels, private readonly done: () => void) { super(app); }
  override onOpen(): void {
    this.modalEl.addClass("ima-flow-ui", "ima-flow-modal", "ima-palette-9");
    this.titleEl.setText(this.group === "source" ? "来源设置" : this.group === "save" ? "保存设置" : "同步规则设置");
    const close = this.contentEl.createEl("button", { cls: "ima-flow-close", attr: { type: "button", "aria-label": "关闭设置弹窗" } });
    setIcon(close, "x"); close.addEventListener("click", () => this.close());
    const bar = this.contentEl.createDiv({ cls: "ima-flow-tabs", attr: { role: "tablist", "aria-label": "设置层级" } });
    for (const [level, name] of [["basic", "基本设置"], ["advanced", "高级设置"]] as const) {
      const tab = bar.createEl("button", { text: name, attr: { type: "button", role: "tab", id: "ima-flow-tab-" + level } });
      tab.addEventListener("click", () => { this.level = level; this.showPanel(); });
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); this.level = event.key === "Home" ? "basic" : event.key === "End" ? "advanced" : this.level === "basic" ? "advanced" : "basic";
        this.showPanel(); this.tabs.get(this.level)?.focus();
      });
      this.tabs.set(level, tab);
    }
    this.body = this.contentEl.createDiv({ cls: "ima-flow-modal-body" });
    this.footer = this.contentEl.createDiv({ cls: "ima-flow-modal-footer is-empty" });
    this.status = this.footer.createSpan({ attr: { role: "status", "aria-live": "polite" } });
    this.showPanel();
  }
  replacePanels(panels: FlowPanels): void { this.panels = panels; this.showPanel(); }
  setStatus(text: string): void { this.status?.setText(text); this.footer?.toggleClass("is-empty", !text); }
  private showPanel(): void {
    if (!this.body) return;
    this.body.empty();
    const panel = this.panels[this.group][this.level];
    panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", "ima-flow-tab-" + this.level);
    this.body.appendChild(panel);
    this.tabs.forEach((tab, key) => { tab.setAttribute("aria-selected", String(key === this.level)); tab.tabIndex = key === this.level ? 0 : -1; });
    silenceHoverHints(this.modalEl);
  }
  override onClose(): void { this.contentEl.empty(); this.done(); }
}
