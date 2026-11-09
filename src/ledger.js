// 数据沉淀表：每天一份快照，追加写入本地 CSV，供复盘页和 Excel 做统计分析。
// 两张表：内容每日快照（每条内容每天一行，累计值）、账号每日快照（每平台每天一行）。
// 约定：空 = 未知（后台没给），不写 0；累计值按抓到的原值存，日增量用相邻两次快照相减，比率不做加法。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** key=代码里的字段名，head=CSV 表头（中文，Excel 直接可读），delta=是否是累计型、需要算日增量。 */
export const CONTENT_COLUMNS = [
  { key: 'date', head: '快照日期' }, { key: 'platform', head: '平台' }, { key: 'contentKey', head: '内容标识' },
  { key: 'title', head: '标题' }, { key: 'publishedAt', head: '发布日期' },
  { key: 'impressions', head: '曝光', delta: true }, { key: 'views', head: '播放/观看', delta: true },
  { key: 'ctr', head: '点击率(%)' }, { key: 'likes', head: '点赞', delta: true }, { key: 'comments', head: '评论', delta: true },
  { key: 'saves', head: '收藏', delta: true }, { key: 'shares', head: '分享/转发', delta: true }, { key: 'follows', head: '涨粉', delta: true },
  { key: 'avgWatchSec', head: '平均观看时长(秒)' }, { key: 'completionRate', head: '完播率(%)' }, { key: 'completion5sRate', head: '5秒完播率(%)' },
  { key: 'bounce2sRate', head: '2秒跳出率(%)' }, { key: 'avgProgress', head: '平均播放进度(%)' },
  { key: 'danmaku', head: '弹幕', delta: true }, { key: 'coins', head: '投币', delta: true },
  { key: 'visitorShare', head: '游客播放占比(%)' }, { key: 'fanViewRate', head: '粉丝观看率(%)' },
]
const DELTA_HEAD = { impressions: '曝光', views: '播放/观看', likes: '点赞', comments: '评论', saves: '收藏', shares: '分享/转发', follows: '涨粉', danmaku: '弹幕', coins: '投币' }
for (const column of [...CONTENT_COLUMNS]) {
  if (column.delta) CONTENT_COLUMNS.push({ key: `d_${column.key}`, head: `日增·${DELTA_HEAD[column.key]}` })
}

export const ACCOUNT_COLUMNS = [
  { key: 'date', head: '快照日期' }, { key: 'platform', head: '平台' }, { key: 'window', head: '统计口径' },
  { key: 'followers', head: '总粉丝' }, { key: 'followerNet', head: '粉丝净增' }, { key: 'followerGain', head: '新增粉丝' }, { key: 'followerLost', head: '流失粉丝' },
  { key: 'impressions', head: '曝光' }, { key: 'views', head: '播放/观看' }, { key: 'visitors', head: '主页/空间访客' },
  { key: 'ctr', head: '点击率(%)' }, { key: 'avgWatchSec', head: '平均观看时长(秒)' }, { key: 'completionRate', head: '完播率(%)' },
  { key: 'likes', head: '点赞' }, { key: 'comments', head: '评论' }, { key: 'saves', head: '收藏' }, { key: 'shares', head: '分享/转发' },
]

const TEXT_KEYS = new Set(['date', 'platform', 'contentKey', 'title', 'publishedAt', 'window'])
const BOM = '﻿'
const num = value => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null))
const round = value => (value === null ? null : Math.round(value * 100) / 100)

function cell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows, columns) {
  const lines = [columns.map(column => cell(column.head)).join(',')]
  for (const row of rows) lines.push(columns.map(column => cell(row[column.key])).join(','))
  return `${BOM}${lines.join('\r\n')}\r\n`
}

function splitCsv(text) {
  const records = []
  let record = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { record.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      record.push(field); field = ''
      if (record.some(value => value !== '')) records.push(record)
      record = []
    } else field += ch
  }
  if (field !== '' || record.length) { record.push(field); if (record.some(value => value !== '')) records.push(record) }
  return records
}

