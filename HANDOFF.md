# HANDOFF — dsh-media-desk · 2026-11-08 00:26 +08:00

> Owner 本次决定：先写交接，下一次再开发。此次只整理文档，不继续改功能、不发布笔记、不提交或推送代码。
> 工作目录：`/Users/allbychen/Documents/思悟工作区/projects/dsh-media-desk`。

## 1. 接手先读：当前可用状态

**工作台助手保留在工作台内，映射到用户选择的真实 Harness 会话；Agent 通过工作台工具读写数据，用户可以直接看到界面变化。** 这是 Owner 明确确认的设计。不要再提出“拆掉映射”“去掉输入框”或“只能去主会话操作”。

已实现并验证：

- 选择已有会话，或在指定工作区新建并使用会话；消息由该会话的真实 Agent 处理，使用该会话所属模式、工作区上下文、模型和可用工具。
- 灵感、标题、排期、风格与规则等基础写操作通过 Tool 调用现成的 `applyOps`；复盘可直接查询。
- 工作台内显示所选会话的近期聊天；侧边栏里的同一会话可继续对话，不维护另一套独立 Agent 身份。
- 助手顶部及工作台顶栏有 **「切换会话」**。按真实标题搜索，点击立即生效，不用另点保存。
- 切换时会话名称和聊天记录一起变化；已真机验证两个已有会话来回切换、刷新后选择保留。
- 映射请求等自身轮次真正结束后返回最终回复，不把“我来处理”当完成；失败不再退回本地规则重复执行。

**验证边界：最近一次完整测试为 77 个通过，客户端构建成功，插件已重载生效。发布功能只验证过按钮出现，没有完成真实发布验收。** 本次整理交接未重新跑测试。

## 2. 分支、工作树与安装方式

