# IMA Share Sync

**English** · [简体中文](https://github.com/oooing/ima-share-sync/blob/main/README.zh-CN.md)

![From daily IMA reading to local Markdown and your own research workflow](docs/assets/research-hero-en.svg)

**Keep today's reading. See what changes over time.**

Sync IMA shared text articles to local Markdown in Obsidian. Build a growing source library that you can annotate, search, and use with your own AI agent—without copying each article by hand.

## Follow companies and industries over time

Read investment research in IMA every day? Keep it in your own vault. With a separately configured agent, compare yesterday, the past 3 / 7 / 30 days, or six months to a year: what changed, what stayed the same, and which ideas need closer investigation?

> “Compare the past 7 days of robotics research with the previous 30 days. What changed in orders, production timelines, and earnings expectations? Separate new evidence from repeated views, and link to the sources.”

## More ways to use your reading

**Track competitors.** Save product updates and industry commentary; ask your agent what changed in pricing, features, and positioning—and how that relates to your roadmap.

**Write with evidence.** Build a library of articles, examples, and viewpoints; ask your agent for an outline with contrasting perspectives and traceable sources, then make it your own.

[Explore use cases and example prompts →](docs/USE-CASES.md)

*These are suggested workflows, not built-in AI features. The plugin saves text; you configure analysis and scheduled or file-triggered runs separately. Historical comparisons need sufficient source history. No live market feed or investment recommendations are provided.*

## Quick start

Requires Windows 10+, Obsidian 1.11.4+, and a signed-in IMA desktop app with access to your source folder. No other plugins needed.

[Install the latest release](https://github.com/oooing/ima-share-sync/releases/latest) using the [setup guide](docs/GUIDE.md). Choose your IMA knowledge base, source folder, and Obsidian destination, then sync. Optional startup sync is available in settings. The plugin interface currently uses Chinese.

## Before you sync

- Recognized saved articles are skipped by default. Check results in the sidebar sync logs.
- Local desktop automation may open IMA windows. You can stop it anytime; this is not a headless service.
- For text articles; PDFs, images, and attachments are not fully supported.

Local files give you control over storage and which tools can read them. Cloud agents or vault-sync services may still upload the content you share with them. The plugin uses no telemetry or custom upload servers; IMA itself requires internet.

Licensed under [MIT](LICENSE). Independent project, not affiliated with Tencent, IMA, or Obsidian.

[Full guide](docs/GUIDE.md) · [Technical details](docs/TECHNICAL.md) · [Privacy & security](SECURITY.md) · [Feedback](https://github.com/oooing/ima-share-sync/issues)