export function parseCsv(text, columns) {
  const records = splitCsv(text.replace(/^﻿/, ''))
  if (!records.length) return []
  const index = new Map(records[0].map((head, i) => [head.trim(), i]))
  return records.slice(1).map((record) => {
    const row = {}
    for (const column of columns) {
      const at = index.get(column.head)
      const raw = at === undefined ? '' : (record[at] ?? '')
      row[column.key] = TEXT_KEYS.has(column.key) ? raw : num(raw)
    }
    return row
  })
}

/** 把抓取脚本交来的原始行整理成表里的一行：文本字段留文本，其余必须是有限数字，否则按未知处理。 */
export function normalizeRow(raw, columns, date) {
  const row = {}
  for (const column of columns) {
    if (column.key.startsWith('d_')) continue
    row[column.key] = TEXT_KEYS.has(column.key) ? String(raw?.[column.key] ?? '').trim() : round(num(raw?.[column.key]))
  }
  row.date = date
  return row
}

const sameKey = (a, b) => a.platform === b.platform && a.contentKey === b.contentKey

/** 同一天重跑覆盖当天的行；日增量 = 本次累计 − 此前最近一次快照的累计（任一边未知则留空，首次出现也留空）。 */
export function upsertContent(existing, date, incoming) {
  const fresh = incoming.map(raw => normalizeRow(raw, CONTENT_COLUMNS, date)).filter(row => row.platform && row.contentKey)
  const kept = existing.filter(row => !(row.date === date && fresh.some(item => sameKey(item, row))))
  for (const row of fresh) {
    const prev = kept.filter(old => sameKey(old, row) && old.date < date).sort((a, b) => b.date.localeCompare(a.date))[0]
    for (const column of CONTENT_COLUMNS) {
      if (!column.delta) continue
      const now = row[column.key]
      const before = prev?.[column.key]
      row[`d_${column.key}`] = now !== null && before !== null && before !== undefined ? round(now - before) : null
    }
  }
  return [...kept, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform) || a.contentKey.localeCompare(b.contentKey))
}

export function upsertAccount(existing, date, incoming) {
  const fresh = incoming.map(raw => normalizeRow(raw, ACCOUNT_COLUMNS, date)).filter(row => row.platform)
  const kept = existing.filter(row => !(row.date === date && fresh.some(item => item.platform === row.platform && item.window === row.window)))
  return [...kept, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform) || a.window.localeCompare(b.window))
}

function weighted(rows, field, weightFields) {
  const known = rows.filter(row => row[field] !== null && row[field] !== undefined)
  // 少于一半的内容报了这个指标（比如抖音只给少数视频封面点击率），汇总出来会误导，宁可留空
  if (known.length * 2 < rows.length) return null
  // 每条内容取第一个大于 0 的权重（曝光优先，其次播放）；没有权重的内容不参与加权，全都没有才退回简单平均
  const pairs = known.map(row => [row[field], weightFields.map(key => row[key]).find(weight => weight > 0) ?? 0])
  const heavy = pairs.filter(([, weight]) => weight > 0)
  if (heavy.length) return round(heavy.reduce((total, [value, weight]) => total + value * weight, 0) / heavy.reduce((total, [, weight]) => total + weight, 0))
  return round(known.reduce((total, row) => total + row[field], 0) / known.length)
}

const sum = (rows, field) => {
  const known = rows.filter(row => row[field] !== null && row[field] !== undefined)
  return known.length ? known.reduce((total, row) => total + row[field], 0) : null
}

