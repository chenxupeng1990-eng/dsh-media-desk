// 创作中心数据抓取：小红书（内容分析·逐笔记累计→增量）、B站（首页昨日增量）、抖音（数据中心·昨天）。
// 用法：ego-browser nodejs < scripts/scrape-creator-centers.mjs
// 环境变量：MEDIA_DESK_GUI（DSH 网页版地址，默认 http://127.0.0.1:3080）、MEDIA_DESK_HOME（数据目录，默认 ~/.dsh/media-desk）。
// 结果：最后一行输出 SCRAPE_RESULT {json}；写入走 DSH GUI 标签页的同源 fetch（带用户会话）。
// 去重：数据目录下的 scrape-cache.json 记录已写入的键与逐笔记累计值，重复跑不会重复写。
const fs = await import('node:fs/promises')
const { join } = await import('node:path')
const { homedir } = await import('node:os')

const CACHE_FILE = join(process.env.MEDIA_DESK_HOME ?? join(homedir(), '.dsh', 'media-desk'), 'scrape-cache.json')
const GUI_URL = process.env.MEDIA_DESK_GUI ?? 'http://127.0.0.1:3080'
const RUN_DATE = new Date().toLocaleDateString('sv-SE') // 本地 YYYY-MM-DD

// 干跑：只抓取并打印沉淀表快照，不写工作台、不写缓存、不写沉淀表。用法见 HANDOFF（stdin 前加 globalThis.__MEDIA_DESK_DRY = true;）。
const DRY = globalThis.__MEDIA_DESK_DRY === true
const summary = { date: RUN_DATE, written: 0, platforms: {}, errors: [] }
// 沉淀表快照：内容每日快照 / 账号每日快照。空（null）= 后台没给，不写成 0。
const snap = { content: [], account: [] }
const num = s => Number(String(s ?? '').replace(/,/g, '')) || 0
/** 「8.90%」→ 8.9；「-」「--」→ null。 */
const pctNum = s => { const m = /(-?\d+(?:\.\d+)?)\s*%/.exec(String(s ?? '')); return m ? Number(m[1]) : null }
/** 「38s」「6秒」「1分2秒」「13.5小时」→ 秒。 */
const secNum = (s) => {
  let total = 0
  let hit = false
  for (const [, v, u] of String(s ?? '').matchAll(/(\d+(?:\.\d+)?)\s*(小时|h|分钟|分|min|秒|s)/g)) {
    total += Number(v) * (/小时|h/.test(u) ? 3600 : /分|min/.test(u) ? 60 : 1)
    hit = true
  }
  return hit ? Math.round(total * 100) / 100 : null
}
/** 「2,503」「1.6万」→ 数；「-」→ null。万 是后台四舍五入的近似值。 */
const bigNum = (s) => {
  const m = /^\s*(-?[\d,]+(?:\.\d+)?)\s*(万|k|K)?/.exec(String(s ?? '').replace(/[高低]$/, ''))
  if (!m) return null
  const value = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(value) ? Math.round(value * ({ 万: 1e4, k: 1e3, K: 1e3 }[m[2]] ?? 1)) : null
}
/** 从一段规整过空白的文字里，取「标签 值」的值。 */
const after = (text, label) => new RegExp(`${label}\\s*(-?[\\d.,]+(?:万|k|K)?%?(?:小时|分钟|秒|s)?)`).exec(text)?.[1] ?? null
const iso = date => new Date(`${date}T12:00:00+08:00`).toISOString()

async function readCache() {
  try { return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) } catch { return { notes: {}, days: {} } }
}

function isLoginWall(text) {
  return /扫码登录|登录后|手机号登录|验证码登录/.test(text.slice(0, 2000))
}