- 当前分支：`siwu-local`，基于上游 v2.6.1 的本地改版。
- 本次检查到的最新提交：`5d5feab`（旧版会话映射实现）。**今晚的 Tool 接口、轮次等待修复、按标题切换与真实历史展示，都还在工作树中，尚未提交、尚未推送。** 不要误以为 fork 已备份这些新改动。
- 已存在的上游 PR：[woniuniuniu/dsh-media-desk#5](https://github.com/woniuniuniu/dsh-media-desk/pull/5)，原范围为模型自选和创作中心数据抓取。本轮未更新 PR，也未查询其最新审阅状态。
- 当前 profile 通过本地目录链接安装本项目，插件 entry id 为 `include:media-desk`；Web GUI 为 `http://127.0.0.1:3080`。
- 接手先检查 `git status` 和 diff。保留未提交及未跟踪文件，不执行清理工作树、强制回退或直接覆盖。
- 客户端改动需先构建，再通过插件管理器重载并刷新现有 GUI。不要另开服务器来代替验证，也不要在插件管理器直接升级到 npm 版覆盖本地功能。

### 尚未提交的文件

已修改：

- [HANDOFF.md](./HANDOFF.md)
- [client/chat.jsx](./client/chat.jsx)、[client/desk.js](./client/desk.js)
- [client/index.jsx](./client/index.jsx)、[client/settings.jsx](./client/settings.jsx)、[client/modelpick.jsx](./client/modelpick.jsx)
- [client/en/core.js](./client/en/core.js)、[client/styles.css](./client/styles.css)
- [src/host.js](./src/host.js)、[src/en.js](./src/en.js)

新增且未跟踪，后续提交时务必包含：

- [src/tools.js](./src/tools.js)
- [src/session-chat.js](./src/session-chat.js)
- [src/session-history.js](./src/session-history.js)
- [client/sessionpick.jsx](./client/sessionpick.jsx)
- [test/tools.test.js](./test/tools.test.js)
- [test/session-chat.test.js](./test/session-chat.test.js)
- [test/session-history.test.js](./test/session-history.test.js)

过程证据目录也未跟踪；不要用无差别暂存把截图混进代码提交。

## 3. 当前会话映射怎样工作

### 投递与完成判定

[Host 路由](./src/host.js) 接收工作台消息，带工作台快照和当前 `focusId`，调用 [session-chat.js](./src/session-chat.js)：

1. 先订阅 `session/event`。
2. 用 `sessionController.prompt` 投递到选中会话，`mode: queue`，requestId 以 `media-desk-` 开头。
3. 根据该 requestId 对应的用户消息定位轮次。
4. 忽略其他会话、前一轮回复，以及工具执行前的中途说明；等对应 `turn/end` 后返回最终文本。
5. 2 分钟等待超时只提示去所选会话看进度。**超时不等于 Agent 已停止，不能自动重发或执行本地规则。**

消息和日志写入由原 Agent loop 负责，插件不直接追加会话日志。此前“映射会造成第二写者、撞 seq”的顾虑已被正规 inbox 路径的真机验证推翻。

### 历史与切换

[session-history.js](./src/session-history.js)：

- 从 `sessionController.list()` 的标题投影读取名称，附工作区；不再截断到前 80 项。
- 排除子代理及已归档会话；如果当前选择已归档，保留其条目并标明状态。
- 用 `projections()` 获得读取水位，再通过 `page()` 读取最近 60 条消息范围的记录；只展示用户/助手文本，过滤运行时注入、推理及工具内部输出。
- 工作台发出的旧包装消息只展示用户原话，不把整个快照显示成聊天气泡。

[sessionpick.jsx](./client/sessionpick.jsx) 提供选择器；[desk.js](./client/desk.js) 在读取目标历史成功后保存映射。迟到的旧会话请求不得覆盖新会话。

[chat.jsx](./client/chat.jsx) 映射时使用真实会话历史，每 3 秒刷新近期记录。工具执行期间另每 1.2 秒刷新业务状态，最终回复后停止该业务刷新。映射模式下不显示旧插件模型标签；顶栏改为「切换会话」。

**不能把历史测试用的 `session-746853ea…` 写死为当前映射。Owner 随时可切换，运行时应读取设置里的 `assistantSession`。**

### 从哪里提问：Owner 刚确认的使用理解

- 工作台入口会附时间、工作台数据、`focusId` 和说明，Agent 能从消息内容判断来自工作台，减少重复交代背景。
- 当前没有独立的可见“来源标签”；底层仍是用户消息，requestId 前缀可用于定位工作台请求。
- 打开具体笔记后，消息带该对象的上下文，可以说“改这篇标题”“这条排到明晚”；`focusId: null` 表示未选定单篇。
- 两个入口连接的是同一个所选会话。新建或换到其他会话不会自动继承上一会话全部聊天历史；工作台快照也不等于整个页面画面或完整记忆。
- skills 可用不等于已读完；Agent 仍应按任务加载相关技能。

## 4. 工作台工具层

[tools.js](./src/tools.js) 注册三个工具，映射会话和主会话都可用：

| 工具 | 已覆盖能力 |
|---|---|
| `media_desk_state` | 读取真实条目 id、标题、状态、排期、成稿概况、风格/规则/账号概况、指标条数 |
| `media_desk_ops` | 调用原有 `applyOps`，执行灵感增改、排期、风格和规则等结构化操作，沿用字段校验及撤销 |
| `media_desk_insights` | 查询原有复盘汇总 |

不要夸大覆盖范围：目前 state 是摘要，不返回全部成稿/图片内容；Producer 成稿、单图重画和发布尚未封装成上述工具。映射后的 Agent 不能仅凭口头回复声称这些动作已经完成。

实测：工作台输入 → Agent 读状态 → 新建测试灵感 → 改标题及排期 → 回读确认 → 界面显示。测试条目已删除，验证会话记录保留；当时原有 3 条笔记和 48 条指标未修改。

## 5. 其他已存在功能与用户约定

- 插件模型自选仍用于原有裸模型通道；**映射聊天的模型由所选会话决定**。
- 私用「思悟」风格卡保留；未包含在原 PR 范围里。
- 文件桥仍可导出任务，手动“取收件箱”后写回成稿，Host 每 20 秒扫描回填并归档任务/成稿。
- 文件桥协议：frontmatter 的 `itemId / mode / title / coverText / coverPrompt / coverFile / redraw`，正文后可带 `## 图文` 或 `## 分镜`；图文行可用 `说明 | file:xxx.png` 引用既有文件。
- 风格页“抓我的账号”仍走 Monid，不要误称已替换所有 Monid 入口。

### 图文与生图约定

- 提示词表达用途、受众、核心信息、感觉、必需内容和硬规格，不默认替模型钉死构图、光线、字体、景别。
- Owner 明确要求相信模型直接画中文，不要再把“中文不可靠”作为必须 canvas 叠字的理由。仍需检查实际输出。
- 图像表现与精确排版按内容需要混用：需要画面表达时用生图，需要准确对照/步骤/数据排版时可用 guizang。**不强制全部 HTML，也不强制全部生图。**
- 图数由信息量决定，不为凑数扩图。文件桥的图文/分镜截断已去掉；原一键成稿的设置和 `normalizePlan` 仍有数量约束，后续统一检查，不能宣称所有入口都已无限制。
- 最近核实的接口为 magpie 本地 `127.0.0.1:3425/v1`、路由模型 `codex/gpt-image-2.5`；底层具体版本不能仅凭此前“2.6”口头说法认定。不要把密钥写进交接、提示词或日志。

## 6. 定时任务：本次已核对

- **收件箱定时取件已删除**，按 Owner 要求保持关闭，不自动恢复。
- 创作中心抓取仍每天 **13:30 Asia/Shanghai** 运行，id 为 `schedule-c242ad0e-728e-4024-a751-6e869b773895`。
- 发布排期只是工作台标记，不能当作已有自动发布任务。
- 本次未变更任何定时任务。

## 7. 下一次开发优先检查的事项

### A. 整理本轮未提交代码，再决定提交范围

先检查 diff 和新增文件，确认最新使用反馈，重新构建并做对应验证，再按 Owner 要求决定是否提交/推送或扩充 PR。不要只暂存 tracked 文件而漏掉三个新 Host 模块与会话选择组件。

### B. 发布链路：dry-run 已到「填完待发」，只差 Owner 点一次真发（2026-11-08）

Owner 授权规则已经明确：在工作台点“发布”并点“确认发布”，即授权该次发布，不必再追加审批。但这不授权 Agent 为测试随意发布现有草稿。

2026-11-08 已修复并验证到发布前一步：

- 三个实际 bug 已修：① 脚本路径不能作为 `ego-browser nodejs` 参数（路径被当正则，报 `Invalid regular expression flags`）——改为 host 读取脚本+任务 JSON，任务对象注入一次性 stdin 源码；② ego-browser Node 运行时不继承自定义 shell 环境变量——stdin 注入同时绕开；③ **发布页默认开在「上传视频」签，脚本没切「上传图文」就把 PNG 传给了只收视频的上传框**——现在先点视口内可见的「上传图文」签，等图片上传框（accept 含 png，隐藏元素用 DOM 轮询等待）出现再传图。
- 编辑器是 Tiptap（`.tiptap.ProseMirror`），不是旧脚本找的 Quill；输入正文后按 Escape 关掉话题联想下拉再点发布。
- ego API 差异：`waitForFunction(fn, argument, options)` 的 options 是第三个参数；`waitForSelector` 默认等可见元素，隐藏上传框要用 `waitForFunction` 轮询 DOM。
- **dryRun 全链路已验证**：4 张卡片按序上传（缩略图 1-4）、标题（19 字）和正文（含话题标签）填好、手机预览正常，停在发布前；任务支持 `dryRun` 和 `screenshotPath` 字段（失败自动留页面截图）。
- 已提交 `0508b75`。剩余唯一步骤：Owner 在工作台点「发布」→「确认发布」。若再失败，错误里会带失败时页面截图路径。

### C. 数据去重和指标口径

[抓取脚本](./scripts/scrape-creator-centers.mjs) 的小红书缓存键原含 `曝光数`（`xhs:日期:标题:曝光`），曝光一变同一笔记就被当成新笔记重新记基线。**2026-11-08 已部分修复**：

- 缓存键改为 `xhs:发布日期:标题`（稳定内容标识），已有缓存已迁移到新键。
- 2026-11-08 重跑时产生的 18 条重复基线已删除（state.json 改前备份在 `~/.dsh/media-desk/state.json.bak-20261108`），新笔记「快千粉了」的合法首基线保留。
- 同时把固定 sleep 换成 `waitForSelector` 等真实渲染信号 + 解析为空重试一次（13:30 定时任务当天因页面加载慢解析到 0 行而误报，B站正常说明不是登录或改版）。
- 重跑验证：三平台无错误，小红书 19/19 解析，总量对账一致（16,900 = 昨晚 15,838 + 当日新增 807+36+54+165）。

**仍待清理**：更早的多基线行（同一笔记在不同抓取日被记了多条发布日基线，如 11-02 发布的笔记有 139/145 两条）——需按笔记分组保留最新累计、删除旧基线，删除前先逐条核对；历史日趋势图会因此变化，动前再备份一次。分页 `partial`、未知数值变 0 等口径问题一并检查。

### D. 映射会话对模型路由切换敏感（2026-11-08 凌晨实测报错）

工作台映射的会话报 `server_error: ccwitch: the route owning this opaque history is unavailable or conflicts with another state item…`。机制：会话历史含上游通道保存的不透明状态（服务端侧），Harness 默认模型/路由切换后（当晚 codex-first → codex → GLM 来回切），新通道读不到旧通道的状态，拒绝继续。主会话当晚也出过一次同错后自愈。助手按设计透传了真实错误（没有吞掉或乱降级）。

恢复：工作台「切换会话」→「新建并使用」从当前路由重开，或把该会话模型切回原路由；旧历史仍在日志不丢。**下次可做**：助手捕获这类路由错误时直接引导「新建会话」，而不是只透传报错。

### E. 其余按需要排期

- 用户是否还需要扩展成稿/图片读写工具，或在工作台里可视化展示工具执行进度。
- 文件桥、直接 Agent 工具与一键成稿三条路径的分工，避免重复生产和重复消耗。
- 私用风格、技能依赖与通用功能如何隔离后再进入上游 PR。

## 8. 验证、运行和证据

```bash
# 在项目目录执行
node --test test/*.test.js
node scripts/build.mjs
git diff --check
```

最近验证：77 个测试全部通过，覆盖基础功能、工具写入/撤销/取消、轮次关联与超时、会话标题列表及历史过滤。真实界面验证了 Agent 新增/修改/排期，以及两个命名会话切换和刷新持久化；不要把这些测试推及尚未实测的发布功能。

本项目只留两张近期验收证据：

- [工具联调截图](./_work/keep/agent-tools-verified.png)
- [会话切换入口截图](./_work/keep/session-switch-picker.png)

浏览器测试页面已关闭；没有为本次交接创建新的过程文件。旧创作素材在工作区其他位置，交接整理不擅自移动或删除。

运行纪律：复用既有 GUI；不要手改 profile 包配置或在运行中随意移除共享依赖；ego 创建的 DSH 标签用完必须关闭，防止同主机连接池耗尽。旧会话 seq 损坏事故来自跨 Host 双写，不能把它和当前正规 Session inbox 投递混为一谈。
