// dsh-media-desk host 半片：/media-desk/* 接口、文件服务和模型调用。
import { createReadStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assistantModelOverride, callModel, chatPrompts, defaultSelection, extractJson, modelInfo, modelStatus, setAssistantModel } from './ai.js'
import { defaultExportDir, resolveExportDir, saveProduction } from './export.js'
import { harvest, harvestText } from './harvest.js'
import { generateImage } from './images.js'
import { localIntent } from './intents.js'
import { computeInsights, exportSkill, proposeRules } from './learn.js'
import { createMonidRunner, fetchAccount, importPosts, monidStatus, postsToMaterial, resolveAccount, saveCovers } from './monid.js'
import { applyOps, newId } from './ops.js'
import { applyRevision, Producer } from './produce.js'
import { publicSettings, Settings, imageReady } from './settings.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { dshHome, Store } from './store.js'
import { currentLang, platformName, tr, withLang } from './i18n.js'
import { localizeSamples, samplesNeedLocale } from './seed.js'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const MAX_JSON = 4_000_000
const MAX_UPLOAD = 250_000_000
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const UPLOAD_EXT = Object.fromEntries(Object.entries(MIME).filter(([ext]) => ext !== '.jpeg').map(([ext, type]) => [type, ext]))

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBuffer(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error(tr('内容太大')), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = await readBuffer(req, MAX_JSON)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error(tr('请求不是有效的 JSON')), { status: 400 })
  }
}

/** 支持 Range，视频才能正常拖动和循环。 */
async function sendFile(req, res, file) {
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return json(res, 404, { error: tr('不支持的文件类型') })
  let info
  try {
    info = await stat(file)
  } catch {
    return json(res, 404, { error: tr('文件不存在') })
  }
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.setHeader('x-content-type-options', 'nosniff')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  return createReadStream(file).pipe(res)
}

function engineLabel(ctx) {
  const info = modelInfo(ctx)
  return info ? info.label : null
}

const SCRAPE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'scrape-creator-centers.mjs')

// ── 成稿文件桥：灵感导出到 inbox/，主会话的 agent 写完放回，扫描器自动入库 ──

const inboxDir = root => join(root, 'inbox')
const doneDir = root => join(root, 'inbox', 'done')

function styleBrief(style) {
  if (!style) return tr('（未指定风格，按平台常规写法）')
  const lines = [
    tr('- 一句话：{v}', { v: style.summary ?? '' }),
    tr('- 语气：{v}', { v: style.tone ?? '' }),
    tr('- 句式：{v}', { v: style.sentences ?? '' }),
    tr('- 开场：{v}', { v: style.opening ?? '' }),
    tr('- 结构：{v}', { v: style.structure ?? '' }),
    tr('- 常用词：{v}', { v: (style.words ?? []).join('、') }),
    tr('- 禁用词：{v}', { v: (style.avoid ?? []).join('、') }),
    ...(style.samples ?? []).length ? [tr('- 样句：{v}', { v: style.samples.join(' / ') })] : [],
  ]
  return [tr('风格「{name}」：', { name: style.name }), ...lines].join('\n')
}

/** 导出一条灵感到 inbox，等主会话的 agent 取件写作。重复导出会覆盖旧任务。 */
export async function exportDraft(store, body) {
  const state = await store.read()
  const item = state.items.find(row => row.id === body.id)
  if (!item) throw Object.assign(new Error(tr('灵感不存在')), { status: 404 })
  if (item.production?.status === 'running') throw Object.assign(new Error(tr('这条灵感正在成稿，等它结束')), { status: 409 })
  const style = state.styles?.find(row => row.id === state.activeStyleId) ?? state.styles?.find(row => row.preset && item.platform && row.category) ?? null
  const brief = [
    '---',
    `itemId: ${item.id}`,
    `platform: ${item.platform ?? ''}`,
    `styleName: ${style?.name ?? ''}`,
    `createdAt: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${item.title}`,
    '',
    item.body ?? '',
    '',
    '## 风格卡',
    '',
    styleBrief(style),
  ].join('\n')
  await mkdir(inboxDir(store.root), { recursive: true })
  const file = join(inboxDir(store.root), `任务-${item.id}.md`)
  await writeFile(file, brief, 'utf8')
  return { path: file, itemId: item.id }
}