/** 小红书：内容分析表，逐笔记累计值。首次见的笔记按发布日期记存量，之后记增量。 */
async function scrapeXhs(page, cache, rows) {
  await page.goto('https://creator.xiaohongshu.com/statistics/data-analysis', { timeout: 45000 }).catch(() => {})
  // 等表格真正渲染，别用固定 sleep——加载慢的那天表格会晚几秒出现
  await page.waitForSelector('table tbody tr', { timeout: 25000 }).catch(() => {})
  // 一页 50 条，免去翻页
  await page.evaluate(() => {
    const leaf = txt => [...document.querySelectorAll('li, div, span')].find(e => e.children.length === 0 && (e.textContent || '').trim() === txt)
    leaf('10 条/页')?.click()
  })
  await new Promise(r => setTimeout(r, 1500))
  await page.evaluate(() => {
    const leaf = txt => [...document.querySelectorAll('li, div, span')].find(e => e.children.length === 0 && (e.textContent || '').trim() === txt)
    leaf('50 条/页')?.click()
  })
  await new Promise(r => setTimeout(r, 4000))
  // 在页面里执行，不能引用外面的变量。列序：曝光 观看 封面点击率 点赞 评论 收藏 涨粉 分享 人均观看时长 弹幕
  const readNotes = () => {
    const out = []
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const t = (tr.innerText || '').replace(/\s+/g, ' ').trim()
      const m = /(.+?)发布于(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)%\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+(\S+)\s+([\d,]+)/.exec(t)
      if (!m) continue
      out.push({ title: m[1].trim().slice(0, 60), date: m[2], exposure: m[3], views: m[4], ctr: m[5], likes: m[6], comments: m[7], saves: m[8], follows: m[9], shares: m[10], avgWatch: m[11], danmaku: m[12] })
    }
    return { total: Number(/共 (\d+) 条/.exec(document.body.innerText)?.[1]) || 0, rows: out }
  }
  const notes = await page.evaluate(readNotes)
  // 表格偶发晚到或切分页时重渲染：解析为空就再等一次重试，而不是直接报错
  if (!notes.rows.length) {
    await new Promise(r => setTimeout(r, 6000))
    notes.rows = (await page.evaluate(readNotes)).rows
  }
  if (!notes.rows.length) {
    const text = await page.evaluate(() => document.body.innerText)
    if (isLoginWall(text)) throw new Error('小红书登录失效，需要在 ego 浏览器里重新登录')
    throw new Error('小红书内容分析页没解析到笔记表格（页面结构可能变了）')
  }
  let fresh = 0, delta = 0
  const seen = {}
  for (const n of notes.rows) {
    const cur = { views: num(n.views), likes: num(n.likes), comments: num(n.comments), saves: num(n.saves), shares: num(n.shares) }
    // 键里不能带曝光等会随时间增长的累计值，否则每天都会被当成新笔记重复入账
    const base = `xhs:${n.date}:${n.title}`
    seen[base] = (seen[base] ?? 0) + 1
    const key = seen[base] > 1 ? `${base}#${seen[base]}` : base // 同一天同标题的笔记按出现顺序区分
    snap.content.push({
      platform: '小红书', contentKey: key, title: n.title, publishedAt: n.date,
      impressions: bigNum(n.exposure), views: bigNum(n.views), ctr: pctNum(`${n.ctr}%`), likes: bigNum(n.likes), comments: bigNum(n.comments),
      saves: bigNum(n.saves), shares: bigNum(n.shares), follows: bigNum(n.follows), avgWatchSec: secNum(n.avgWatch), danmaku: bigNum(n.danmaku),
    })
    const prev = cache.notes[key]
    if (!prev) {
      rows.push({ platform: '小红书', date: iso(n.date), ...cur })
      cache.notes[key] = cur
      fresh++
    } else {
      const d = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.max(0, v - (prev[k] || 0))]))
      if (Object.values(d).some(v => v > 0)) {
        rows.push({ platform: '小红书', date: iso(RUN_DATE), ...d })
        delta++
      }
      cache.notes[key] = cur
    }
  }
  summary.platforms['小红书'] = { notes: notes.rows.length, of: notes.total, baseline: fresh, increments: delta, partial: notes.rows.length < notes.total || undefined }
}

