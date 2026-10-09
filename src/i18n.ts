import { getLanguage } from "obsidian";

/**
 * IMA Share Sync - i18n 多语言支持
 * 支持语言：中文 (zh) 与 英文 (en)
 * 规则：默认按 Obsidian 的语言显示，非中文显示英文，英文显示英文。
 */

export type SupportedLanguage = "zh" | "en";

export interface I18nStrings {
  // 通用与顶部卡片
  supportTitle: string;
  supportDesc: string;
  supportBtn: string;
  supportAria: string;
  windowsWarning: string;
  versionText: (ver: string) => string;

  // 标签栏
  tabScope: string;
  tabMarkdown: string;
  tabNotifications: string;
  tabGeneral: string;

  // 基础设置 (General)
  languageName: string;
  languageDesc: string;
  langAuto: string;
  langZh: string;
  langEn: string;
  autoSyncName: string;
  autoSyncDesc: string;
  contentModeName: string;
  contentModeDesc: string;
  contentModeGeneral: string;
  contentModeSpeedReader: string;
  allowForegroundName: string;
  allowForegroundDesc: string;
  resetConsentName: string;
  resetConsentDesc: string;
  resetConsentBtn: string;
  resetConsentNotice: string;

  // 同步范围 (Scope)
  kbName: string;
  kbDesc: string;
  kbPlaceholder: string;
  sourceFolderName: string;
  sourceFolderDesc: string;
  sourceFolderPlaceholder: string;
  destPathName: string;
  destPathDesc: string;
  destPathPlaceholder: string;
  overwriteName: string;
  overwriteDesc: string;
  maxItemsName: string;
  maxItemsDesc: string;

  modeAllTitle: string;
  modeAllDesc: string;
  modeRecentTitle: string;
  modeRecentDesc: (count: number) => string;
  cascadeHeader: string;
  cascadePreset: (count: number) => string;
  badgeDefault: string;
  cascadeCustomPrefix: string;
  cascadeCustomSuffix: string;
  cascadeFooter: string;

  includeFolderOption: string;
  includeFolderDescTrue: (name: string) => string;
  includeFolderDescFalse: string;
  includeSubfoldersOption: string;
  includeSubfoldersDescTrue: string;
  includeSubfoldersDescFalse: string;

  advancedSummary: string;
  ruleSettingName: string;
  ruleSettingDesc: string;
  maxFoldersName: string;
  maxFoldersDescAll: string;
  maxFoldersDescRecent: string;
  maxFolderDepthName: string;
  maxFolderDepthDesc: string;
  sortSettingName: string;
  sortSettingDesc: string;
  titleFilterName: string;
  titleFilterDesc: string;
  titleFilterAll: string;
  titleFilterContains: string;
  titleFilterPrefix: string;
  titleFilterRegex: string;
  filterContentName: string;
  filterContentDesc: string;

  summaryTitleAll: string;
  summaryTitleRecent: (count: number) => string;
  summaryTitleLegacy: (count: number) => string;
  scopeDetailAll: (folder: string, depth: number) => string;
  scopeDetailRecent: (folder: string, maxFolders: number, depth: number) => string;
  scopeDetailCurrentOnly: (folder: string) => string;

  unitFolders: (count: number) => string;
  unitLevels: (depth: number) => string;

  // 通知提醒 (Notifications)
  noticesHeading: string;
  notificationsEnabledName: string;
  notificationsEnabledDesc: string;
  notifyAutoSuccessName: string;
  notifyAutoSuccessDesc: string;
  notifyAutoFailureName: string;
  notifyAutoFailureDesc: string;
  notifyManualResultName: string;
  notifyManualResultDesc: string;
  showErrorBadgeName: string;
  showErrorBadgeDesc: string;
  showOperationBeforeName: string;
  showOperationBeforeDesc: string;
  showOperationAfterName: string;
  showOperationAfterDesc: string;
  saveSettingsError: string;

  // 文档转换 (Markdown)
  enableMarkdownName: string;
  enableMarkdownDesc: string;
  markdownScopeName: string;
  markdownScopeDesc: string;
  markdownScopeAll: string;
  markdownScopeText: string;
  markdownScopeImage: string;
  embedPdfLinkName: string;
  embedPdfLinkDesc: string;
  manualScanName: string;
  manualScanDesc: string;
  manualScanBtn: string;