/** 解析成稿文件的 frontmatter、正文和可选的分镜段落。 */
export function parseDraft(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown)
  if (!match) return null
  const meta = {}
  for (const line of match[1].split('\n')) {
    const pair = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (pair) meta[pair[1]] = pair[2].trim()
  }
  let body = match[2].trim()
  const shots = []
  const gallery = []
  for (const [heading, sink] of [['## 分镜', shots], ['## 图文', gallery]]) {
    const at = body.indexOf(heading)
    if (at < 0) continue
    const text = body.slice(at + heading.length).trim()
    body = body.slice(0, at).trim()
    for (const [index, line] of text.split('\n').map(row => row.trim()).filter(Boolean).entries()) {
      const [visual, voice = ''] = line.replace(/^\d+[.、]\s*/, '').split('|').map(part => part.trim())
      if (!visual) continue
      if (heading === '## 分镜') shots.push({ no: index + 1, shot: '画面', visual, voice, seconds: 5, prompt: visual, status: 'idle' })
      else gallery.push({ caption: visual.slice(0, 24), prompt: voice || visual, status: 'idle' })
    }
  }
  return { meta, body, shots, gallery }
}

/** 扫描 inbox 里的成稿文件，回填到对应灵感并触发缺图重画。 */
export async function scanInbox(store, desk) {
  let files = []
  try {
    files = (await readdir(inboxDir(store.root))).filter(name => /^成稿-[\w-]+\.md$/.test(name))
  } catch {
    return
  }
  for (const name of files) {
    try {
      const parsed = parseDraft(await readFile(join(inboxDir(store.root), name), 'utf8'))
      const itemId = parsed?.meta.itemId
      if (!parsed || !itemId) throw new Error(tr('frontmatter 缺 itemId'))
      const revise = {
        title: parsed.meta.title,
        coverText: parsed.meta.coverText,
        article: parsed.body,
      }
      const label = tr('思悟成稿入库：{title}', { title: String(revise.title || name).slice(0, 20) })
      const targets = []
      const drawReady = desk ? imageReady(await desk.settings.read()) : false
      await store.mutate(label, (draft) => {
        const item = draft.items.find(row => row.id === itemId)
        if (!item) throw new Error(tr('灵感 {id} 不存在，成稿文件留在 inbox', { id: itemId }))
        if (item.production?.status === 'running') throw new Error(tr('灵感 {id} 正在成稿，跳过回填', { id: itemId }))
        if (!item.production || item.production.stage === 'brief') {
          item.production = { status: 'done', stage: 'making', title: item.title, article: '', coverText: '', cover: null, images: [], shots: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), external: true }
        }
        const { receipts } = applyRevision(item.production, revise, { canDraw: false })
        item.production.external = true
        // 生图接口已接入时，把缺的画布建出来交给 Producer 画；redraw: cover,shots 可强制重画
        // 封面提示词优先用成稿文件里的 coverPrompt（作者从正文提取的核心画面），没有才退回标题模板
        if (drawReady) {
          const prod = item.production
          const redraw = String(parsed.meta.redraw ?? '').split(',').map(row => row.trim()).filter(Boolean)
          const coverPromptText = parsed.meta.coverPrompt ?? tr('为《{title}》画一张封面图，核心信息是「{cover}」', { title: prod.title ?? '', cover: prod.coverText ?? '' })
          if (redraw.includes('cover') && prod.cover?.status === 'done') prod.cover = null
          if (!prod.cover) {
            prod.cover = { prompt: coverPromptText, status: 'idle' }
            targets.push('cover')
          }
          if (parsed.shots.length && (redraw.includes('shots') || !prod.shots?.length)) {
            prod.shots = parsed.shots.slice(0, 12)
            prod.shots.forEach((_, index) => targets.push(`shot:${index}`))
          }
          // 图文模式：## 图文 段落的每张内页图（caption 存图上大字），交给生图链路画底图
          if (parsed.gallery.length && (redraw.includes('gallery') || !prod.images?.length)) {
            prod.images = parsed.gallery.slice(0, 9)
            prod.images.forEach((_, index) => targets.push(`image:${index}`))
          }
          if (parsed.gallery.length) prod.mode = 'gallery'
        }
        return { receipts, errors: [], state: draft }
      }, { undoable: false })
      await mkdir(doneDir(store.root), { recursive: true })
      await rename(join(inboxDir(store.root), name), join(doneDir(store.root), name))
      // 对应的任务文件一起归档，避免被重复取件
      await rename(join(inboxDir(store.root), `任务-${itemId}.md`), join(doneDir(store.root), `任务-${itemId}.md`)).catch(() => {})
      // 异步画图，不阻塞扫描
      for (const target of targets) desk?.producer?.regenerate(itemId, target).catch(() => {})
    } catch (err) {
      // 单个文件失败不阻塞其他文件；错误留在原位等人工看
      console.error('[media-desk] inbox 回填失败:', name, err.message)
    }
  }
}