/** B站：首页「视频数据」的昨日增量（统计截至前一日的单日口径）。 */
async function scrapeBili(page, cache, rows) {
  await page.goto('https://member.bilibili.com/platform/home', { timeout: 45000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 6000))
  const data = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ')
    const cut = /统计截至：(\d{4}-\d{2}-\d{2})/.exec(t)?.[1]
    const seg = t.slice(t.indexOf('视频数据'), t.indexOf('粉丝概览') > 0 ? t.indexOf('粉丝概览') : undefined)
    const grab = label => {
      const m = new RegExp(label + ' ([\\d,]+)').exec(seg)
      return m ? m[1] : null
    }
    return {
      cut, views: grab('播放量'), comments: grab('评论'), likes: grab('点赞'), shares: grab('分享'), saves: grab('收藏'),
      fans: /粉丝总数\s*([\d,]+)/.exec(t)?.[1] ?? null, fansDelta: /今日粉丝数变化\s*([+-]?[\d,]+)/.exec(t)?.[1] ?? null,
    }
  })
  if (data.fans !== null) snap.account.push({ platform: 'B站', window: '当日', followers: bigNum(data.fans), followerNet: data.fansDelta === null ? null : Number(data.fansDelta.replace(/,/g, '')) })
  if (!data.cut || data.views === null || data.likes === null) {
    const text = await page.evaluate(() => document.body.innerText)
    if (isLoginWall(text)) throw new Error('B站登录失效，需要在 ego 浏览器里重新登录')
    throw new Error('B站首页没解析到昨日增量（页面结构可能变了）')
  }
  const key = `bili:${data.cut}`
  if (cache.days[key]) {
    summary.platforms['B站'] = { date: data.cut, skipped: '已写过' }
    return
  }
  rows.push({ platform: 'B站', date: iso(data.cut), views: num(data.views), likes: num(data.likes), comments: num(data.comments), shares: num(data.shares), saves: num(data.saves) })
  cache.days[key] = true
  summary.platforms['B站'] = { date: data.cut, views: num(data.views) }
}

/** 抖音：数据中心-作品数据「昨天」标签页的账号汇总。 */
async function scrapeDouyin(page, cache, rows) {
  await page.goto('https://creator.douyin.com/creator-micro/data-center/operation', { timeout: 60000 }).catch(() => {})
  await page.waitForLoadState('load').catch(() => {})
  // 等「昨天」标签真正出现再点，别用固定 sleep
  await page.waitForFunction(() => [...document.querySelectorAll('div, span, button, a')].some(e => e.children.length === 0 && (e.textContent || '').trim() === '昨天'), undefined, { timeout: 25000 }).catch(() => {})
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('div, span, button, a')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '昨天')
    if (hit) hit.click()
  })
  // 等「总播放量」真的渲染出来再解析；切标签后数据是异步拉的
  await page.waitForFunction(() => /总播放量/.test(document.body.innerText), undefined, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 1500))
  const parse = () => page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ')
    const seg = t.slice(t.indexOf('作品数据'), t.indexOf('粉丝数据') > t.indexOf('作品数据') ? t.indexOf('粉丝数据') : undefined)
    const day = /统计周期：(\d{4}-\d{2}-\d{2})/.exec(seg)?.[1]
    const grab = label => {
      const m = new RegExp(label + ' ([\\d,]+)').exec(seg)
      return m ? m[1] : null
    }
    return { day, views: grab('总播放量'), likes: grab('总点赞量'), comments: grab('总评论量'), shares: grab('总分享量'), saves: grab('总收藏量') }
  })
  let data = await parse()
  // 「昨天」标签有时要点两次才切换成功；没拿到汇总就再点一次
  if (!data.day || data.views === null) {
    await page.evaluate(() => {
      const hit = [...document.querySelectorAll('div, span, button, a')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '昨天')
      if (hit) hit.click()
    })
    await new Promise(r => setTimeout(r, 5000))
    data = await parse()
  }
  if (!data.day || data.views === null) {
    const text = await page.evaluate(() => document.body.innerText)
    if (isLoginWall(text)) throw new Error('抖音登录失效，需要在 ego 浏览器里重新登录')
    throw new Error('抖音数据中心没解析到「昨天」数据（页面结构可能变了）')
  }
  await snapDouyinAccount(page).catch(err => summary.errors.push(`沉淀表·抖音账号：${err.message}`))
  const key = `douyin:${data.day}`
  if (cache.days[key]) {
    summary.platforms['抖音'] = { date: data.day, skipped: '已写过' }
    return
  }
  rows.push({ platform: '抖音', date: iso(data.day), views: num(data.views), likes: num(data.likes), comments: num(data.comments), shares: num(data.shares), saves: num(data.saves) })
  cache.days[key] = true
  summary.platforms['抖音'] = { date: data.day, views: num(data.views) }
}

