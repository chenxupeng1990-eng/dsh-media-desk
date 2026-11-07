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

- `schedule-c242ad0e`：每天 13:30 创作中心数据抓取（**在跑**）
- ~~`schedule-bfafdcb7`：每 2 小时收件箱取件写稿~~ → **2026-11-07 爸爸要求关掉，已删除**。取件改为手动：爸爸说「取收件箱」时按上面「生图与视觉规范 + 成稿协议」现场取件；要恢复定时就重建一个（规范全文可从本文件 + git 历史里 schedule prompt 找回）

## 已实现功能：工作台助手映射到可选会话（爸爸 2026-11-07 提出，当晚开发并实测通过）

爸爸的精准表达：工作台里的助手「像网页快照一样映射到侧边栏的会话」，**可以选择一个会话做映射**，于是那段对话在 the agent harness 里就是一条正常会话、可见可回溯。

### 查证结论（已读 dsh 类型定义，未实测代码）
- 正式入口存在：`ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)`（dsh-api-session-controller），把一条用户消息投进**指定会话**的 Agent inbox，由该会话的 agent loop 跑完整一轮并写日志。
- `sessionController.list()` 可列出可选会话，`create()` 可新建专用会话 —— 正好对应「选择一个会话做映射」。
- **修正本会话前面的一个判断**：走 `prompt` 正规 inbox 时，写日志的仍是 agent loop 单写者，不会像 2026-08-23 事故那样 seq 撞车。之前「第二个写者」的顾虑只针对插件绕过 agent 自己 append 日志的假设。
- 因此该构想比「共用当前 session」干净：会话记录天然同步、侧边栏一等公民、拥有该会话的 skills/工作区指令/模型，且因「可选」可映射到专用会话而不污染主会话上下文。

### 技术验证（探针阶段，代码已删、测试会话已归档）
在插件里加临时探针路由，从 GUI 同源 fetch 触发，实测：

| 环节 | 调用 | 结果 |
|---|---|---|
| 拿到服务 | `ctx.get('sessionController')` | 可用（无需 inject） |
| 列可选会话 | `sc.list({}, signal)` | 145 个会话 ✅ |
| 建会话 | `sc.create({ cwd })` | `session-31f7780e…`，preset `standard` ✅ |
| 投消息 | `sc.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }, AbortSignal.timeout(30000))` | `{accepted:true}` ✅ |
| agent 真跑一轮 | （自动） | `inspect()` 读到 21 个事件，`assistant/message` 内容为「探针成功」、`turn/end completed`、自动生成标题「探针测试」 ✅ |
| 读回历史 | `sc.inspect(sessionId, signal)` | 普通 Promise，返回 `events[]`（从 seq 0），干净 ✅ |
| 归档清理 | `ctx.get('workspaceController').archiveSession({ sessionId })` | 返回完整归档集合（84 个，含探针），只新增指定一个 ✅ |

**两处顾虑全部解除**：
1. source 注入 —— `prompt(request, signal)` 这个 Remote 包装方法**自己构造** `{kind:'user', rpcId:requestId}` 再转给 `commands.prompt`，Host 侧直接调无需注入。
2. 读回回复 —— `inspect()` 即可（普通 Promise）；`follow()` 是长连接 AsyncIterable，`for await` break 会挂住（探针里踩过，evaluate 超时），不适合插件 Host 侧；工作台是 Web UI，也可复用 Client 侧的 Remote 订阅。

**单写者确认**：`prompt` 走 `agent.followup(message)` 正规 inbox，写日志的仍是 agent loop 自己 —— 不会复现 2026-08-23 的 seq 撞车。

### 一处新发现（影响"侧边栏可见"）
探针用 `create({ cwd: /tmp/... })` 建的会话**没出现在侧边栏** —— 侧边栏是「工作区 → 会话」两级结构，临时 cwd 不归属任何工作区。源码确认 `create` 支持 `workspaceId`（走 `ctx.workspaceRegistry.get`，与 cwd 互斥），**正式实现要 `create({ workspaceId })` 把会话建到用户选的工作区里**，才能像网页快照一样挂在侧边栏。工作区列表从 `workspaceController` 拿。

### 实现（已落地）
1. 工作台设置里选一个工作区 → `workspaceController` 列工作区 → `sc.create({ workspaceId })` 建/复用一个专用会话（或 `sc.list()` 让用户选已有会话）
2. 工作台输入框每句话 → `sc.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }, signal)` 投进该会话
3. 该会话的 agent 用全套 skills/工作区指令/模型回答并写日志；工作台用 `sc.inspect(sessionId)`（或 Client 侧 Remote 订阅）读回 `assistant/message` 显示
4. 工作台不再自己存 chat、不再裸调 llm；对话记录天然就是那个会话的日志，侧边栏可见可回溯

**代码位置**：`src/settings.js`（`assistantSession` 字段）、`src/host.js`（`sessionReply()` + `chatTurn` 映射分支 + `GET sessions` / `POST sessions/create`）、`client/desk.js`（`fetchSessions` / `createMappedSession`）、`client/settings.jsx`（映射下拉 + 新建专用会话）。
**真机实测**：设置里选「小红书工具开发」工作区 → 新建专用会话 `session-746853ea…` → 保存 → 工作台发一句话 → 回复 `engine:'session'`（完整 agent 的 3 个标题方向，非 80 字 JSON）；侧边栏出现该会话「AI自媒体工作台小红书标题拟定」，点开对话全文可回溯，自动生成标题、模型 Gemini 3.8 Flash、用时 30 秒。验收截图在 `_work/keep/session-map-*.png`。

**取舍（要跟爸爸确认是否接受）**：
- 映射后**不再解析 ops** —— 真实 agent 没有工具改插件私有 store，「一句话改灵感/排期」失效；改数据请用工作台按钮（或切回「不映射」恢复原助手全功能）
- 映射后模型由**该会话自己**决定，工作台顶栏的「助手模型」按钮不生效
- 工作台仍镜像一份 chat 到 `state.chat` 供 UI 显示，真源是会话日志；「清空对话」只清镜像，不动会话日志
- 每条消息带上工作台数据快照（当前约 1.6K 字符）让 agent 能回答排期/数据类问题；数据涨到 80 条 items 时可考虑改摘要
- 会话失败/2 分钟超时自动降级回本地规则并给出 notice，不会卡死

**当前状态**：映射已开启（指向「小红书工具开发」工作区的专用会话）。切回：设置 → 助手映射会话 → 「不映射（插件自带助手）」→ 保存。

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