/**
 * 拉起 ego-browser 跑创作中心抓取脚本，返回 SCRAPE_RESULT 摘要。
 * ego-browser 的命令行通常在 ~/.local/bin，桌面端 PATH 短，找不到就试绝对路径。
 */
async function runScrape(desk) {
  if (desk.scraping) throw Object.assign(new Error(tr('上一次抓取还没结束，等它跑完再试')), { status: 409 })
  desk.scraping = true
  try {
    const candidates = ['ego-browser', join(homedir(), '.local', 'bin', 'ego-browser')]
    let bin = null
    for (const c of candidates) {
      try { await access(c); bin = c; break } catch { /* 下一个 */ }
    }
    if (!bin) bin = candidates[0] // 交给 spawn 报错
    const input = await open(SCRAPE_SCRIPT, 'r')
    try {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(bin, ['nodejs'], { stdio: [input.fd, 'pipe', 'pipe'], env: { ...process.env, MEDIA_DESK_HOME: desk.storeRoot } })
        let text = ''
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(tr('抓取超时（5 分钟），ego 浏览器可能没开'))) }, 300_000)
        child.stdout.on('data', d => { text += d })
        child.stderr.on('data', d => { text += d })
        child.on('error', err => { clearTimeout(timer); reject(err) })
        child.on('close', () => { clearTimeout(timer); resolve(text) })
      })
      const match = /^SCRAPE_RESULT (\{[\s\S]+\})$/m.exec(output)
      if (!match) throw new Error(tr('抓取脚本没有给出结果：{tail}', { tail: output.trim().slice(-300) }))
      return JSON.parse(match[1])
    } finally {
      await input.close().catch(() => {})
    }
  } finally {
    desk.scraping = false
  }
}

/** 同一次故障只提醒一次，用人话说。原始错误放在模型状态的提示里。 */
function outageNotice(ctx, wasDown, fallback) {
  if (wasDown) return null
  return modelInfo(ctx) ? tr('模型暂时用不了，{fallback}。可以到设置里检查账号或密钥。', { fallback }) : tr('当前没有连接模型，{fallback}。', { fallback })
}

