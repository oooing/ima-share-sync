# IMA Share Sync

**简体中文** · [English](README.en.md)

**好资料，值得留下来。**

把别人通过 IMA 分享的文章、教程和文件存进 Obsidian，方便回看、写作参考，也可交给本地 AI 分析。

<p align="center">
  <a href="https://obsidian.md/plugins?id=ima-speed-sync"><img src="docs/assets/install-obsidian-zh.svg" alt="打开 Obsidian 插件页安装" width="224" height="54"></a>
</p>

<p align="center"><a href="https://github.com/oooing/ima-share-sync/blob/main/docs/GUIDE.zh-CN.md">查看指南</a> · <a href="https://github.com/oooing/ima-share-sync/releases/tag/0.2.0">下载文件</a></p>

Windows 10 及以上 · Obsidian 1.11.4 及以上 · 已安装并登录 IMA 桌面版。

## 适合谁用

<p align="center">
  <img src="docs/assets/ima-share-sync-pyramid-zh-CN-v1.jpg" alt="从别人分享的资料，到保存进 Obsidian，再到继续使用的三层金字塔；适合学生、职场人、创作者、产品人、研究者和爱好者。" width="640">
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>学习备考</h3>
      <p align="center"><img src="docs/assets/scenarios/learning-zh-CN-sc011-v1.jpg" alt="学习备考：课程讲义、学习文章、复习笔记、知识要点。" width="360"></p>
      <p><strong>适合谁</strong>：学生、备考者、正在学新技能的人。</p>
      <p><strong>举个例子</strong>：保存别人分享的课程讲义和学习文章，复习时集中查找，再用本地 AI 整理知识要点。</p>
    </td>
    <td width="50%" valign="top">
      <h3>工作参考</h3>
      <p align="center"><img src="docs/assets/scenarios/work-zh-CN-sc011-v1.jpg" alt="工作参考：项目案例、工作指南、方案参考、汇报素材。" width="360"></p>
      <p><strong>适合谁</strong>：职场新人、项目负责人、常写方案的人。</p>
      <p><strong>举个例子</strong>：保存同事分享的项目案例和工作指南，下次写方案、做汇报时，快速找到参考。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>内容创作</h3>
      <p align="center"><img src="docs/assets/scenarios/writing-zh-CN-sc011-v1.jpg" alt="内容创作：好文章、人物故事、行业案例、原文出处。" width="360"></p>
      <p><strong>适合谁</strong>：自媒体作者、内容编辑、知识分享者。</p>
      <p><strong>举个例子</strong>：保存好文章、人物故事和行业案例，写作时回查出处，也可让本地 AI 整理素材、拟定提纲。</p>
    </td>
    <td width="50%" valign="top">
      <h3>产品调研</h3>
      <p align="center"><img src="docs/assets/scenarios/product-zh-CN-sc011-v1.jpg" alt="产品调研：产品介绍、用户反馈、设计案例、功能定价。" width="360"></p>
      <p><strong>适合谁</strong>：产品经理、设计师、独立开发者。</p>
      <p><strong>举个例子</strong>：保存同类产品介绍、用户反馈和设计案例，规划下一次更新时，比较功能、价格与做法。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>行业研究</h3>
      <p align="center"><img src="docs/assets/scenarios/research-zh-CN-sc011-v1.jpg" alt="行业研究：行业研报、公司分析、行业访谈、原文依据。" width="360"></p>
      <p><strong>适合谁</strong>：行业研究者、投研从业者、长期观察者。</p>
      <p><strong>举个例子</strong>：保存别人分享的研报、公司分析和行业访谈，再让本地 AI 比较不同观点，回查原文依据。</p>
    </td>
    <td width="50%" valign="top">
      <h3>兴趣收藏</h3>
      <p align="center"><img src="docs/assets/scenarios/hobby-zh-CN-sc011-v1.jpg" alt="兴趣收藏：教程攻略、摄影构图、养花经验、日常菜谱。" width="360"></p>
      <p><strong>适合谁</strong>：摄影、园艺、烹饪等爱好者。</p>
      <p><strong>举个例子</strong>：保存别人分享的构图教程、养花经验或菜谱，练习时随手翻看，也能加上自己的心得。</p>
    </td>
  </tr>
</table>

*插件负责保存资料；本地 AI 整理与分析需要你自行配置工具。*

## 现有功能

<table>
  <thead><tr><th width="145">功能</th><th>能做什么</th></tr></thead>
  <tbody>
    <tr><td><img src="docs/assets/icons/article-v1.svg" width="28" height="28" alt=""> <strong>文章保存</strong></td><td>把获准保存的 IMA 文章存成 Obsidian 笔记，可搜索、标注，并与已有笔记一起查看。</td></tr>
    <tr><td><img src="docs/assets/icons/original-v1.svg" width="28" height="28" alt=""> <strong>原件保存</strong></td><td>通过 IMA 可用的下载入口，保存 PDF、图片和支持的音视频原文件。</td></tr>
    <tr><td><img src="docs/assets/icons/choose-v1.svg" width="28" height="28" alt=""> <strong>按需保存</strong></td><td>检查最近 1–30 份资料，或扩大保存范围；可按标题筛选，批量保存也有数量限制。</td></tr>
    <tr><td><img src="docs/assets/icons/folders-v1.svg" width="28" height="28" alt=""> <strong>保留分组</strong></td><td>可检查子文件夹，设置查找层数与文件夹数量，并按来源文件夹名称存放。</td></tr>
    <tr><td><img src="docs/assets/icons/make-notes-v1.svg" width="28" height="28" alt=""> <strong>生成笔记</strong></td><td>从 PDF 提取已有文字并生成笔记，可附原件链接；扫描版只生成提示笔记。</td></tr>
    <tr><td><img src="docs/assets/icons/fill-notes-v1.svg" width="28" height="28" alt=""> <strong>补齐笔记</strong></td><td>给已保存的 PDF 手动补上缺少的笔记，不用重新下载原文件。</td></tr>
    <tr><td><img src="docs/assets/icons/skip-v1.svg" width="28" height="28" alt=""> <strong>重复跳过</strong></td><td>默认跳过已识别保存过的文章，减少重复保存。</td></tr>
    <tr><td><img src="docs/assets/icons/protect-v1.svg" width="28" height="28" alt=""> <strong>保护笔记</strong></td><td>默认不覆盖同名文件；转换 PDF 时，保护非本插件生成的笔记。</td></tr>
    <tr><td><img src="docs/assets/icons/check-v1.svg" width="28" height="28" alt=""> <strong>导入检查</strong></td><td>导入前检查 PDF；发现文件损坏或受保护时，会提示原因。</td></tr>
    <tr><td><img src="docs/assets/icons/control-v1.svg" width="28" height="28" alt=""> <strong>保存控制</strong></td><td>可手动开始，或开启启动时自动保存；自动保存前可推迟、取消，执行中可停止。</td></tr>
    <tr><td><img src="docs/assets/icons/history-v1.svg" width="28" height="28" alt=""> <strong>保存记录</strong></td><td>查看每次保存的文章与结果；出错时，可定位到对应记录。</td></tr>
    <tr><td><img src="docs/assets/icons/progress-v1.svg" width="28" height="28" alt=""> <strong>进度提醒</strong></td><td>查看保存进度，按需设置结果提醒、角标和桌面提示。</td></tr>
    <tr><td><img src="docs/assets/icons/language-v1.svg" width="28" height="28" alt=""> <strong>设置语言</strong></td><td>设置页可跟随 Obsidian，或选择中文、英文；部分侧栏和运行提示仍为中文。</td></tr>
  </tbody>
</table>
