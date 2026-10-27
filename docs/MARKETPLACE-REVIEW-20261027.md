# Obsidian Community 0.3.3 审核失败调查

日期：2026-10-27

## 已确认

- 管理页 https://community.obsidian.md/account/plugins/ima-speed-sync 显示 0.3.3 / 940a8d8 / Failed。
- 平台提示自动审核无法完成，管理员将调查。可见结果没有 Error。
- Build verification 逐字节复现通过；网络模式、依赖漏洞、代码混淆检查通过。
- 主程序 17,395,378 字节，包含桌面直接解析器和桌面始终不会使用的 Node runner，两者各嵌入同一份 5,997,774 字节的 WASM。
- 管理页 More actions 当前只有 Get help、View on GitHub、Archive，没有 Request review。
- 官方文档明确：Warnings don't block your submission。因此不可把 Warning 当成已经证实的 Failed 根因。

## 0.3.4 修复与验收

- 桌面仍向 runMarkdownConversion 提供原 processSinglePdf。去掉未使用的 runner 导入，仅传空 runner 字符串；独立 Node runner 及其隔离测试保留。
- 生产构建复用独立 gzip WASM 插件，数据还原后逐字节对照原始 WASM。没有压缩或动态解码 JavaScript，没有下载依赖。
- 生产包必须不超过 5,000,000 字节，否则构建失败。
- 发布流程在测试通过后，为 main.js、manifest.json、styles.css 生成 GitHub 构建来源证明，随后才创建 Release。action 固定提交，权限仅增加该签名流程所需的 id-token/attestations write。
- CSS 信息行本就使用 ima-advanced-info-item，删除重复的 :has 降级选择器，不改变其声明或类名。
- 使用隔离临时目录运行 npm run check，不更新现用 Obsidian 插件，不访问真实 IMA 做同步验收。

## 未确认与剩余项

- 没有平台内部日志，无法确认审核服务异常、超时或其他未展示步骤的具体原因；包体积过大是否导致未完成也只是待验证假设。
- filesystem/shell 为 Windows UI 自动化及原文件保存所需，不能通过隐藏调用来消除权限提示。
- getSettingDefinitions 为 1.13+ 可选 API；当前支持 1.11.4。增加非空定义会替代现有 display 页面，必须单独进行旧/新版本 UI 与设置持久化验收，不能返回空定义伪装解决搜索功能。
- !important 的全面移除需要 Obsidian 默认/第三方主题视觉回归，本次保留；它是警告，不能证明是审核失败原因。
- 原“目录列表在检查过程中消失”尚未修复。
- 新版发布后需分别验证：GitHub 工作流、附件摘要、构建来源证明、市场新版本检测、扫描终态、Add to Obsidian 是否启用。若仍 Failed 且无 Error，需提供证据给管理员调查，不能继续盲目发版。

## 官方依据

- https://docs.obsidian.md/community-directory/manage-entry
- https://docs.obsidian.md/community-directory/faq
- https://docs.obsidian.md/plugins/guides/migrate-declarative-settings
- https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

## 0.3.4 重审结果与 0.3.5 后续修复

0.3.4 审核从 Failed 恢复为 Completed，公开页 Add to Obsidian 已成为有效安装链接。体积超限、缺少附件来源证明、:has 三项提示消失。因此无需隐藏必要权限或重写设置页面来换取通过；此前具体内部失败点仍未公开，无法单独归因于某一项改动。

但 0.3.4 出现新的构建复现 Warning。检查发现 Node gzip 在 Windows 的 header[9] 为 10，Unix 为 3；这是压缩数据携带的系统标记，不影响解压结果，却影响 main.js 摘要。0.3.5 将其规范化为 RFC 1952 的 255（unknown），保留压缩内容与校验和。Windows 与 Linux CI 同时检查固定版本 WASM 的压缩摘要，并执行真实 PDF 测试。是否完全消除市场构建差异以 0.3.5 重审为准。

操作系统标记依据：https://docs.gtk.org/gio/property.ZlibCompressor.os.html
