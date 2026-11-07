# HANDOFF — dsh-media-desk 思悟改版 · 2026-11-07

> 交接给下一次会话的自己（或爸爸查看）。当前分支 `siwu-local`（基于上游 main v2.6.1 + 本地私货），fork 备份在 chenxupeng1990-eng/dsh-media-desk。

## 一句话现状

自媒体工作台已完成五轮改造并全部实测：模型自选、免费数据抓取、思悟风格卡、文件桥（主会话写稿自动回填）、guizang 设计卡图文模式、一键发布按钮（**未真发验证**）。

## 分支与安装状态

- `siwu-local` = 上游 main（v2.6.1）+ PR #5 内容 + 私货，**当前安装且生效**
- 上游 PR #5（助手模型自选 + 创作中心数据抓取）：https://github.com/woniuniuniu/dsh-media-desk/pull/5 ，等作者 review
- 本地安装方式：plugin_manager 装的是**本地目录链接**（projects/dsh-media-desk），改代码后需 `node scripts/build.mjs` + set_plugin 关/开来重载
- ⚠️ 别在插件管理里点升级（会覆盖回 npm 版）；升上游前先移植私货

## 五个功能模块（全部已提交 siwu-local）

1. **助手模型自选**：顶栏按钮，选完存 `~/.dsh/media-desk/settings.json` 的 assistant 字段；`ai.js` modelInfo 优先读覆盖
2. **数据抓取**：`scripts/scrape-creator-centers.mjs`（ego-browser），小红书逐笔记累计转增量 / B站昨日 / 抖音昨日；去重缓存 `~/.dsh/media-desk/scrape-cache.json`；定时任务每天 13:30
3. **思悟风格卡**：`src/style-presets.js` 里 `preset_siwu`（私货，不进上游），PRESET_VERSION=2
4. **文件桥**（核心）：灵感「交给我写」→ host 写 `~/.dsh/media-desk/inbox/任务-<id>.md` → 主会话 agent（定时任务 schedule-bfafdcb7，2 小时轮询）取件写稿 → 成稿文件回填 → 20 秒自动入库 → 任务和成稿归档到 inbox/done/
   - 协议：frontmatter（itemId/mode/coverText/coverPrompt/coverFile/redraw）+ 正文 + `## 图文`（file: 引用或生图提示词）+ `## 分镜`
   - `redraw: cover,gallery,shots` 强制重画；`file:` 前缀引用已生成 PNG 不触发生图；没接生图也能收 file: 图
5. **一键发布**：成稿卡「发布」按钮 → 确认框 → host spawn ego-browser 跑 `scripts/publish-xhs.mjs`（自动传图/填标题 20 字截断/正文 1000 字截断/点发布）→ 成功标 published+时间戳。防重入、已发布拦截、图片预检、6 分钟超时

## 生图与视觉规范（爸爸定的纪律，别回退）

- **生图提示词意图式**：只写用途/受众/感觉/必须出现的内容/要画的中文文字（逐字）/硬规格（竖版）。**禁止**构图、光线、字体、景别等 micro-spec——模型比我们知道怎么生图
- 镜头字段（焦平面/证据载体）只用于商品实拍类；时讯/观点/工具类一律意图式
- 中文文字可直画（image 2.6 可信，实测 11 字零错字）；canvas 叠字方案已废弃（死代码已删）
- 图文卡片用 guizang-social-card-skill（~/.agents/skills/，HTML 渲染 1080×1440，Swiss=测评/数据，Editorial=叙事）；数量不限制，每张唯一 job+new_information
- 封面默认生图意图式；设计卡封面用 frontmatter `coverFile: file:xxx.png` + `redraw: cover`
- 生图接口 = magpie 本地 API（127.0.0.1:3425，模型 codex/gpt-image-2.5，**必须带 codex/ 前缀**），magpie 要在运行

## 定时任务（schedule 看板）

- `schedule-c242ad0e`：每天 13:30 创作中心数据抓取
- `schedule-bfafdcb7`：每 2 小时收件箱取件写稿（含最新写作规范全文）

## 下次待办（按优先级）

1. **第一次真发验证**：工作台点《PR 滚动病》的「发布」→ 确认。可能暴露发布页 DOM 变化/登录失效——失败报错不会误发，修解析再试。验证点：图片顺序、标题截断、发布成功判定（PUBLISH_RESULT ok:true）
2. **PR #5 扩充决策**：文件桥/发布功能要不要并进上游 PR（爸爸没拍板）；guizang 是本地 skill 依赖，上游用户需自配
3. **「抓我的账号」**（风格页）仍走 Monid 付费——可换成浏览器方案（同数据抓取模式），爸爸提过没拍板
4. **空任务** `任务-it_mw5ql8f12l1.md`（标题只有「做一个」）等爸爸补内容
5. 上游 v2.6.1 有 related.js 等新功能，本地 siwu-local 已基于它，无冲突

## 已知的坑（详见 ~/.dsh/LESSONS.md）

- Homebrew pnpm ENOEXEC 已修（node install.js 装原生二进制）
- **ego 标签用完必须 page.close()**——遗留 3080 标签占满 Chromium 同主机连接池，DSH web 整体卡死
- DSH 桌面端运行期间别在 profile 目录跑 pnpm
- web_search 插件欠费（DeepSeek 402）——查新闻用 ego 开 x.com 带登录态搜
- 生图接口依赖 magpie 进程存活；magpie 没开时报"连不上生图服务"

## 验证方法

- 单测：`node --test test/*.test.js`（68 个，~300ms；若变慢查有没有人往 apply 里加未 unref 的定时器）
- 构建：`node scripts/build.mjs`（client → dist/client.js，git 忽略 dist）
- 插件重载：plugin_manager set_plugin include:media-desk false→true
- 真机验证：ego-browser nodejs 开 3080 → 点 Media Desk → 操作 → 截图；fetch 接口用 GUI 标签页同源（带会话）