  // 命令与提示 (Commands & UI)
  ribbonTooltip: string;
  cmdSyncNow: string;
  cmdCancelSync: string;
  noticeAlreadyRunning: string;
  noticeWindowsOnly: string;
  noticeAnotherWindowRunning: string;
  noticeCanceling: string;
  noticeNoRunning: string;
  historyTitle: string;
  failedToOpenHistory: string;
}

export const zhStrings: I18nStrings = {
  // 通用与顶部卡片
  supportTitle: "喜欢这个插件？",
  supportDesc: "如果你觉得 IMA Share Sync 对你有帮助，请点赞和分享，让更多人看到。",
  supportBtn: "去 GitHub 点星",
  supportAria: "打开 IMA Share Sync 的 GitHub 仓库，手动点星支持插件",
  windowsWarning: "IMA Share Sync 依赖 Windows UI 自动化和 PowerShell，仅支持 Windows。",
  versionText: (ver) => `当前版本 v${ver}`,

  // 标签栏
  tabScope: "同步范围",
  tabMarkdown: "文档转换",
  tabNotifications: "通知提醒",
  tabGeneral: "基础设置",

  // 基础设置 (General)
  languageName: "界面语言",
  languageDesc: "设置插件界面的显示语言。",
  langAuto: "跟随软件（默认）",
  langZh: "简体中文",
  langEn: "English",
  autoSyncName: "启动同步",
  autoSyncDesc: "软件启动后自动检查并同步。",
  contentModeName: "同步模式",
  contentModeDesc: "支持通用同步与速看兼容排版。",
  contentModeGeneral: "通用模式",
  contentModeSpeedReader: "速看模式",
  allowForegroundName: "窗口置顶",
  allowForegroundDesc: "后台读取受阻时允许短暂置前。",
  resetConsentName: "重置授权",
  resetConsentDesc: "清除授权，下次同步时重新询问。",
  resetConsentBtn: "重置授权",
  resetConsentNotice: "IMA Share Sync 授权已重置。下次同步时会重新询问。",

  // 同步范围 (Scope)
  kbName: "知识库",
  kbDesc: "填写 IMA 侧边栏的知识库名。",
  kbPlaceholder: "例如：我的知识库",
  sourceFolderName: "源文件夹",
  sourceFolderDesc: "填写 IMA 中要同步的文件夹名。",
  sourceFolderPlaceholder: "例如：每日速看",
  destPathName: "保存位置",
  destPathDesc: "同步内容在当前仓库的存放目录。",
  destPathPlaceholder: "例如：IMA Share Sync",
  overwriteName: "同名覆盖",
  overwriteDesc: "同名且内容有更新时替换旧笔记。",
  maxItemsName: "检查篇数",
  maxItemsDesc: "每次检查最近 1–30 篇内容。",

  modeAllTitle: "全部同步",
  modeAllDesc: "扫描并下载所有未同步的文件。",
  modeRecentTitle: "同步最新",
  modeRecentDesc: (count) => `最新 ${count} 份文件（默认）`,
  cascadeHeader: "同步最新 / 数量预设",
  cascadePreset: (count) => `最新 ${count} 份文件`,
  badgeDefault: "默认",
  cascadeCustomPrefix: "最新的",
  cascadeCustomSuffix: "份文件",
  cascadeFooter: "按时间顺序检查，已下载的文件自动跳过",

  includeFolderOption: "保留目录",
  includeFolderDescTrue: (name) => `在保存位置自动创建${name ? `「${name}」` : "同名"}文件夹。`,
  includeFolderDescFalse: "抓取内容直接存入保存位置，不建新目录。",
  includeSubfoldersOption: "包含子级",
  includeSubfoldersDescTrue: "同时检查并同步子文件夹中的文件。",
  includeSubfoldersDescFalse: "仅同步当前目录，不进入子文件夹。",

  advancedSummary: "高级设置",
  ruleSettingName: "数量规则",
  ruleSettingDesc: "跳过或失败，不补抓更旧的文件。",
  maxFoldersName: "目录上限",
  maxFoldersDescAll: "全部同步时自动检查所有子文件夹。",
  maxFoldersDescRecent: "最多检查的子文件夹数量上限。",
  maxFolderDepthName: "扫描深度",
  maxFolderDepthDesc: "向下查找子文件夹的最多层数。",
  sortSettingName: "排序规则",
  sortSettingDesc: "文件夹与文件按更新时间优先排序。",
  titleFilterName: "标题筛选",
  titleFilterDesc: "仅同步标题符合条件的文件。",
  titleFilterAll: "全部标题",
  titleFilterContains: "包含关键词",
  titleFilterPrefix: "指定前缀",
  titleFilterRegex: "正则表达式（高级）",
  filterContentName: "筛选内容",
  filterContentDesc: "输入要匹配的关键词或正则。",

  summaryTitleAll: "全部同步（穷尽模式）：自动同步全部未下载文件",
  summaryTitleRecent: (count) => `每次最多检查 ${count} 个文件`,
  summaryTitleLegacy: (count) => `每次最多检查 ${count} 个文件（旧规则）`,
  scopeDetailAll: (folder, depth) => `「${folder}」下：全部同步模式下检查所有子文件夹，向下最多 ${depth} 层。`,
  scopeDetailRecent: (folder, maxFolders, depth) => `「${folder}」下：最近更新的最多 ${maxFolders} 个文件夹，向下最多 ${depth} 层。没有子文件夹时取当前文件夹。`,
  scopeDetailCurrentOnly: (folder) => `只检查「${folder}」内的文件，不进入子文件夹。`,

  unitFolders: (count) => `${count} 个`,
  unitLevels: (depth) => `${depth} 层`,

  // 通知提醒 (Notifications)
  noticesHeading: "通知提醒",
  notificationsEnabledName: "开启通知",
  notificationsEnabledDesc: "控制桌面弹窗与气泡提醒总开关。",
  notifyAutoSuccessName: "成功通知",
  notifyAutoSuccessDesc: "自动同步成功后弹出完成提示。",
  notifyAutoFailureName: "失败通知",
  notifyAutoFailureDesc: "同步遇到失败或冲突时弹出提示。",
  notifyManualResultName: "手动提醒",
  notifyManualResultDesc: "手动点击同步后显示操作结果。",
  showErrorBadgeName: "角标提醒",
  showErrorBadgeDesc: "有同步异常时在图标上标黄点。",
  showOperationBeforeName: "启动提示",
  showOperationBeforeDesc: "自动同步前倒数 5 秒，可推迟。",
  showOperationAfterName: "结果卡片",
  showOperationAfterDesc: "完成后在桌面浮窗显示同步摘要。",
  saveSettingsError: "提醒设置未能保存，重启后可能恢复原设置。请检查仓库写入权限。",

  // 文档转换 (Markdown)
  enableMarkdownName: "转为 MD",
  enableMarkdownDesc: "下载 PDF 后自动生成排版 MD。",
  markdownScopeName: "转换范围",
  markdownScopeDesc: "选择要转换格式的 PDF 类型。",
  markdownScopeAll: "全部文件",
  markdownScopeText: "仅文字版",
  markdownScopeImage: "仅图片版",
  embedPdfLinkName: "插入双链",
  embedPdfLinkDesc: "在 MD 正文顶部关联原 PDF 链接。",
  manualScanName: "手动补全",
  manualScanDesc: "扫描当前文件夹并补齐遗漏 MD。",
  manualScanBtn: "立即补全",

  // 命令与提示 (Commands & UI)
  ribbonTooltip: "打开 IMA Share Sync",
  cmdSyncNow: "立即同步",
  cmdCancelSync: "取消同步",
  noticeAlreadyRunning: "IMA Share Sync 正在运行，请稍候。",
  noticeWindowsOnly: "IMA Share Sync 仅支持 Windows。",
  noticeAnotherWindowRunning: "另一个窗口正在运行 IMA Share Sync。",
  noticeCanceling: "正在取消 IMA Share Sync…",
  noticeNoRunning: "当前没有正在运行的 IMA Share Sync。",
  historyTitle: "同步日志",
  failedToOpenHistory: "无法打开同步日志，请重新打开插件侧栏。",
};

