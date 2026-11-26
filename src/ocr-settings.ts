import { App, Modal, Notice, SecretComponent, Setting, type ToggleComponent } from "obsidian";
import { getAppLanguage } from "./i18n";
import { OCR_MODELS, type LocalOcrMode, type OcrProvider } from "./pdf-ocr-core";

const BAIDU_TOKEN_URL = "https://aistudio.baidu.com/account/accessToken";
const BAIDU_QUOTA_URL = "https://ai.baidu.com/ai-doc/AISTUDIO/Xmjclapam";
const LOCAL_SETUP_URL = "https://github.com/oooing/ima-share-sync/blob/main/docs/OCR.md#local-ocr-setup";

export interface OcrSettings {
  imageOcrEnabled: boolean;
  ocrProvider: OcrProvider;
  ocrSecretId: string;
  language?: "auto" | "zh" | "en";
}

interface SettingsHost {
  app: App;
  settings: OcrSettings;
  saveSettings(): Promise<void>;
  cancelMarkdownConversion(): void;
  readonly supportsLocalOcr: boolean;
  isLocalOcrReady(mode: LocalOcrMode): Promise<boolean>;
}

export function renderOcrSettings(container: HTMLElement, host: SettingsHost, updateDashboard: () => void): void {
  const en = getAppLanguage(host.settings.language) === "en";
  const section = container.createDiv({ cls: "ima-ocr-settings" });
  let imageToggle: ToggleComponent | undefined;

  const commit = async <K extends "imageOcrEnabled" | "ocrProvider" | "ocrSecretId">(key: K, value: OcrSettings[K]) => {
    if (host.settings[key] === value) return true;
    const previous = host.settings[key];
    host.cancelMarkdownConversion();
    host.settings[key] = value;
    if (key !== "ocrSecretId") updateChoices();
    if (key === "imageOcrEnabled") updateDashboard();
    try {
      await host.saveSettings();
      return true;
    } catch {
      if (host.settings[key] === value) {
        host.settings[key] = previous;
        if (key !== "ocrSecretId") updateChoices();
        if (key === "imageOcrEnabled") updateDashboard();
      }
      new Notice(en ? "Could not save OCR settings." : "OCR 设置保存失败。");
      return false;
    }
  };

  new Setting(section)
    .setName(en ? "Image OCR" : "图片 OCR")
    .setDesc(en ? "Off by default. Turn on to manually recognize scanned PDF pages." : "默认关闭。需要识别扫描页时，手动开启并补转。")
    .addToggle(toggle => {
      imageToggle = toggle;
      toggle.onChange(async value => { await commit("imageOcrEnabled", value); });
    });

  const options = section.createEl("fieldset", { cls: "ima-ocr-choices" });
  const choices: { mode: OcrProvider; radio: HTMLInputElement; details: HTMLElement }[] = [];
  options.createEl("legend", { text: en ? "Recognition method" : "识别方式" });
  const engines: { mode: OcrProvider; label: string; description: string }[] = [
    { mode: "api", label: en ? "Baidu cloud" : "百度云端解析",
      description: en ? "For research reports and tables. No local inference." : "适合研报和复杂表格；本机不跑模型。" },
    { mode: "local", label: en ? "Local layout" : "本地版面识别",
      description: en ? "Offline. Preserves layout; needs Vulkan and 6 GiB of available memory." : "不上传。适合复杂版面；需 Vulkan 显卡和 6 GiB 可用内存。" },
    { mode: "local-mobile", label: en ? "Local lightweight text" : "本地轻量识字",
      description: en ? "Offline, lower memory use. Text search only; check tables against the PDF." : "不上传，占用较低。适合正文检索，不还原表格行列。" },
  ];
  for (const {mode, label, description} of engines) {
    const row = options.createDiv({ cls: "ima-ocr-method" });
    const option = row.createEl("label", { cls: "ima-ocr-choice" });
    const radio = option.createEl("input", { attr: { type: "radio", name: "ima-share-sync-ocr-engine", value: mode } });
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      void commit("ocrProvider", mode);
      // A taller section above may have collapsed; move only if the choice is now offscreen.
      radio.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    const copy = option.createSpan();
    copy.createSpan({ text: label });
    if (mode === "api") copy.createSpan({ cls: "ima-ocr-recommended", text: en ? "Recommended" : "推荐" });
    copy.createEl("small", { text: `${OCR_MODELS[mode]} · ${description}` });
    const details = row.createDiv({ cls: "ima-ocr-method-details" });
    choices.push({ mode, radio, details });
  }

  const initialized = new Set<OcrProvider>();
  function updateChoices(): void {
    const { imageOcrEnabled, ocrProvider } = host.settings;
    imageToggle?.setValue(imageOcrEnabled);
    options.hidden = !imageOcrEnabled;
    for (const { mode, radio, details } of choices) {
      const selected = mode === ocrProvider;
      radio.checked = selected;
      details.hidden = !imageOcrEnabled || !selected;
      if (details.hidden || initialized.has(mode)) continue;
      initialized.add(mode);
      if (mode === "api") renderCloudSettings(details, host, en, id => commit("ocrSecretId", id));
      else renderLocalSettings(details, host, en, mode);
    }
  }
  updateChoices();
}

