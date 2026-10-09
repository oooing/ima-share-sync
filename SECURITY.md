# Security

Please use GitHub's private vulnerability reporting feature in the repository **Security** tab. Do not include exploit details in a public issue.

The plugin executes only the PowerShell source bundled into its published release build. It does not evaluate commands or scripts from notes, IMA content, or plugin settings.

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

The published main.js embeds the local WASM PDF parser and conversion runner. Conversion runs in a local background worker; no system Node installation or remote dependency download is needed. Only sync extraction and bundled PowerShell use temporary working directories. A crash may leave temporary files. PDF bytes are not uploaded by conversion.

Existing notes without this converter's marker and matching PDF link are preserved. Original files remain untouched by conversion. See THIRD-PARTY-NOTICES.txt for bundled dependency licenses.
