# IMA Share Sync

A Windows-only Obsidian plugin that imports text articles from IMA shared knowledge-base folders into Markdown notes using the locally installed IMA desktop app. No other Obsidian plugin is required.

> This is an independent community project and is not affiliated with or endorsed by Tencent or IMA.

The display name is **IMA Share Sync**. The internal plugin ID remains
`ima-speed-sync` for compatibility with existing settings, workspace views,
and synchronized-note metadata.

## Why this plugin exists

Some shared or subscribed IMA knowledge-base entries expose only limited content through APIs. This plugin reads the article text visible in the signed-in Windows desktop application and stores it in the user's own vault.

Two extraction modes are available:

- **通用文字 (General text)**: the default for new installations. Accepts arbitrary titles, short notes and text without a table of contents or update date. Optional literal keyword, prefix or advanced regular-expression filters are applied before the recent-article limit.
- **速看预设 (Legacy preset)**: existing installations retain their current scope after upgrading. This mode expects `速看-####` titles, an update marker and the existing table-of-contents structure, and keeps the specialized formatting and completeness checks. Change modes explicitly in settings when ready to expand the scope.

IMA interface changes can temporarily break extraction.

The **number of recent articles to check** limits how many matching entries are
taken from the top of the IMA folder in one run; it is not a promise to create
that many new notes. The top of the folder represents the most recently shared
or created entries, so an older-dated article shared again today remains
eligible. Titles within that candidate batch are processed in title-date order
when a date can be parsed. For example, when the limit is 7 and three of those
seven titles already exist in no-overwrite mode, the run creates at most four
notes and does not continue farther back to fill the quota.

Loaded text windows are reused only when they contain both a section heading
and its following boundary. Incomplete sections still require a TOC jump or
overlapping intermediate reads. The final section is checked with downward
mouse-wheel events and two stable bottom observations, because Chromium can
report an invalid UIA scroll percentage above 100%. Tail failures retry locally;
text-boundary/overlap failures do not restart the entire article. Extraction
does not use the clipboard or assume that Select All includes virtualized text.

## Requirements

- Windows 10 or newer;
- Obsidian desktop 1.11.4 or newer;
- the IMA desktop app installed and signed in;
- access to the configured IMA knowledge base and folder.

The plugin does not support macOS, Linux, Android, or iOS.

## Installation and setup

1. Install and enable the plugin.
2. Open **Settings → IMA Share Sync**.
3. Enter the exact IMA knowledge-base and folder names.
4. Choose a vault-relative destination folder.
5. Run **IMA Share Sync: 立即同步**.
6. Review and accept the local automation disclosure on the first run.

New notes keep the original IMA title instead of inserting or rewriting dates. Characters that cannot be used safely in Windows and macOS filenames are replaced with visually similar full-width characters.

The **Overwrite files with the same name** setting is disabled by default. Legacy mode retains its previous filename-based behavior. General mode separates article identity from filenames: an accessible article-card ID plus knowledge-base scope identifies a source, while a same-name file with a different or unknown source is always protected. Enabling overwrite only permits updating a confirmed same source. If no usable ID is available, an exact-content fingerprint is a conservative fallback, not proof that a renamed/edited article is the same source. It never authorizes overwriting uncertain content. General-mode metadata does not automatically re-identify old speed-reader notes.

In no-overwrite mode, already-saved source IDs are skipped before opening the article; source updates are intentionally not checked. A deleted local file disappears from that skip index and is eligible again. If IMA changes its card IDs, uncertain same-name entries are reported as conflicts rather than silently overwritten.

The sidebar shows 20 articles per page. Recognizable title dates are ordered newest first, followed by undated titles ordered by valid source dates (when cached) or local creation time. No year or date is inserted into filenames. Existing synchronized files are not renamed automatically, which avoids breaking links. Obsidian's native file explorer has its own sort setting.

### 同步提醒与记录

设置页的“同步提醒”提供以下开关：

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| 启用同步提醒 | 开启 | 总开关；关闭后不显示气泡或图标异常标记 |
| 自动同步成功提醒 | 关闭 | 开启后自动同步成功也显示汇总 |
| 自动同步失败提醒 | 开启 | 整轮失败、部分文章失败、同名冲突均汇总提醒一次 |
| 手动同步结果提醒 | 开启 | 控制手动同步结果及操作提示，包含失败提醒 |
| 图标异常标记 | 开启 | 表示未读异常；点击带黄点的图标、查看同步记录或异常详情后消除，已读状态跨重启保留；下一轮异常会重新亮起 |
| 操作前提示 | 开启 | 自动同步提前 5 秒告知，可延后或取消；手动同步立即开始，不倒计时 |
| 操作结束提示 | 开启 | 原卡片显示结果，成功/取消 5 秒后收起；异常保留至关闭 |

桌面卡片使用 Windows 原生 WPF 小窗口，显示在主屏工作区右下角，不主动抢焦点；开始前倒计时在卡片实际显示后才计时。运行中持续显示步骤和真实检查进度，停止后等待提取进程退出再显示结果。结束卡片优先于结果气泡；关闭“操作结束提示”后，仍按上方三个气泡提醒开关决定是否通知。总开关关闭时不显示开始/结束提示，但保留运行中的停止控件。延后仅在当前插件会话有效，手动再次同步或卸载插件会取消延后任务。卡片启动失败会阻止自动操作，避免静默操作桌面。