function renderCloudSettings(details: HTMLElement, host: SettingsHost, en: boolean, saveSecret: (id: string) => Promise<boolean>): void {
  const tokenSetting = new Setting(details).setName(en ? "Baidu AI Studio API token" : "百度 AI Studio API 令牌")
    .setDesc(en ? "Required for cloud OCR. The full PDF is sent only after you confirm each batch."
      : "云端补转必须配置令牌。每轮确认后才会发送整份 PDF。");
  if (host.app.secretStorage) {
    const secret = new SecretComponent(host.app, tokenSetting.controlEl).setValue(host.settings.ocrSecretId);
    secret.onChange(async id => {
      if (!(await saveSecret(id))) secret.setValue(host.settings.ocrSecretId);
    });
  } else {
    tokenSetting.setDesc(en ? "Update Obsidian to use secret storage." : "请更新 Obsidian 以使用密钥存储。");
  }
  const guide = details.createDiv({ cls: "setting-item-description ima-ocr-cloud-guide" });
  const setup = guide.createDiv();
  setup.createEl("a", {
    text: en ? "Get your AI Studio token" : "获取百度访问令牌",
    attr: { href: BAIDU_TOKEN_URL, target: "_blank", rel: "noopener noreferrer" },
  });
  setup.createSpan({ text: en ? " → Add or select it in Obsidian’s secret store above." : " → 回到这里，在上方密钥库新建或选择令牌。" });
  const quota = guide.createDiv();
  quota.createSpan({ text: en ? "Free quota: up to 20,000 pages per user, per model, per day. " : "免费额度：每位用户、每个模型每天最高 20,000 页。"});
  quota.createEl("a", {
    text: en ? "Baidu’s current quota rules" : "以百度配额规则为准",
    attr: { href: BAIDU_QUOTA_URL, target: "_blank", rel: "noopener noreferrer" },
  });
}

function renderLocalSettings(details: HTMLElement, host: SettingsHost, en: boolean, mode: LocalOcrMode): void {
  const setup = new Setting(details).setName(en ? "Local model" : "本地模型");
  if (!host.supportsLocalOcr) {
    setup.setDesc(en ? "Windows desktop only." : "本地 OCR 仅支持 Windows 桌面端。");
    return;
  }
  const checkText = en ? "Checking installation…" : "正在检查安装…";
  const readyText = en ? "Model files found. Runs only on manual conversion." : "已找到模型文件，仅在手动补转时运行。";
  const requiredText = en ? "Not ready. Follow the guide to install outside Obsidian, then check again."
    : "尚未就绪。请按指引在 Obsidian 外安装，再检查环境。";
  setup.addButton(button => {
    const check = async () => {
      setup.setDesc(checkText);
      button.setDisabled(true);
      try {
        setup.setDesc(await host.isLocalOcrReady(mode) ? readyText : requiredText);
      } finally {
        button.setDisabled(false);
      }
    };
    button.setButtonText(en ? "Check environment" : "检查环境").onClick(() => { void check(); });
    void check();
  });
  details.createEl("a", {
    cls: "setting-item-description",
    text: en ? "Local OCR setup guide" : "查看手动安装指引",
    attr: { href: LOCAL_SETUP_URL, target: "_blank", rel: "noopener noreferrer" },
  });
}

class ConfirmOcrModal extends Modal {
  private answered = false;
  constructor(app: App, private heading: string, private message: string, private button: string,
    private answer: (value: boolean) => void, private signal?: AbortSignal) { super(app); }
  private abort = () => this.close();
  override onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl).addButton(button => button.setButtonText("取消 / cancel").onClick(() => this.close()))
      .addButton(button => button.setButtonText(this.button).setCta().onClick(() => {
        if (this.signal?.aborted) { this.close(); return; }
        this.answered = true; this.answer(true); this.close();
      }));
    this.signal?.addEventListener("abort", this.abort, { once: true });
    if (this.signal?.aborted) this.close();
  }
  override onClose(): void {
    this.signal?.removeEventListener("abort", this.abort);
    if (!this.answered) { this.answered = true; this.answer(false); }
    this.contentEl.empty();
  }
}
export function confirmOcr(app: App, heading: string, message: string, button: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => new ConfirmOcrModal(app, heading, message, button, resolve, signal).open());
}
