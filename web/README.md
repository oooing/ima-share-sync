# Web 开发与客户端 ID 来源

在 `code` 目录运行 `npm run dev:web`，用 Chrome 打开 <http://127.0.0.1:17664/#scope>。Web 开发需要 Node.js 20 或以上及已安装的项目依赖；正式 Obsidian 插件使用 Obsidian 自带的运行环境，不需要 Node.js 命令行、Codex 或 1Password。

## 两种预览方式

默认的“已有配置”以及改名、同名目录、读取失败等场景使用示例数据，不操作 IMA。页面右上角可以切换场景；各场景设置分别保存在浏览器的 `ima-web-preview:v2:场景` 中，不读取或覆盖正式库的 `data.json`。

选择“真实 IMA（来源只读）”，或打开 <http://127.0.0.1:17664/?scenario=live#scope>，可通过本机 Windows UI Automation 查询客户端中的知识库、目录及稳定 ID。它与插件共用客户端身份适配器，不需要 IMA 官方 API Key、Client ID 或 1Password 授权。读取来源会导航 IMA 界面，但不会创建、改名、删除资料，也不会执行文章下载。

所有 Web 场景的同步、下载和 PDF 转换入口均被隔离；真实同步必须在 Obsidian 插件中验收。浏览器设置不会自动应用到正式插件。

## 交互与来源身份

保留 D 图示布局、第 9 套配色、原图标和同步卡片：来源、同步规则、保存分别打开设置弹窗，每个弹窗提供基本设置和高级设置。同步范围属于来源；保存位置属于保存，“同名覆盖”“保留目录”等选项收在对应的高级设置中。

知识库和目录在同一个来源选择器中浏览。面包屑返回上级，“使用当前位置”提交选择；取消、关闭或 Escape 不提交尚未确认的位置。普通设置自动保存，保存失败保留错误状态，支持重试或恢复已保存配置。更换知识库后必须确认范围提醒，刷新不会绕过确认。

客户端 ID 用于识别来源，名称只用于显示。已核验的同 ID 知识库或目录改名会更新显示名称，保留原 `sourceScope`、保存位置和同步记录。旧 API 身份迁移需要唯一的客户端来源、相同目录 ID 及旧文章 ID 的对应证据；无法证明时保留旧配置并停止，不按同名猜测或自动扩大为整库。

目录 ID 链与原本地子目录的对应关系会保存。已有文章记录用于证明改名前后的本地位置，包含本轮跳过的文章；子目录改名后继续保存到原路径。同名但 ID 不同的来源不自动合并，同一本地位置出现身份冲突时停止保存。重启后重新核验持久化的 ID，不能仅凭缓存名称认定来源存在。

## 客户端运行条件

真实来源查询及插件同步需要 Windows 桌面会话已登录、已解锁，且 Windows 版 IMA 已安装并登录，当前账号能访问目标来源。使用系统自带的 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 和 Windows UI Automation，不依赖 Codex 私有 PowerShell 或凭据环境变量。

IMA 未运行时，后端会尝试从 `%LOCALAPPDATA%\ima.copilot\Application\ima.copilot.exe` 启动客户端，并等待主窗口，最长约 45 秒。窗口出现后，来源导航在已有 90 秒截止时间内等待侧栏就绪；不会把暂未渲染的侧栏当成来源不存在。找不到程序、窗口未就绪、桌面锁定或其他任务占用时会返回明确状态；不会因此切换到同名来源。免官方 API 授权不等于离线：IMA 登录、内容加载和获准原文件下载仍需网络。

## 共享代码与构建

- `src/main.ts`：插件界面、自动保存、身份迁移和同步入口。
- `src/source-identity.ts`、`src/desktop-identity-provider.ts`：ID 配置、核验、旧身份迁移和客户端适配器。
- `src/sync.ps1`：客户端来源读取、目录定位及现有同步后端。
- `src/folder-destinations.ts`：目录 ID 链与原本地路径的对应关系。
- `src/native-identity-runner.ts`、`web/live-identity.mjs`：Web 到同一客户端后端的本机读取通道。
- `web/scenarios.mjs`、`web/obsidian-host.mjs`：示例数据、浏览器存储与禁止真实下载的 Web 宿主，不进入插件发布包。

Web 加载生产构建的 `dist/main.js` 和 `dist/styles.css`。`npm run package:plugin` 校验当前 `dist` 与 Web 构建标识一致，只打包 `main.js`、`styles.css`、`manifest.json`，不会安装插件或复制正式库配置。JavaScript 使用 UTF-8 输出，嵌入的 PowerShell 保持明文；写入运行脚本时添加 UTF-8 BOM，兼容 Windows PowerShell 5.1 的中文解析。发布构建仍受 5 MB 体积上限约束。

## 验收与安装边界

```sh
npm run check
npm run test:web
npm run package:plugin
```

Web 验收包括来源选择与取消、自动保存、范围确认、同 ID 改名、同名新 ID、旧记录关联和保存失败恢复。它不能替代真实客户端验收。

0.3.14 最终候选为 70d44e5a…，封包 buildId=2045542e04da。历史 8e46 下载/改名、40937 重启/同名重建及迁移、e868 真实补回 1 篇/再次下载 0 篇分别记录；最终 70d44 仅修正跨 API/native 命名空间提示，Chrome 真实来源/目录、新中性提示和取消保留配置已通过。身份 51 项、Web 25 项及最终构建后的 JS/发布校验通过，未改的后端套件继承 e868 结果。正式插件已更新并实际启用0.3.14/70d44，正式身份迁移及原2308文件、1528记录、133报告保留已通过；本轮未触发正式下载。浏览器旧 API 配置没有正式账本，不能靠同名认定身份；虚拟 vault 不含旧保存路径时的提示也不代表正式库目录丢失。证据见项目 [验收结果](../../Product/无API实施-20261103/验收结果.md) 和 [0.3.14 版本说明](../docs/releases/0.3.14.md)。