/** 抖音账号快照：数据总览（近 N 天）、粉丝数据，以及作品数据「昨天」。在「昨天」已点选后的页面上读。 */
async function snapDouyinAccount(page) {
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  const between = (from, to) => {
    const a = text.indexOf(from)
    if (a < 0) return ''
    const b = text.indexOf(to, a + from.length)
    return text.slice(a, b > a ? b : undefined)
  }
  const overview = between('数据总览', '播放量分析')
  const fans = between('粉丝数据', '粉丝画像')
  const works = between('作品数据', '粉丝数据')
  const days = (seg) => {
    const m = /统计周期：(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})/.exec(seg)
    return m ? Math.round((new Date(m[2]) - new Date(m[1])) / 86400000) + 1 : null
  }
  const win = days(overview) ?? days(fans)
  if (!overview && !fans) throw new Error('没找到数据总览和粉丝数据')
  snap.account.push({
    platform: '抖音', window: win ? `近${win}天` : '近期',
    followers: bigNum(after(fans, '总粉丝量')), followerNet: bigNum(after(fans, '粉丝净增')), followerGain: bigNum(after(fans, '吸粉量')), followerLost: bigNum(after(fans, '脱粉量')),
    views: bigNum(after(overview, '播放量')), completionRate: pctNum(after(overview, '完播率')),
  })
  snap.account.push({
    platform: '抖音', window: '昨天',
    views: bigNum(after(works, '总播放量')), likes: bigNum(after(works, '总点赞量')), comments: bigNum(after(works, '总评论量')), shares: bigNum(after(works, '总分享量')),
    ctr: pctNum(after(works, '封面点击率')), avgWatchSec: secNum(after(works, '平均播放时长')),
  })
}

/** 小红书账号快照：账号诊断-数据总览（近 7 日）、粉丝数据概览。 */
async function snapXhsAccount(page) {
  await page.goto('https://creator.xiaohongshu.com/statistics/account/v2', { timeout: 45000 }).catch(() => {})
  await page.waitForFunction(() => /曝光数\s*[1-9]/.test(document.body.innerText), undefined, { timeout: 25000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 2500))
  const overviewText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  const overview = overviewText.slice(Math.max(overviewText.indexOf('数据总览'), 0))
  const period = /统计周期 (\d{2})-(\d{2}) 至 (\d{2})-(\d{2})/.exec(overview)
  const win = period ? Math.round((new Date(2000, +period[3] - 1, +period[4]) - new Date(2000, +period[1] - 1, +period[2])) / 86400000) + 1 : null
  if (!/曝光数/.test(overview)) throw new Error('账号诊断页没解析到数据总览')
  await page.goto('https://creator.xiaohongshu.com/statistics/fans-data', { timeout: 45000 }).catch(() => {})
  await page.waitForFunction(() => /总粉丝数\s*[1-9]/.test(document.body.innerText), undefined, { timeout: 25000 }).catch(() => {})
  const fans = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  const gain = bigNum(after(fans, '新增粉丝数'))
  const lost = bigNum(after(fans, '流失粉丝数'))
  snap.account.push({
    platform: '小红书', window: win ? `近${win}天` : '近期',
    followers: bigNum(after(fans, '总粉丝数')), followerGain: gain, followerLost: lost, followerNet: gain !== null && lost !== null ? gain - lost : null,
    impressions: bigNum(after(overview, '曝光数')), views: bigNum(after(overview, '观看数')), ctr: pctNum(after(overview, '封面点击率')),
    avgWatchSec: secNum(after(overview, '平均观看时长')), completionRate: pctNum(after(overview, '视频完播率')),
  })
}

