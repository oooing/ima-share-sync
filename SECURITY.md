# Security

Please use GitHub's private vulnerability reporting feature in the repository **Security** tab. Do not include exploit details in a public issue.

The plugin executes its bundled PowerShell and Python helpers. It does not evaluate commands or scripts from notes or IMA content. The local OCR runtime directory contains executable dependencies; select only a directory you trust.

## Local diagnostic data

Sync diagnostics are appended to
`%LOCALAPPDATA%\ima-speed-sync\sync.log`. The file can contain timestamps,
article titles, progress counts, and error messages, and it is
rotated to `sync.log.1` on the next sync after it exceeds 4 MiB. The previous
backup is replaced, so at most one backup is retained. Article body text is not
intentionally logged.

Wait until synchronization has stopped before deleting `sync.log` and, if
present, `sync.log.1`. Windows recreates the active log on the next run. Review
either file before attaching it to a bug or security report because article
titles can disclose private interests or sources.

## Original files and conversion

Original downloads require an available IMA route and confirmed source identity. HTTPS addresses are restricted, redirects are rejected, and signed URLs are not intentionally logged. PDFs are structurally checked before import.

The main.js bundle embeds the local WASM PDF parser. Text extraction needs no system Node installation or download. Image OCR is off by default. The optional local modes require a runtime installed manually outside Obsidian. The plugin checks for the installed runtime and does not install packages or models. Local recognition reads local files; the layout mode uses a loopback-only model server. OCR helpers use temporary directories; a crash may leave temporary helper files.

Optional Baidu AI Studio OCR requires selecting API mode and confirming each manual conversion batch. Automatic sync never uploads PDFs to OCR. A confirmed job uploads the entire PDF, even when recognizing selected pages only. Cloud processing may continue after local cancellation. Requests use HTTPS; tokens are read from Obsidian SecretStorage, not plugin data.json, and are not forwarded to the result-storage host. No automatic cloud fallback occurs on local failure. See [OCR setup and limits](docs/OCR.md).

Existing notes without this converter's marker and matching PDF link are preserved. Original files remain untouched by conversion. See THIRD-PARTY-NOTICES.txt for bundled dependency licenses.
