import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import plugin from '../src/host.js'
import { CONTENT_COLUMNS, Ledger, parseCsv, summarize, toCsv, upsertContent } from '../src/ledger.js'

const note = (extra = {}) => ({ platform: '小红书', contentKey: 'xhs:2026-11-05:标题', title: '标题', publishedAt: '2026-11-05', ...extra })

test('CSV：带逗号、引号、换行的标题往返不变，空值保持为空而不是 0', () => {
  const rows = upsertContent([], '2026-11-08', [note({ title: '他说，"好"\n第二行', views: 10 })])
  const back = parseCsv(toCsv(rows, CONTENT_COLUMNS), CONTENT_COLUMNS)
  assert.equal(back[0].title, '他说，"好"\n第二行')
  assert.equal(back[0].views, 10)
  assert.equal(back[0].completionRate, null)
  assert.equal(back[0].likes, null)
  assert.ok(toCsv(rows, CONTENT_COLUMNS).startsWith('﻿快照日期,平台'))
})

test('日增量 = 本次累计 − 此前最近一次快照；首次出现留空；比率不参与相减', () => {
  let rows = upsertContent([], '2026-11-07', [note({ views: 100, likes: 5, ctr: 8 })])
  assert.equal(rows[0].d_views, null)
  rows = upsertContent(rows, '2026-11-09', [note({ views: 130, likes: 5, ctr: 9 })])
  const latest = rows.find(row => row.date === '2026-11-09')
  assert.equal(latest.d_views, 30)
  assert.equal(latest.d_likes, 0)
  assert.equal(latest.ctr, 9)
  assert.equal('d_ctr' in latest, false)
})

test('同一天重跑覆盖当天的行，不重复计数；其他内容不受影响', () => {
  let rows = upsertContent([], '2026-11-08', [note({ views: 50 }), note({ contentKey: 'xhs:2026-11-06:别的', title: '别的', views: 7 })])
  rows = upsertContent(rows, '2026-11-08', [note({ views: 60 })])
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.contentKey.endsWith('标题')).views, 60)
  assert.equal(rows.find(row => row.contentKey.endsWith('别的')).views, 7)
})

test('后台没给的数据留空：未知的累计值不会让日增量变成负数或 0', () => {
  let rows = upsertContent([], '2026-11-07', [note({ views: 100, completionRate: null })])
  rows = upsertContent(rows, '2026-11-08', [note({ views: null })])
  assert.equal(rows.find(row => row.date === '2026-11-08').d_views, null)
})

test('summarize：累计取每条内容最新一次，比率按曝光或播放加权，平台按播放排序', () => {
  let rows = upsertContent([], '2026-11-07', [
    note({ views: 100, impressions: 1000, ctr: 10 }),
    note({ contentKey: 'k2', title: '二', views: 300, impressions: 1000, ctr: 20 }),
    { platform: '抖音', contentKey: 'd1', title: '抖', views: 50, completionRate: 10 },
  ])
  rows = upsertContent(rows, '2026-11-08', [note({ views: 120, impressions: 1200, ctr: 10 })])
  const s = summarize(rows, [{ date: '2026-11-08', platform: '小红书', window: '总计', followers: 995 }])
  const xhs = s.platforms.find(row => row.platform === '小红书')
  assert.equal(xhs.views, 420)
  assert.equal(xhs.contents, 2)
  assert.equal(xhs.followers, 995)
  assert.equal(s.platforms[0].platform, '小红书')
  assert.equal(s.days, 2)
  assert.equal(s.daily.at(-1).byPlatform['小红书'].dViews, 20)
  assert.equal(s.daily.at(-1).dViews, 20)
  const douyin = s.platforms.find(row => row.platform === '抖音')
  assert.equal(douyin.completionRate, 10)
  assert.equal(douyin.ctr, null)
  // 只有少数内容有点击率时按播放加权，零播放的内容不参与，不能被简单平均拉偏
  const mixed = summarize(upsertContent([], '2026-11-09', [
    { platform: '抖音', contentKey: 'a', title: 'a', views: 900, ctr: 2 },
    { platform: '抖音', contentKey: 'b', title: 'b', views: 100, ctr: 50 },
    { platform: '抖音', contentKey: 'c', title: 'c', views: 0, ctr: 100 },
  ]), [])
  assert.equal(mixed.platforms[0].ctr, 6.8)
  const sparse = summarize(upsertContent([], '2026-11-09', [
    { platform: '抖音', contentKey: 'a', title: 'a', views: 900, ctr: 100 },
    { platform: '抖音', contentKey: 'b', title: 'b', views: 100 },
    { platform: '抖音', contentKey: 'c', title: 'c', views: 50 },
  ]), [])
  assert.equal(sparse.platforms[0].ctr, null, '1/3 的内容有点击率，不汇总')
})

test('Ledger：写文件、再读回、日期格式不对时拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-ledger-'))
  try {
    const ledger = new Ledger(dir)
    await assert.rejects(ledger.ingest('11/08', { content: [note()] }), /YYYY-MM-DD/)
    const done = await ledger.ingest('2026-11-08', { content: [note({ views: 9 })], account: [{ platform: '小红书', window: '总计', followers: 995 }] })
    assert.deepEqual(done, { date: '2026-11-08', content: 1, account: 1 })
    await ledger.ingest('2026-11-08', { content: [note({ views: 12 })] })
    const text = await readFile(ledger.contentFile, 'utf8')
    assert.equal(text.trim().split(/\r?\n/).length, 2)
    const summary = await ledger.summary()
    assert.equal(summary.platforms[0].views, 12)
    assert.equal(summary.platforms[0].followers, 995)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('路由：ingest 写入、GET ledger 读回、日期不对 400、跨站请求 403，数据只落在 DSH_HOME 下', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-route-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    let handler = null
    plugin.apply({ get: name => (name === 'connection' ? { requestRejection: () => undefined } : undefined), effect: fn => fn(), webServer: { register: (options) => { handler = options.handler } } })
    const call = (method, path, body, headers = {}) => new Promise((resolve) => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      const req = { url: `/media-desk/${path}`, method, headers, async* [Symbol.asyncIterator]() { yield* chunks } }
      const res = { statusCode: 0, headersSent: false, setHeader() {}, end: text => resolve({ status: res.statusCode, body: JSON.parse(text) }) }
      handler(req, res)
    })
    const ok = await call('POST', 'ledger/ingest', { date: '2026-11-09', content: [note({ views: 9, ctr: 8.5 })], account: [{ platform: '小红书', window: '近7天', followers: 995 }] })
    assert.deepEqual(ok.body, { date: '2026-11-09', content: 1, account: 1 })
    const read = await call('GET', 'ledger')
    assert.equal(read.status, 200)
    assert.equal(read.body.platforms[0].views, 9)
    assert.equal(read.body.platforms[0].followers, 995)
    assert.ok(read.body.files.content.startsWith(dir), '沉淀表必须写在 DSH_HOME 下')
    assert.equal((await call('POST', 'ledger/ingest', { date: 'x', content: [note()] })).status, 400)
    assert.equal((await call('POST', 'ledger/ingest', { date: '2026-11-09', content: [note()] }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
})
