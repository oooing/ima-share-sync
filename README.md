# IMA Share Sync

**English** · [简体中文](https://github.com/oooing/ima-share-sync/blob/main/README.zh-CN.md)

![Articles others share through IMA become local Obsidian notes for your own research workflow](docs/assets/research-hero-en.svg)

**Turn others’ shared insights into your local research library.**

Found valuable investment research, industry insights, or a curated collection shared through IMA? Take it beyond online reading.

IMA Share Sync saves **text articles and permitted original files shared through IMA** into your Obsidian vault, with local PDF-to-Markdown conversion, including paid shares you have permission to save. Build an archive you can search, annotate, and analyze with an AI agent you configure.

## What is new in 0.2.0

- Sync recent items or choose Sync All, with subfolder depth, title filters, and folder limits.
- Save permitted original files and validate PDF page structure before importing.
- Convert PDF text to Markdown locally; keep a link to the original and fill missing notes manually. No OCR.
- Organize settings into Sync Scope, Convert, Notices, and General, with Chinese / English selection.
- Keep old per-folder limits until you explicitly migrate to a total-per-run limit.

[Release notes](https://github.com/oooing/ima-share-sync/releases/tag/0.2.0) · [Selection rules](docs/general-selection.md)

## Investment research: follow today’s developments, understand what changed

Save investment-bank research and industry articles each day, building a traceable research library alongside your own notes.

Then use your own agent for on-demand or scheduled analysis. Compare yesterday, the past 3 / 7 / 30 days, six months, or a year to see how views, expectations, and evidence about a company or sector have evolved—and identify leads worth investigating.

> “How have humanoid robot orders and production expectations changed over the past 7 days? Compared with the preceding 30 days, what is genuinely new and what repeats earlier views? Cite the original sources.”

Don’t just finish today’s reading. Let each day’s material inform your next research question.

## More ways to use your archive

**Track competitors.** Collect product updates and industry analysis. Compare changes in features, pricing, and positioning to inform product decisions.

**Write with evidence.** Build a topic-based collection, then ask your agent to organize examples, compare perspectives, and retrieve original sources when you write.

[Explore use cases and example prompts →](docs/USE-CASES.md)

*The plugin syncs text; agents and automated analysis require separate setup. Comparisons depend on available history. No live market feed or investment advice.*

## From shared reading to your own workflow

Choose an IMA source and an Obsidian destination to start syncing. Local Markdown files are easy to back up, move, and use with tools that can read your local archive.

Windows 10+ · Obsidian 1.11.4+ · Signed-in IMA desktop with access to the shared content · No other plugins needed.

[Install the latest release](https://github.com/oooing/ima-share-sync/releases/latest) with the [setup guide](docs/GUIDE.md). Choose your source and destination, then sync. Startup sync is optional; the settings support Chinese and English.

## Before you sync

- Recognized saved articles are skipped by default; results are logged.
- Desktop automation may open IMA; you can stop it. Original files require an available IMA download route. Scanned PDFs get a linked placeholder; OCR is not included.
- Save only with permission. No paid-content unlocking or bypassing restrictions; local copies do not grant copyright or redistribution rights.

No telemetry or custom upload servers. IMA needs internet; cloud agents or vault-sync services may upload content you authorize.

Licensed under [MIT](LICENSE). Independent project, not affiliated with Tencent, IMA, or Obsidian.

[Full guide](docs/GUIDE.md) · [Technical details](docs/TECHNICAL.md) · [Privacy & security](SECURITY.md) · [Feedback](https://github.com/oooing/ima-share-sync/issues)