/** 复盘页用：各平台最新累计与比率、每日累计与日增、逐条内容最新快照。 */
export function summarize(contentRows, accountRows) {
  const dates = [...new Set(contentRows.map(row => row.date))].sort()
  const latestOf = (rows) => {
    const latest = new Map()
    for (const row of rows) {
      const key = `${row.platform}\u0000${row.contentKey}`
      if (!latest.has(key) || latest.get(key).date < row.date) latest.set(key, row)
    }
    return [...latest.values()]
  }
  const latest = latestOf(contentRows)
  const platformNames = [...new Set(latest.map(row => row.platform))]
  const platforms = platformNames.map((platform) => {
    const rows = latest.filter(row => row.platform === platform)
    const accounts = accountRows.filter(row => row.platform === platform).sort((a, b) => b.date.localeCompare(a.date))
    const account = accounts.find(row => row.followers !== null) ?? accounts[0] ?? null
    return {
      platform, date: rows.reduce((max, row) => (row.date > max ? row.date : max), ''), contents: rows.length,
      views: sum(rows, 'views'), impressions: sum(rows, 'impressions'), likes: sum(rows, 'likes'), comments: sum(rows, 'comments'),
      saves: sum(rows, 'saves'), shares: sum(rows, 'shares'), follows: sum(rows, 'follows'),
      ctr: weighted(rows, 'ctr', ['impressions', 'views']), completionRate: weighted(rows, 'completionRate', ['views']),
      completion5sRate: weighted(rows, 'completion5sRate', ['views']), avgWatchSec: weighted(rows, 'avgWatchSec', ['views']),
      avgProgress: weighted(rows, 'avgProgress', ['views']),
      followers: account?.followers ?? null, followersDate: account?.date ?? null,
    }
  }).sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
  const daily = dates.map((date) => {
    const rows = contentRows.filter(row => row.date === date)
    const byPlatform = {}
    for (const platform of platformNames) {
      const mine = rows.filter(row => row.platform === platform)
      if (mine.length) byPlatform[platform] = { views: sum(mine, 'views'), dViews: sum(mine, 'd_views'), dLikes: sum(mine, 'd_likes') }
    }
    return { date, views: sum(rows, 'views'), dViews: sum(rows, 'd_views'), byPlatform }
  })
  const contents = latest.map(row => ({ ...row })).sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
  return { firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null, days: dates.length, platforms, daily, contents }
}

export class Ledger {
  constructor(root) {
    this.dir = join(root, 'data')
    this.contentFile = join(this.dir, '内容每日快照.csv')
    this.accountFile = join(this.dir, '账号每日快照.csv')
    this.queue = Promise.resolve()
  }

  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  async #load(file, columns) {
    try { return parseCsv(await readFile(file, 'utf8'), columns) } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }

  async #save(file, rows, columns) {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, toCsv(rows, columns), { mode: 0o644 })
    await rename(tmp, file)
  }

  read() {
    return this.run(async () => ({
      content: await this.#load(this.contentFile, CONTENT_COLUMNS),
      account: await this.#load(this.accountFile, ACCOUNT_COLUMNS),
    }))
  }

  /** @param {string} date - YYYY-MM-DD，本地日期。 */
  ingest(date, { content = [], account = [] } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Promise.reject(Object.assign(new Error('date 必须是 YYYY-MM-DD'), { status: 400 }))
    return this.run(async () => {
      let contentCount = 0
      let accountCount = 0
      if (content.length) {
        const merged = upsertContent(await this.#load(this.contentFile, CONTENT_COLUMNS), date, content)
        contentCount = merged.filter(row => row.date === date).length
        await this.#save(this.contentFile, merged, CONTENT_COLUMNS)
      }
      if (account.length) {
        const merged = upsertAccount(await this.#load(this.accountFile, ACCOUNT_COLUMNS), date, account)
        accountCount = merged.filter(row => row.date === date).length
        await this.#save(this.accountFile, merged, ACCOUNT_COLUMNS)
      }
      return { date, content: contentCount, account: accountCount }
    })
  }

  async summary() {
    const { content, account } = await this.read()
    return { ...summarize(content, account), files: { dir: this.dir, content: this.contentFile, account: this.accountFile } }
  }
}