async function chatTurn(ctx, store, desk, body) {
  const message = String(body.message || '').trim()
  if (!message) throw Object.assign(new Error(tr('消息为空')), { status: 400 })
  const focusId = typeof body.focusId === 'string' ? body.focusId : undefined
  const state = await store.read()
  const snapshot = JSON.parse(JSON.stringify(state))
  let plan
  let engine = 'local'
  let notice = null
  const wasDown = modelStatus.ok === false
  try {
    const history = snapshot.chat.filter(row => (row.itemId ?? null) === (focusId ?? null))
    const { system, user } = chatPrompts(snapshot, message, { focusId, history })
    const editing = snapshot.items.find(row => row.id === focusId)?.production?.status === 'done'
    const { text, model } = await callModel(ctx, { system, user, maxTokens: editing ? 8000 : 2000, light: true, signal: AbortSignal.timeout(editing ? 240_000 : 90_000) })
    engine = model
    try {
      plan = extractJson(text)
      if (typeof plan.reply !== 'string') plan.reply = tr('处理好了。')
    } catch {
      // 模型只回了一段话时，当成普通回答，不算失败
      plan = { reply: text.trim().slice(0, 1200) || tr('我没有听懂，可以换个说法吗？'), ops: [] }
    }
  } catch {
    notice = outageNotice(ctx, wasDown, tr('先用本地规则处理'))
    plan = localIntent(snapshot, message, { focusId })
  }
  const settings = await desk.settings.read()
  const canDraw = imageReady(settings)
  // 只把真正改了数据的那一步放进撤销；问一句话不占撤销位
  const changed = await store.mutate(tr('对话：{text}', { text: message.slice(0, 18) }), (draft) => {
    const target = focusId ? draft.items.find(row => row.id === focusId) : null
    const production = target?.production?.status === 'done' ? target.production : null
    // 本地规则只会改灵感标题；有成稿时要改的是成稿标题
    const ops = (Array.isArray(plan.ops) ? plan.ops : []).map((op) => {
      if (production && op?.op === 'update_item' && op.id === focusId && typeof op.title === 'string') return { op: 'update_production', id: focusId, title: op.title }
      return op
    })
    const { receipts, errors } = applyOps(draft, ops)
    let targets = []
    if (production && plan.revise) {
      // 没接生图时，图不会重画，回执要说实话
      const revision = applyRevision(production, plan.revise, { canDraw })
      receipts.push(...revision.receipts.map(text => ({ text })))
      errors.push(...revision.errors)
      targets = canDraw ? revision.targets : []
    }
    return { receipts, errors, targets, done: Boolean(production) }
  })
  const result = await store.mutate('对话记录', (draft) => {
    const { receipts, errors, targets, done } = changed
    const at = new Date().toISOString()
    const itemId = focusId ?? undefined
    // 已经做好的成稿不会因为一句话被整篇重做，要重做请点「重新成稿」
    const actions = (Array.isArray(plan.actions) ? plan.actions : [])
      .filter(a => a && ['produce', 'open', 'nav'].includes(a.type))
      .filter(a => !(a.type === 'produce' && (done && a.id === focusId || draft.items.find(row => row.id === a.id)?.production?.status === 'done')))
    draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId })
    const answer = { id: newId('c'), at, role: 'assistant', text: plan.reply, receipts, errors, engine, notice, undoable: receipts.length > 0, itemId }
    draft.chat.push(answer)
    draft.chat = draft.chat.slice(-300)
    return { answer, actions, targets, state: draft, modelOk: modelStatus.ok, modelError: modelStatus.error }
  }, { undoable: false })
  if (canDraw) {
    await Promise.all(result.targets.map(target => desk.producer.regenerate(focusId, target).catch(() => {})))
    return { ...result, state: await store.read() }
  }
  return result
}

