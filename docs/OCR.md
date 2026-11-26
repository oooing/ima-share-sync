# 文档转换：文字与扫描页

**PDF 文字转 Markdown 默认开启。** 文字型 PDF 直接在本机提取文字，无需 API，不上传。

**图片 OCR 默认关闭。** 需要识别扫描页时，手动开启后选择识别方式，再点「补转」。同步只登记待处理文件，不启动 OCR，也不使用旧版的后台上传授权。

1. 在「文档转换」手动打开「图片 OCR」，选择一种方式。
2. **百度云端解析（推荐）**：PaddleOCR-VL-1.6，适合研报和复杂表格。打开 [获取百度 AI Studio 访问令牌](https://aistudio.baidu.com/account/accessToken)，登录后创建或复制自己的 Access Token，回到插件从 Obsidian 密钥库新建或选择令牌。**没配置令牌不能云端补转。** 这不是 IMA Key，也不是百度智能云通用 OCR 的 API Key / Secret Key。
3. **本地版面识别**：PaddleOCR-VL-1.6，需可用的 Vulkan 显卡、Python 3.12 和至少 6 GiB 可用内存。本地识别不上传。
4. **本地轻量识字**：PP-OCRv5 mobile，Python 3.12、CPU 单路，运行前检查 1.5 GiB 可用内存。用于文字检索，不还原财务表格行列。

百度云端的**免费额度目前每位用户、每个模型每天最高 20,000 页**。实际以 [百度 AI Studio 配额规则](https://ai.baidu.com/ai-doc/AISTUDIO/Xmjclapam) 和你的账户为准；达到上限后，本轮剩余文件留待补转，插件不会购买额度。

手动确认云端补转后，百度会收到**整份 PDF**，仅识别所需页；取消不能撤回已发送的文件。两种本地模式不需要百度令牌，也不上传。

点「补转」只处理队列中已有的本地 PDF，不重新下载。云端每轮确认后才提交；两种本地模式也只手动运行。未装模型、内存不足、令牌或额度受限时保留队列，不能自动改用其它方式。用「检查已有 PDF」可以发现未入队的文件，该操作不启动 OCR。升级不会自动补转历史队列。

不改原 PDF，不覆盖手工笔记。云端返回不完整时不会写成完整笔记。单份上传限制为 50 MB、1,000 页；财务数字、行列及单位仍应核对原页。

## Local OCR setup

本地 OCR 只支持 Windows。**如果「检查环境」显示已找到模型文件，无需重装。** 否则先安装 [Python 3.12](https://www.python.org/downloads/)，然后下载 [独立安装脚本](../scripts/install-local-ocr.py)（在 GitHub 文件页点 Download raw file）。在脚本所在目录打开 PowerShell，按需运行对应的一条：

```powershell
# 本地轻量识字 / Lightweight text (CPU)
py -3.12 .\install-local-ocr.py --mode local-mobile
# 本地版面识别 / Layout OCR (Vulkan; model download is about 2 GB)
py -3.12 .\install-local-ocr.py --mode local
```

脚本在插件外运行，默认分别使用 `%LOCALAPPDATA%\IMA-Share-Sync\ocr-mobile` 和 `%LOCALAPPDATA%\IMA-Share-Sync\ocr`。安装联网从 PyPI、ModelScope 或 Hugging Face 和 GitHub 获取公开依赖及模型，不读取你的 PDF。完成后回到对应选项点「检查环境」。

On Windows, install Python 3.12 and download the stand-alone script linked above. Run only the command for the mode you want. Return to that mode in Obsidian and select **Check environment**. An existing compatible runtime does not need reinstalling. The plug-in never invokes the installer.