export const enStrings: I18nStrings = {
  // General & Support Card
  supportTitle: "Enjoying this plugin?",
  supportDesc: "If you find IMA Share Sync helpful, please star and share it so more people can find it.",
  supportBtn: "Star on GitHub",
  supportAria: "Open IMA Share Sync repository on GitHub to star the project",
  windowsWarning: "IMA Share Sync relies on Windows UI Automation and PowerShell and only supports Windows.",
  versionText: (ver) => `Version v${ver}`,

  // Tabs
  tabScope: "Sync Scope",
  tabMarkdown: "Convert",
  tabNotifications: "Notices",
  tabGeneral: "General",

  // General Settings
  languageName: "Language",
  languageDesc: "Select interface display language.",
  langAuto: "Follow Obsidian (Default)",
  langZh: "简体中文",
  langEn: "English",
  autoSyncName: "Startup Sync",
  autoSyncDesc: "Check and sync automatically after Obsidian starts.",
  contentModeName: "Sync Mode",
  contentModeDesc: "Support general sync and legacy brief layouts.",
  contentModeGeneral: "General",
  contentModeSpeedReader: "Speed Reader",
  allowForegroundName: "Foreground",
  allowForegroundDesc: "Briefly bring window to front if background read is blocked.",
  resetConsentName: "Reset Access",
  resetConsentDesc: "Clear authorization and ask again on next sync.",
  resetConsentBtn: "Reset Access",
  resetConsentNotice: "IMA Share Sync access reset. It will ask again next sync.",

  // Scope Settings
  kbName: "Knowledge Base",
  kbDesc: "Knowledge base name in IMA sidebar.",
  kbPlaceholder: "e.g. My Knowledge Base",
  sourceFolderName: "Source Folder",
  sourceFolderDesc: "Folder name in IMA to sync.",
  sourceFolderPlaceholder: "e.g. Daily Brief",
  destPathName: "Save Location",
  destPathDesc: "Storage folder inside current vault.",
  destPathPlaceholder: "e.g. IMA Share Sync",
  overwriteName: "Overwrite",
  overwriteDesc: "Replace old file if note has updates.",
  maxItemsName: "Items to Check",
  maxItemsDesc: "Check latest 1–30 items per run.",

  modeAllTitle: "Sync All",
  modeAllDesc: "Scan and download all unsynced files.",
  modeRecentTitle: "Sync Recent",
  modeRecentDesc: (count) => `Latest ${count} files (default)`,
  cascadeHeader: "Sync Recent / Presets",
  cascadePreset: (count) => `Latest ${count} files`,
  badgeDefault: "Default",
  cascadeCustomPrefix: "Latest",
  cascadeCustomSuffix: "files",
  cascadeFooter: "Checked in order; already downloaded files are skipped",

  includeFolderOption: "Keep Folder",
  includeFolderDescTrue: (name) => `Create "${name || "folder"}" subfolder inside save location.`,
  includeFolderDescFalse: "Save directly to destination without creating folder.",
  includeSubfoldersOption: "Subfolders",
  includeSubfoldersDescTrue: "Also check and sync files in subfolders.",
  includeSubfoldersDescFalse: "Only sync current folder, ignore subfolders.",

  advancedSummary: "Advanced",
  ruleSettingName: "Count Rule",
  ruleSettingDesc: "Skipped or failed items will not be backfilled.",
  maxFoldersName: "Folder Limit",
  maxFoldersDescAll: "Automatically check all subfolders in Sync All mode.",
  maxFoldersDescRecent: "Maximum number of subfolders to inspect.",
  maxFolderDepthName: "Scan Depth",
  maxFolderDepthDesc: "Max folder hierarchy levels to inspect.",
  sortSettingName: "Sort Order",
  sortSettingDesc: "Folders and files sorted by updated time first.",
  titleFilterName: "Title Filter",
  titleFilterDesc: "Only sync files matching specific filter.",
  titleFilterAll: "All titles",
  titleFilterContains: "Contains keyword",
  titleFilterPrefix: "Starts with prefix",
  titleFilterRegex: "Regex (Advanced)",
  filterContentName: "Filter Text",
  filterContentDesc: "Enter keyword or regex to match.",

  summaryTitleAll: "Sync All: Automatically sync all unsynced files",
  summaryTitleRecent: (count) => `Check up to ${count} files per run`,
  summaryTitleLegacy: (count) => `Check up to ${count} files per run (Legacy)`,
  scopeDetailAll: (folder, depth) => `Under "${folder}": Check all subfolders up to ${depth} levels deep in Sync All mode.`,
  scopeDetailRecent: (folder, maxFolders, depth) => `Under "${folder}": Up to ${maxFolders} recently updated folders, ${depth} levels deep.`,
  scopeDetailCurrentOnly: (folder) => `Only check files in "${folder}", ignoring subfolders.`,

  unitFolders: (count) => `${count}`,
  unitLevels: (depth) => `${depth} levels`,

  // Notifications
  noticesHeading: "Notifications",
  notificationsEnabledName: "Enable Notice",
  notificationsEnabledDesc: "Master switch for desktop popups and notifications.",
  notifyAutoSuccessName: "Success Alert",
  notifyAutoSuccessDesc: "Show summary popup when auto sync completes successfully.",
  notifyAutoFailureName: "Failure Alert",
  notifyAutoFailureDesc: "Show summary popup when sync fails or encounters conflicts.",
  notifyManualResultName: "Manual Alert",
  notifyManualResultDesc: "Show operation result after manual sync.",
  showErrorBadgeName: "Badge Alert",
  showErrorBadgeDesc: "Show yellow dot on icon when errors occur.",
  showOperationBeforeName: "Pre-Sync Alert",
  showOperationBeforeDesc: "Count down 5s before auto sync, allow defer.",
  showOperationAfterName: "Result Card",
  showOperationAfterDesc: "Show desktop card summary upon completion.",
  saveSettingsError: "Failed to save notice preferences. Please check write permissions.",

  // Document Conversion
  enableMarkdownName: "Convert to MD",
  enableMarkdownDesc: "Automatically convert PDF to Markdown note.",
  markdownScopeName: "Convert Scope",
  markdownScopeDesc: "Select PDF types to convert.",
  markdownScopeAll: "All files",
  markdownScopeText: "Text only",
  markdownScopeImage: "Images only",
  embedPdfLinkName: "Embed Link",
  embedPdfLinkDesc: "Embed original PDF link at the top of note.",
  manualScanName: "Manual Fill",
  manualScanDesc: "Scan folder and generate missing Markdown notes.",
  manualScanBtn: "Fill Now",

  // Commands & Notices
  ribbonTooltip: "Open IMA Share Sync",
  cmdSyncNow: "Sync now",
  cmdCancelSync: "Cancel sync",
  noticeAlreadyRunning: "IMA Share Sync is running, please wait.",
  noticeWindowsOnly: "IMA Share Sync only supports Windows.",
  noticeAnotherWindowRunning: "Another window is running IMA Share Sync.",
  noticeCanceling: "Canceling IMA Share Sync…",
  noticeNoRunning: "No IMA Share Sync is currently running.",
  historyTitle: "Sync History",
  failedToOpenHistory: "Failed to open sync history. Please reopen sidebar.",
};

