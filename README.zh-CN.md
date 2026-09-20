# IMA Share Sync

[English](https://github.com/oooing/ima-share-sync/blob/main/README.md) · **简体中文**

![将 IMA 每日阅读沉淀为本地 Markdown，供自己的研究工作流使用](docs/assets/research-hero-zh.svg)

**积累每天的资料，看清长期的变化。**

将 IMA 分享的文字文章同步到 Obsidian，以本地 Markdown 持续积累。自己标注、检索，也能交给自己的 AI Agent 分析，不用逐篇复制。

## 金融投研：跟上今天，也看清趋势

每天在 IMA 阅读投行研报、行业简报？把文字资料沉淀到自己的笔记库，再用另行配置的 Agent，按昨天、近 3／7／30 天、半年或一年，对照关注的公司与行业：哪些观点变了？依据是什么？哪些机会值得进一步验证？

> “对比近 7 天与此前 30 天的人形机器人资料：订单、量产进度和盈利预期有哪些变化？区分新证据与重复观点，附上日期和原文依据。”

## 还可以这样用

**竞品跟踪**：积累产品更新和行业解读，让 Agent 对照定价、功能、定位的变化，再结合自己的产品规划，找值得验证的方向。

**内容创作**：平时积累文章、案例与观点，写作时让 Agent 找素材、整理分歧、列出带来源的提纲，再由自己判断和写作。

[更多用例与可直接参考的提问 →](docs/USE-CASES.zh-CN.md)

*以上为建议工作流，并非内置 AI 功能。插件负责同步文字；分析、定时或新增触发分析需另行配置 Agent。跨期比较需要足够的历史资料，不提供实时行情或投资建议。*

## 开始使用

**准备环境**：Windows 10+，Obsidian 1.11.4+，已登录 IMA 桌面端且可打开目标分享文件夹（无需其他插件）。

按[安装指南](docs/GUIDE.zh-CN.md)安装[最新版本](https://github.com/oooing/ima-share-sync/releases/latest)，选择 IMA 知识库、来源文件夹和 Obsidian 保存目录，即可同步。需要随 Obsidian 启动同步，可在设置中开启。

## 同步前了解

- 默认跳过已识别保存的文章，结果和错误可在侧栏日志中查看。
- 通过本地桌面自动化读取，IMA 可能弹窗，可随时停止，并非无感后台。
- 适用于文字文章，暂不完整支持 PDF、图片和附件。

资料保存在本地，由你选择存储位置和读取工具；使用云端 Agent 或笔记同步服务时，仍可能上传你交给它们的内容。插件无遥测和自建上传服务，IMA 自身仍需联网。

基于 [MIT 协议](LICENSE) 开源，非腾讯、IMA 或 Obsidian 官方项目。

[完整指南](docs/GUIDE.zh-CN.md) · [技术说明](docs/TECHNICAL.md) · [隐私与安全](SECURITY.md) · [反馈建议](https://github.com/oooing/ima-share-sync/issues)