/** B站逐条稿件快照：数据中心是个 iframe，直接访问它的真实地址。 */
async function snapBiliContent(page) {
  await page.goto('https://member.bilibili.com/york/data-center-web?tmid=&bvid=&tab=', { timeout: 45000 }).catch(() => {})
  await page.waitForFunction(() => /稿件名称/.test(document.body.innerText), undefined, { timeout: 25000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 2500))
  const table = await page.evaluate(() => {
    const tx = e => (e.textContent || '').trim().replace(/\s+/g, ' ')
    const t = [...document.querySelectorAll('table')].find(el => el.textContent.includes('稿件名称') && el.querySelectorAll('tr').length > 1)
    return t ? [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(tx)) : []
  })
  if (table.length < 2) throw new Error('没读到近期稿件表（页面结构可能变了）')
  const seen = {}
  for (const cells of table.slice(1)) {
    if (cells.length < 12) continue
    const dateMatch = /(\d{4})年(\d{2})月(\d{2})日/.exec(cells[0])
    const title = cells[0].replace(/^\d{1,2}:\d{2}(?::\d{2})?/, '').replace(/\d{4}年\d{2}月\d{2}日[\d: ]*/, '').replace(/(播放|涨粉|点赞|评论|收藏|投币|转发)最高/g, '').trim().slice(0, 60)
    if (!title) continue
    const published = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : ''
    const base = `bili:${published}:${title.slice(0, 40)}`
    seen[base] = (seen[base] ?? 0) + 1
    snap.content.push({
      platform: 'B站', contentKey: seen[base] > 1 ? `${base}#${seen[base]}` : base, title, publishedAt: published,
      views: bigNum(cells[1]), visitorShare: pctNum(cells[2]), fanViewRate: pctNum(cells[3]), follows: bigNum(cells[4]), likes: bigNum(cells[5]),
      comments: bigNum(cells[6]), danmaku: bigNum(cells[7]), saves: bigNum(cells[8]), coins: bigNum(cells[9]), shares: bigNum(cells[10]), avgProgress: pctNum(cells[11]),
    })
  }
}

/** 抖音逐条作品快照：数据中心-投稿分析-投稿列表，按表头名取列。 */
async function snapDouyinContent(page) {
  await page.goto('https://creator.douyin.com/creator-micro/data-center/content', { timeout: 60000 }).catch(() => {})
  await page.waitForFunction(() => [...document.querySelectorAll('div, span, li, button')].some(e => (e.textContent || '').trim() === '投稿列表'), undefined, { timeout: 25000 }).catch(() => {})
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll('div, span, li, button')].filter(e => (e.textContent || '').trim() === '投稿列表').pop()
    if (hit) hit.click()
  })
  await page.waitForFunction(() => [...document.querySelectorAll('table tbody tr')].some(tr => (tr.children[0]?.textContent || '').trim().length > 0), undefined, { timeout: 20000 }).catch(() => {})
  const list = await page.evaluate(() => {
    const tx = e => (e.textContent || '').trim().replace(/\s+/g, ' ')
    const row = document.querySelector('table tbody tr')
    const table = row?.closest('table')
    if (!table) return null
    return { heads: [...table.querySelectorAll('thead th, thead td')].map(tx), rows: [...table.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(tx)) }
  })
  if (!list?.rows.length) throw new Error('没读到投稿列表（页面结构可能变了）')
  const col = name => list.heads.findIndex(h => h.startsWith(name))
  const at = { views: col('播放量'), completion: col('完播率'), c5: col('5s完播率'), ctr: col('封面点击率'), b2: col('2s跳出率'), dur: col('平均播放时长'), likes: col('点赞量'), shares: col('分享量'), comments: col('评论量'), saves: col('收藏量'), follows: col('粉丝增量') }
  if (at.views < 0) throw new Error('投稿列表表头里没找到播放量列')
  const pick = (cells, i) => (i >= 0 ? cells[i] : null)
  const seen = {}
  for (const cells of list.rows) {
    const published = /(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/.exec(cells[0])?.[1] ?? ''
    const title = cells[0].replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?/, '').trim().slice(0, 60)
    if (!title) continue
    const base = `douyin:${published}:${title.slice(0, 40)}`
    seen[base] = (seen[base] ?? 0) + 1
    snap.content.push({
      platform: '抖音', contentKey: seen[base] > 1 ? `${base}#${seen[base]}` : base, title, publishedAt: published,
      views: bigNum(pick(cells, at.views)), completionRate: pctNum(pick(cells, at.completion)), completion5sRate: pctNum(pick(cells, at.c5)),
      ctr: pctNum(pick(cells, at.ctr)), bounce2sRate: pctNum(pick(cells, at.b2)), avgWatchSec: secNum(pick(cells, at.dur)),
      likes: bigNum(pick(cells, at.likes)), shares: bigNum(pick(cells, at.shares)), comments: bigNum(pick(cells, at.comments)),
      saves: bigNum(pick(cells, at.saves)), follows: bigNum(pick(cells, at.follows)),
    })
  }
}