async function extractStyle(ctx, store, body) {
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(row => String(row).trim()).filter(Boolean).slice(0, 5)
  const parts = [String(body.text ?? '').trim()].filter(Boolean)
  const failures = []
  for (const url of urls) {
    try {
      const page = await harvestText(url)
      if (page.text.length >= 80) parts.push(`${page.title ?? ''}\n${page.text}`)
      else failures.push(tr('{url}：页面上几乎没有文字，可能需要登录', { url }))
    } catch (err) {
      failures.push(tr('{url}：{error}', { url, error: err.message }))
    }
  }
  const material = parts.join('\n\n---\n\n')
  if (material.length < 80) {
    throw Object.assign(new Error(failures.length ? tr('抓不到内容。{reason}。可以把内容直接贴进来。', { reason: failures[0] }) : tr('内容太少了，至少贴一段完整的文字')), { status: 400 })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
  const source = urls.length && parts.length === urls.length ? tr('链接') : urls.length ? tr('内容和链接') : tr('内容')
  return styleFromMaterial(ctx, store, { material, name, source, sourceUrls: urls, failures })
}

/** 提炼一张风格卡并设为当前风格。同一个账号再抓一次时更新原来那张。 */
async function styleFromMaterial(ctx, store, { material, name, source, sourceUrls = [], failures = [], accountKey = null }) {
  let style
  try {
    const { system, user } = stylePrompts(material, name)
    const { text } = await callModel(ctx, { system, user, maxTokens: 1500, light: true, signal: AbortSignal.timeout(120_000) })
    style = normalizeStyle(extractJson(text), name)
  } catch (err) {
    throw Object.assign(new Error(tr('提炼风格需要文字模型：{error}', { error: err.message })), { status: 502 })
  }
  return store.mutate(tr('提炼风格「{name}」', { name: style.name }), (draft) => {
    const existing = accountKey ? (draft.styles ?? []).find(row => row.accountKey === accountKey) : null
    const id = existing?.id ?? newId('st')
    const row = { id, ...style, source, sourceUrls, ...(accountKey ? { accountKey } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() }
    draft.styles = existing ? draft.styles.map(entry => (entry.id === id ? row : entry)) : [row, ...(draft.styles ?? [])]
    draft.activeStyleId = id
    return { id, failures, state: draft }
  })
}

/** 导入用户自己的账号。钱花在 Monid 上，所以先把内容存好，提炼失败也不会白花。 */
async function importAccountRoute(ctx, store, desk, body) {
  if (desk.importing) throw Object.assign(new Error(tr('上一个账号还在导入，等它结束再试')), { status: 409 })
  desk.importing = true
  try {
    const account = await resolveAccount(body.text)
    const { posts, profile, cost } = await fetchAccount(account, desk.monid)
    const covers = await saveCovers(posts, account.platform, await store.read(), store.filesDir)
    const added = await store.mutate(tr('导入{platform}账号', { platform: platformName(account.platform) }), draft => importPosts(draft, { account, profile, posts, covers }).added)
    const nickname = profile.nickname || platformName(account.platform)
    let styleError = null
    const material = postsToMaterial(posts)
    if (material.length >= 80) {
      try {
        await styleFromMaterial(ctx, store, { material, name: nickname, source: tr('{platform}账号', { platform: platformName(account.platform) }), sourceUrls: [account.url], accountKey: `${account.platform}:${account.id}` })
      } catch (err) {
        styleError = err.message
      }
    } else {
      styleError = tr('这个账号的文字太少，提炼不出风格')
    }
    return { platform: account.platform, nickname, count: posts.length, added, cost, styleName: styleError ? null : nickname, styleError, state: await store.read() }
  } finally {
    desk.importing = false
  }
}

async function addFromUrl(ctx, store, body) {
  const url = String(body.url || '').trim()
  const info = await harvest(url)
  const op = {
    op: 'add_item', kind: 'web', title: body.title || info.title || url, body: body.note || info.description || '', url: info.url, source: info.siteName, tags: Array.isArray(body.tags) ? body.tags : [],
    media: info.image ? { src: info.image } : null,
  }
  return store.mutate(tr('收藏《{title}》', { title: op.title.slice(0, 12) }), (draft) => {
    const { receipts, errors } = applyOps(draft, [op])
    return { receipts, errors, id: receipts[0]?.target, state: draft }
  })
}

async function refreshAccount(store, body) {
  const url = String(body.url || '').trim()
  const now = new Date().toISOString()
  let patch
  try {
    const info = await harvest(url)
    patch = { url: info.url, title: info.title ?? undefined, description: info.description ?? undefined, avatar: info.image ?? undefined, fetchedAt: now, fetchError: '', ...(info.followers ? { followers: info.followers } : {}) }
  } catch (err) {
    patch = { url, fetchedAt: now, fetchError: err.message }
  }
  return store.mutate(tr('更新账号档案'), (draft) => {
    const op = body.id ? { op: 'update_account', id: body.id, ...patch } : { op: 'add_account', platform: body.platform ?? '', handle: body.handle ?? '', ...patch }
    const { errors } = applyOps(draft, [op])
    return { state: draft, errors, fetchError: patch.fetchError || null }
  })
}

async function handleUpload(req, store, res) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = UPLOAD_EXT[type]
  if (!ext) return json(res, 415, { error: tr('不支持这种文件：{type}', { type: type || tr('未知') }) })
  const buffer = await readBuffer(req, MAX_UPLOAD)
  await store.read()
  const name = `${newId('f')}${ext}`
  await writeFile(join(store.filesDir, name), buffer)
  return json(res, 200, { src: `media-desk/files/${name}`, kind: type.startsWith('video/') ? 'video' : 'image' })
}

async function route(ctx, store, desk, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/^\/media-desk\/?/, '')
  const method = req.method || 'GET'

  if ((method === 'GET' || method === 'HEAD') && path.startsWith('assets/')) {
    const name = path.slice('assets/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    return sendFile(req, res, join(ASSETS_DIR, name))
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('files/')) {
    const name = path.slice('files/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    await store.read()
    return sendFile(req, res, join(store.filesDir, name))
  }
  if (method === 'GET') {
    if (path === 'state') {
      if (!desk.settled) { desk.settled = true; await desk.producer.settleAll().catch(() => {}) }
      let state = await store.read()
      // 示例数据跟着界面语言走；用户自己的内容不动
      if (samplesNeedLocale(state, currentLang())) state = await store.mutate('', draft => (localizeSamples(draft, currentLang()), draft), { undoable: false })
      return json(res, 200, { state, model: engineLabel(ctx), modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: store.undo.length > 0 })
    }
    if (path === 'production') {
      const id = url.searchParams.get('id') ?? ''
      await desk.producer.settle(id)
      const state = await store.read()
      const item = state.items.find(row => row.id === id)
      return json(res, 200, { production: item?.production ?? null, status: item?.status, live: desk.producer.status(id) })
    }
    if (path === 'settings') return json(res, 200, { ...publicSettings(await desk.settings.read()), defaultExportDir: defaultExportDir() })
    if (path === 'models') {
      // 列出 Harness 里已接的提供方和它们公布的模型，给工作台的助手模型选择器用
      const llm = ctx.get('llm')
      const providers = llm ? await llm.listProviders() : []
      const settled = await Promise.allSettled(providers.map(async p => ({
        provider: p.id, name: p.name,
        models: (await llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name || m.id })),
      })))
      return json(res, 200, {
        providers: settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(p => p.models.length),
        default: defaultSelection(ctx),
        current: assistantModelOverride(),
      })
    }
    if (path === 'insights') return json(res, 200, computeInsights(await store.read()))
    if (path === 'monid/status') return json(res, 200, await monidStatus(desk.monid))
    return json(res, 404, { error: tr('接口不存在') })
  }
  if (method !== 'POST') return json(res, 405, { error: tr('不支持的方法') })

  // 所有写操作都拒绝跨站请求
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: tr('拒绝跨站请求') })

  if (path === 'upload') return handleUpload(req, store, res)
  const body = await readJson(req)
  switch (path) {
    case 'ops': {
      const label = typeof body.label === 'string' ? body.label : tr('操作')
      const result = await store.mutate(label, (draft) => {
        const applied = applyOps(draft, body.ops)
        return { ...applied, state: draft }
      }, { undoable: body.undoable !== false })
      return json(res, 200, result)
    }
    case 'undo': {
      const label = await store.undoLast()
      return json(res, 200, { label, state: await store.read(), canUndo: store.undo.length > 0 })
    }
    case 'chat': return json(res, 200, await chatTurn(ctx, store, desk, body))
    case 'chat/clear': {
      const state = await store.mutate('清空对话', (draft) => { draft.chat = []; return draft }, { undoable: false })
      return json(res, 200, { state })
    }
    case 'produce': {
      const started = await desk.producer.start(String(body.id))
      return json(res, 200, { started, state: await store.read() })
    }
    case 'produce/cancel':
      await desk.producer.cancel(String(body.id))
      return json(res, 200, { ok: true })
    case 'produce/regen':
      await desk.producer.regenerate(String(body.id), body.target)
      return json(res, 200, { state: await store.read() })
    case 'produce/save': {
      const settings = await desk.settings.read()
      const state = await store.read()
      const item = state.items.find(row => row.id === body.id)
      if (!item?.production?.article) return json(res, 400, { error: tr('还没有可以保存的成稿') })
      await store.read()
      // 视频封面由浏览器合成（画面叠大字），这里只接受 JPEG
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.videoCover ?? '')
      const videoCover = match ? Buffer.from(match[1], 'base64') : null
      if (videoCover && !(videoCover[0] === 0xff && videoCover[1] === 0xd8)) return json(res, 400, { error: tr('封面不是有效的图片') })
      const saved = await saveProduction(item.production, { filesDir: store.filesDir, exportDir: resolveExportDir(settings.exportDir), videoCover })
      const next = await store.mutate('保存成稿', (draft) => {
        const target = draft.items.find(row => row.id === body.id)
        if (target?.production) {
          target.production.savedPath = saved.path
          target.production.savedAt = new Date().toISOString()
        }
        return draft
      }, { undoable: false })
      return json(res, 200, { ...saved, state: next })
    }
    case 'produce/reveal': {
      // 路径只取自保存记录，不接受请求里传来的路径
      const state = await store.read()
      const path = state.items.find(row => row.id === body.id)?.production?.savedPath
      if (!path) return json(res, 400, { error: tr('还没有保存过') })
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      execFile(command, [path], () => {})
      return json(res, 200, { path })
    }
    case 'style/extract': return json(res, 200, await extractStyle(ctx, store, body))
    case 'export-draft': return json(res, 200, await exportDraft(store, body))
    case 'scrape': {
      const result = await runScrape(desk)
      return json(res, 200, { ...result, state: await store.read() })
    }
    case 'monid/import': return json(res, 200, await importAccountRoute(ctx, store, desk, body))
    case 'settings': {
      const updated = await desk.settings.update(body)
      setAssistantModel(updated.assistant)
      return json(res, 200, { ...publicSettings(updated), defaultExportDir: defaultExportDir(), assistantEffective: modelInfo(ctx)?.label ?? null })
    }
    case 'settings/test': {
      const settings = await desk.settings.read()
      if (!imageReady(settings)) return json(res, 400, { error: tr('先填好接口地址、模型和密钥') })
      await store.read()
      const { buffer, ext } = await generateImage(settings.image, 'A single paper boat on calm water, black and white pencil line art sketch, plain white paper background, no text.')
      const name = `${newId('t')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      return json(res, 200, { src: `media-desk/files/${name}` })
    }
    case 'capture-url': return json(res, 200, await addFromUrl(ctx, store, body))
    case 'account/refresh': return json(res, 200, await refreshAccount(store, body))
    case 'skills/learn': {
      const proposals = proposeRules(await store.read())
      if (!proposals.length) return json(res, 200, { added: 0, state: await store.read() })
      const state = await store.mutate(tr('从数据中学习'), (draft) => {
        // 只用示例数据算出来的建议也算示例，清空示例时一起清掉，也不会被导出
        const fromSamples = !draft.metrics.some(metric => !metric.sample)
        const { receipts } = applyOps(draft, proposals.map(row => ({ op: 'add_skill', ...row, status: 'proposed' })))
        if (fromSamples) for (const receipt of receipts) { const skill = draft.skills.find(row => row.id === receipt?.target); if (skill) skill.sample = true }
        return draft
      })
      return json(res, 200, { added: proposals.length, state })
    }
    case 'skills/export': {
      const state = await store.read()
      const result = await exportSkill(state, dshHome())
      const next = await store.mutate('导出 Skill', (draft) => {
        applyOps(draft, draft.skills.filter(s => !s.sample && s.status === 'active').map(s => ({ op: 'update_skill', id: s.id, status: 'exported' })))
        return draft
      }, { undoable: false })
      return json(res, 200, { ...result, state: next })
    }
    default: return json(res, 404, { error: tr('接口不存在') })
  }
}

/**
 * Web 服务不会替插件路由鉴权，所以每个请求都要自己走一遍 Host/Origin 和登录凭证检查。
 * 拿不到鉴权服务时一律拒绝。
 * @param {object} ctx - Cordis 上下文。
 * @param {{headers: object}} req - HTTP 请求。
 * @returns {number|undefined} 拒绝时的状态码；可以继续时为 undefined。
 */
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

export const name = 'dsh-media-desk'

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const store = new Store()
    const settings = new Settings(store.root)
    const producer = new Producer({ store, settings, callText: options => callModel(ctx, options), generate: generateImage })
    const monid = createMonidRunner()
    const desk = { settings, producer, monid, storeRoot: store.root }
    // 启动时恢复用户在工作台里选过的助手模型
    settings.read().then(saved => setAssistantModel(saved.assistant)).catch(() => {})
    // 成稿文件桥：启动扫一次，之后每 20 秒看一眼 inbox。unref 让定时器不持事件循环，测试进程能正常退出。
    const inboxTimer = setInterval(() => { scanInbox(store, desk).catch(() => {}) }, 20_000)
    inboxTimer.unref?.()
    scanInbox(store, desk).catch(() => {})
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/media-desk',
      handler: async (req, res) => {
        try {
          const rejection = requestRejection(ctx, req)
          if (rejection) {
            json(res, rejection, { error: tr('未授权') })
            return
          }
          await withLang(req.headers['x-media-desk-lang'], () => route(ctx, store, desk, req, res))
        } catch (err) {
          if (res.headersSent) {
            res.end()
            return
          }
          json(res, err.status || 500, { error: err.message })
        }
      },
    }), 'dsh-media-desk: /media-desk routes')
    return () => clearInterval(inboxTimer)
  },
}
