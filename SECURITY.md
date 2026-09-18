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