/**
 * 获取当前语言
 * 支持手动选择语言（zh / en），或选择 auto 默认按照 Obsidian 的语言显示（非中文显示英文，英文显示英文）。
 */
export function getAppLanguage(preference?: "auto" | "zh" | "en"): SupportedLanguage {
  if (preference === "zh") return "zh";
  if (preference === "en") return "en";

  let lang: string | null = null;
  try {
    if (typeof getLanguage === "function") lang = getLanguage();
  } catch {
    // ignore
  }

  if (!lang) {
    try {
      const moment = (window as unknown as { moment?: { locale?: () => string } })?.moment;
      if (moment && typeof moment.locale === "function") {
        lang = moment.locale();
      }
    } catch {
      // ignore
    }
  }

  if (!lang) {
    try {
      if (typeof navigator !== "undefined" && navigator.language) {
        lang = navigator.language;
      }
    } catch {
      // ignore
    }
  }

  // 若完全未检测到（如未配置的 Node 环境），默认走中文以确保单元测试基准稳定
  if (!lang) {
    return "zh";
  }

  const lower = lang.toLowerCase();
  return lower.startsWith("zh") ? "zh" : "en";
}

/**
 * 获取当前国际化字符串对象
 */
export function getStrings(preference?: "auto" | "zh" | "en"): I18nStrings {
  return getAppLanguage(preference) === "zh" ? zhStrings : enStrings;
}