同步面板的“同步日志”在插件侧栏内展开，不弹独立窗口；再次点击入口或“收起”可折叠。日志按新到旧、每页 20 条展示，不再因为新增记录而删除旧日志。正常打开时各条详情收起；从错误提醒或“查看本次异常”进入时，在侧栏中直接跳到并展开对应记录，仍可翻页查看其他历史。收起不删除日志，重启后可继续查看。除结果和错误原因外，取消、推迟、未授权及其他任务占用导致未开始的尝试也会记录；重复点击正在运行的任务不创建新一轮。旧版已丢弃的记录无法补回。

记录随插件配置保存在仓库的 `data.json` 中，不单独上传；仓库备份或同步可能包含这些记录。关闭提醒不影响同步和记录，也不会关闭必要的首次桌面操作授权确认。设置变更立即影响正在运行任务的最终提醒；重启只恢复记录和标记，不重放旧气泡。

### Low-interference operation

- Title filtering and source-ID skipping happen before opening articles.
- Short, verified non-scrolling bodies do not scroll. Long generic text uses one forward pass with exact overlaps and confirmed end boundaries; failures do not cause a second whole-article traversal.
- Body bindings are cached within the article window. Link and separator ranges are resolved only after the text settles, not on every stability poll.
- The clipboard, Select All, pointer movement and global mouse-wheel injection are not used. Scoped UIA operations and messages to the verified IMA window are preferred.
- **允许短时前台操作** is off by default. If an unobscured IMA target is required, the run stops with an explanation instead of repeatedly stealing focus. The opt-in wheel fallback requires at least 2 seconds without input and has a per-run foreground budget of about 8 seconds. This budget covers deliberate fallback activation, not IMA's own window-opening behavior.
- IMA may still display a window when opened, including through accessibility actions. This is not a headless background service; avoid interacting with the article being read. Cancellation preserves only fully verified articles.

## Privacy and security disclosures

The plugin:

- can start and control the local IMA desktop app through Windows UI Automation;
- reads text currently visible to the signed-in IMA account;
- creates or updates Markdown files only in the configured vault folder;
- appends diagnostic messages to `%LOCALAPPDATA%\ima-speed-sync\sync.log`;
- writes a temporary copy of its bundled PowerShell code under the Windows temporary directory while a sync is running;
- does not operate on non-Windows systems;
- does not include telemetry, advertising, analytics, or its own network service;
- does not read scripts or commands from synchronized content.

Users are responsible for ensuring that they have permission to copy and store the synchronized material.

Automatic startup sync is disabled by default. It cannot run until the user grants external-application access.

### Diagnostic log retention

The diagnostic log contains timestamps, article titles, progress counts, and
error messages. Article body text is not intentionally written to the log.
When the active log grows beyond 4 MiB, the next sync rotates it to
`sync.log.1` (replacing the previous backup). At most the active log and one
backup are retained automatically.

To clear the log, wait until no sync is running and delete
`%LOCALAPPDATA%\ima-speed-sync\sync.log` and, if present, `sync.log.1`. Windows
recreates the active log on the next run.
Review the file before sharing it because article titles can be sensitive.

## Known limitations

- Synchronization needs an interactive Windows desktop session and currently supports the verified Chinese shared-folder interface. It is not a universal reader for every IMA view or content type.
- General mode does not require a date, minimum character count or table of contents, but does require a separately identifiable text body and verifiable scroll boundaries. Unknown layouts fail explicitly.
- Markdown is reconstructed from accessibility text. Headings and selected
  list-like text are normalized. General mode preserves literal URLs, converts accessible named hyperlinks when a target URL is supplied, and restores accessible separators as Markdown rules. An inaccessible hyperlink target causes a failure rather than silently dropping the destination. Embedded IMA cards, attached PDFs/images, colors and complex tables remain outside phase one; any visible card text is not an export of the linked attachment.
- No-overwrite mode counts existing titles inside the configured recent-article
  limit and intentionally does not backfill with older articles.
- Sync is sequential and can take time for long articles. General-mode title search is bounded to 30 seconds / 30 pages and each article to 120 seconds / 300 read windows (individual UIA calls can delay cancellation). Keep
  Obsidian and the signed-in IMA session open until the run finishes.

## Development

```powershell
npm install
npm run check
npm run dev
```

The PowerShell source remains reviewable at `src/sync.ps1`. The build embeds it into `dist/main.js`, because the Obsidian community installer downloads only `main.js`, `manifest.json`, and `styles.css` from a release.

`npm run dev` rebuilds `main.js` and also keeps `dist/manifest.json` and
`dist/styles.css` synchronized when either source file changes.

`npm run check` verifies release-file versions, lints and type-checks the
TypeScript, builds the production bundle, runs the JavaScript behavior tests,
and runs the PowerShell extraction tests. GitHub Actions runs this command on
Windows for every branch push and pull request. These tests cover deterministic
logic with fixtures and mocks; they are not an end-to-end test against a live
IMA desktop release, so a real-app smoke test is still required before release.
Desktop acceptance reports are kept locally under `tests/SMOKE*.md` and are
excluded from Git because they can contain private article titles and local
verification metadata. The automated fixtures and tests are included.

## Release

1. Update the version in `package.json`, both root version fields in
   `package-lock.json`, `manifest.json`, and the current entry in
   `versions.json`.
2. Run `npm run check` on Windows.
3. Optionally preflight the intended tag with
   `npm run verify:release -- --tag 0.1.0`.
4. Push a bare `x.y.z` tag matching the manifest version, such as `0.1.0`
   (not `v0.1.0`).
5. The release workflow repeats all checks and uploads `main.js`,
   `manifest.json`, and `styles.css`.

Test a public beta with BRAT before submitting the repository to the Obsidian Community directory.

## License

[MIT](../LICENSE)