// ── 主流程 ──
const cache = await readCache()
const rows = []
const task = await taskSpace('creator-center scrape')
const page = task.page('p1')

for (const [name, fn] of [['小红书', scrapeXhs], ['B站', scrapeBili], ['抖音', scrapeDouyin]]) {
  try {
    await fn(page, cache, rows)
  } catch (err) {
    summary.errors.push(`${name}：${err.message}`)
  }
}
// 沉淀表的补充抓取：各自独立，失败只记错误，不影响上面的工作台数据
for (const [name, fn] of [['小红书账号', snapXhsAccount], ['B站稿件', snapBiliContent], ['抖音作品', snapDouyinContent]]) {
  try {
    await fn(page)
  } catch (err) {
    summary.errors.push(`沉淀表·${name}：${err.message}`)
  }
}
summary.snapshots = { content: snap.content.length, account: snap.account.length }

if (DRY) {
  summary.dryRun = snap
} else if (rows.length || snap.content.length || snap.account.length) {
  const gui = await task.newPage()
  try {
    await gui.goto(GUI_URL, { timeout: 30000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 4000))
    const post = (path, body) => gui.evaluate(async ([route, payload]) => {
      const r = await fetch(`/media-desk/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': 'zh' }, body: JSON.stringify(payload) })
      return { status: r.status, ...(await r.json().catch(() => ({}))) }
    }, [path, body])
    if (rows.length) {
      const write = await post('ops', { ops: rows.map(r => ({ op: 'add_metric', itemId: null, ...r })), label: `创作中心数据 ${RUN_DATE}` })
      if (write.status !== 200 || write.errors?.length) summary.errors.push(`写入工作台失败：${JSON.stringify(write).slice(0, 200)}`)
      else {
        summary.written = rows.length
        await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 })
      }
    }
    // 沉淀表独立写入：旧版插件没有这个接口时只记一条错误，不影响上面
    if (snap.content.length || snap.account.length) {
      const ledger = await post('ledger/ingest', { date: RUN_DATE, content: snap.content, account: snap.account })
      if (ledger.status === 200) summary.ledger = { content: ledger.content, account: ledger.account }
      else summary.errors.push(`沉淀表写入失败（${ledger.status}）：${ledger.error ?? '插件可能还没重载'}`)
    }
  } finally {
    // 必须 close：release 不关标签，遗留的 DSH 页面长连接会占满同主机 6 条连接，整个 DSH web 卡死
    await gui.close().catch(() => {})
  }
}

console.log('SCRAPE_RESULT ' + JSON.stringify(summary, null, 1))
