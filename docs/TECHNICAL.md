# IMA Share Sync technical notes

Windows-only synchronization through the installed, signed-in IMA desktop app. The public name is IMA Share Sync; the internal ID ima-speed-sync remains compatible with existing configuration and metadata.

## Architecture

- src/main.ts manages settings, run lifecycle, source indexes, file imports, history and cancellation.
- src/sync.ps1 uses scoped Windows UI Automation to discover candidates, read articles or save permitted original files. Its source is embedded into the production bundle.
- src/pdf-structure.ts, pdf-validation.ts and pdf-validation-worker.ts validate PDF page trees through pdf-lib, with background-thread cancellation, timeouts and a fallback.
- src/pdf-to-markdown.ts runs the embedded conversion script in a local background worker, without a system Node.js installation.
- src/pdf-markdown-runner.cjs uses the embedded @firecrawl/pdf-inspector-wasm parser. scripts/markdown-runner-build.mjs bundles both the parser and WASM bytes into main.js. No system Node.js, native addon or external source path is required at runtime.
- src/i18n.ts supplies Chinese and English settings strings; desktop cards use the bundled PowerShell source.

## Scope and compatibility

New installations use general mode, startup sync off, no overwrite, recent limit 30, subfolders enabled, one folder and one level of depth, and a total-per-run count rule. Existing settings retain their extraction mode and legacy per-folder count rule until explicitly migrated.

Recent mode checks 1–30 candidates within selected folders. Folder selection prefers displayed update time, then candidates are merged by source time and truncated before deduplication and saved-source skipping. Unrecognizable time information fails explicitly rather than inferring dates from filenames. Skips, conflicts and failures do not backfill older entries.

Sync All uses a 1,000-candidate protection limit, with source-depth, title-filter and list-read budgets still active. Legacy counting applies its limit per folder. It is not unlimited global export. Recent folder limits support 1–20 folders, and depth is capped at 5. See [selection details](general-selection.md).

Legacy speed-reader mode keeps its date-title, update-marker, TOC and specialized formatting checks. General mode supports arbitrary titles and short text, but still requires verifiable article boundaries and accessible link targets.

## Identity, files and overwrite

Accessible source IDs and knowledge-base scope identify articles separately from filenames. Unknown same-name identities are protected even with overwrite enabled. A conservative content fingerprint is not proof that a renamed or edited article is the same source. Existing speed-reader notes are not automatically reidentified as general articles.

No-overwrite mode skips recognized saved IDs before opening articles. A deleted local file can be retried if its source is still in the selected candidate range. Filenames preserve source titles where possible, replacing unsafe characters and limiting basename length.

Original files require a confirmed current reader and an available IMA route. Similar titles or cached signed URLs are not sufficient identity. Downloads restrict HTTPS hosts, reject redirects and verify available lengths. Temporary results are constrained to the current staging directory, then format-checked before entering the vault. Only windows confirmed to belong to the current operation are cleaned up.

PDF validation checks actual page references, rejecting fake, truncated, empty, broken, cyclic and encrypted files. It does not rewrite originals or prove byte equality with the source, and does not validate every image, font or content stream. Other media receive format screening rather than complete decoding.

## PDF conversion

The bundled runner and WASM bytes execute in an eval background worker with cloned task data, progress messages, a timeout, cancellation and worker termination. Parsing does not upload PDF bytes or require temporary runner files.

Text and mixed PDFs retain extractable Markdown. Image-only scans produce an original-linked placeholder, without OCR. Generated notes newer than their PDF are skipped. Existing files without a converter marker and matching source-PDF link are preserved. Conversion does not delete or modify the PDF. Complex layout and tables may differ from the source.

## UI and lifecycle

Settings are organized into Scope, Convert, Notices and General tabs, with automatic or explicit Chinese / English selection. Some sidebar, consent and runtime messages remain Chinese. Articles open in the main editor; history has 20 runs per page and error links locate a specific record.

Manual sync starts immediately. Optional automatic preflight counts down after the desktop card is ready, with start, defer and cancel actions. Running tasks keep a stop control. Cancellation aborts PDF validation and conversion and guards subsequent writes; already completed writes are not rolled back.

Scoped accessibility operations are preferred. Foreground fallback is opt-in, requires idle input and a per-run budget. IMA may still bring its own windows forward. This is an interactive desktop workflow rather than a headless service.

## Local data

Settings, source metadata and history live in the plugin data.json. Diagnostics at %LOCALAPPDATA%\ima-speed-sync\sync.log include timestamps, titles, counts and errors, not intentionally article bodies. Logs rotate after 4 MiB, retaining one backup. Review diagnostics before sharing.

Bundled sync scripts and extraction results use temporary local directories with best-effort cleanup. A crash can leave residual files. No telemetry, advertising or custom upload service is provided; IMA and separately configured cloud agents or vault-sync services have their own network behavior. See [security](../SECURITY.md) and [dependency notices](../THIRD-PARTY-NOTICES.txt).

## Build and release

Run npm ci, then npm run check on Windows. The check verifies manifest/package/lock/versions consistency, ESLint, TypeScript, production build, JavaScript regressions, PDF validation, standalone conversion, PowerShell fixtures and desktop-card previews.

Build output contains exactly dist/main.js, dist/manifest.json and dist/styles.css. The parser, workers and PowerShell source are embedded so standard Obsidian release installation can function without extra assets. Development watch mode also copies metadata and styles as they change.

For a release, update all version files, add docs/releases/x.y.z.md, run npm run verify:release -- --tag x.y.z, and push a matching bare x.y.z tag. GitHub Actions repeats npm ci and npm run check, then publishes the three standard assets and notes. A GitHub release does not mean approval in the Obsidian Community directory.

Automated checks use fixtures and simulated hosts. They do not prove that every current IMA layout exposes reader URLs or download controls; real desktop acceptance is separate. Private PDFs, vault configuration and local acceptance reports are excluded from publication.

Licensed under [MIT](../LICENSE). Independent of Tencent, IMA and Obsidian.
