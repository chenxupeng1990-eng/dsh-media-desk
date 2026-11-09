// 数据沉淀：每天一份快照的统计表（平台概览 / 每日累计与日增 / 逐条内容）。数据来自本地 CSV，空 = 后台没给。
import React from 'react'
import { openLedgerFolder } from './desk.js'
import { lang, t } from './i18n.js'
import { Icon, Segmented } from './ui.jsx'
import { compact, fmtDate } from './util.js'

const blank = value => value === null || value === undefined
const cnt = value => (blank(value) ? '—' : Number(value).toLocaleString())
const pct = value => (blank(value) ? '—' : `${value}%`)
const secs = value => (blank(value) ? '—' : `${value}${t('秒')}`)
const gain = value => (blank(value) ? '' : `${value > 0 ? '+' : ''}${Number(value).toLocaleString()}`)
const day = date => (lang() === 'en' ? fmtDate(`${date}T12:00:00`) : date)
const clip = (text, n) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text)

function Platforms({ rows }) {
  return (
    <table className="md-table is-plain">
      <thead><tr>
        <th>{t('平台')}</th><th className="is-num">{t('内容数')}</th><th className="is-num">{t('累计播放')}</th><th className="is-num">{t('曝光')}</th>
        <th className="is-num">{t('点击率')}</th><th className="is-num">{t('完播率')}</th><th className="is-num">{t('5秒完播率')}</th><th className="is-num">{t('平均进度')}</th><th className="is-num">{t('平均时长')}</th><th className="is-num">{t('粉丝')}</th>
      </tr></thead>
      <tbody>{rows.map(row => (
        <tr key={row.platform}>
          <td>{t(row.platform)}</td><td className="is-num">{cnt(row.contents)}</td><td className="is-num">{cnt(row.views)}</td><td className="is-num">{cnt(row.impressions)}</td>
          <td className="is-num">{pct(row.ctr)}</td><td className="is-num">{pct(row.completionRate)}</td><td className="is-num">{pct(row.completion5sRate)}</td><td className="is-num">{pct(row.avgProgress)}</td><td className="is-num">{secs(row.avgWatchSec)}</td><td className="is-num">{cnt(row.followers)}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

function Daily({ ledger }) {
  const names = ledger.platforms.map(row => row.platform)
  return (
    <table className="md-table is-plain">
      <thead><tr><th>{t('日期')}</th><th className="is-num">{t('累计播放')}</th><th className="is-num">{t('日增')}</th>{names.map(name => <th key={name} className="is-num">{t(name)}</th>)}</tr></thead>
      <tbody>{[...ledger.daily].reverse().map(row => (
        <tr key={row.date}>
          <td>{day(row.date)}</td><td className="is-num">{cnt(row.views)}</td><td className="is-num">{blank(row.dViews) ? '—' : gain(row.dViews)}</td>
          {names.map((name) => {
            const cell = row.byPlatform[name]
            return <td key={name} className="is-num">{cell ? <>{cnt(cell.views)}{blank(cell.dViews) ? null : <small className="md-delta"> {gain(cell.dViews)}</small>}</> : '—'}</td>
          })}
        </tr>
      ))}</tbody>
    </table>
  )
}

function Contents({ rows }) {
  return (
    <table className="md-table is-plain">
      <thead><tr>
        <th>{t('内容')}</th><th>{t('发布日期')}</th><th className="is-num">{t('播放')}</th><th className="is-num">{t('日增')}</th><th className="is-num">{t('曝光')}</th>
        <th className="is-num">{t('点击率')}</th><th className="is-num">{t('完播率')}</th><th className="is-num">{t('5秒完播率')}</th><th className="is-num">{t('平均进度')}</th><th className="is-num">{t('平均时长')}</th><th className="is-num">{t('点赞')}</th><th className="is-num">{t('涨粉')}</th>
      </tr></thead>
      <tbody>{rows.slice(0, 60).map(row => (
        <tr key={`${row.platform}:${row.contentKey}`}>
          <td title={row.title}>{t(row.platform)} · {clip(row.title, lang() === 'en' ? 36 : 18)}</td><td>{row.publishedAt || '—'}</td>
          <td className="is-num">{cnt(row.views)}</td><td className="is-num">{blank(row.d_views) ? '—' : gain(row.d_views)}</td><td className="is-num">{cnt(row.impressions)}</td>
          <td className="is-num">{pct(row.ctr)}</td><td className="is-num">{pct(row.completionRate)}</td><td className="is-num">{pct(row.completion5sRate)}</td><td className="is-num">{pct(row.avgProgress)}</td><td className="is-num">{secs(row.avgWatchSec)}</td>
          <td className="is-num">{cnt(row.likes)}</td><td className="is-num">{cnt(row.follows)}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

export function LedgerPanel({ ledger }) {
  const [view, setView] = React.useState('platforms')
  return (
    <section className="md-tile md-i-ledger">
      <header className="md-tile-head">
        <h2>{t('数据沉淀')}</h2>
        {ledger?.days ? <span className="md-tile-meta">{t('{n} 天快照 · 自 {date}', { n: ledger.days, date: day(ledger.firstDate) })}</span> : null}
        <span className="md-grow" />
        {ledger?.days ? <Segmented label={t('显示方式')} value={view} onChange={setView} options={[{ value: 'platforms', label: t('平台') }, { value: 'daily', label: t('每日') }, { value: 'contents', label: t('内容') }]} /> : null}
        <button type="button" className="md-pill is-small" onClick={openLedgerFolder}><Icon name="folder" size={13} />{t('打开数据表')}</button>
      </header>
      {!ledger ? null : !ledger.days ? <p className="md-muted">{t('还没有快照。点「抓取后台数据」生成第一份，之后每次抓取追加一天。')}</p> : (
        <>
          <div className="md-i-table md-ledger-table">
            {view === 'platforms' ? <Platforms rows={ledger.platforms} /> : view === 'daily' ? <Daily ledger={ledger} /> : <Contents rows={ledger.contents} />}
          </div>
          <p className="md-muted md-ledger-note">{t('累计值取每条内容最新一次快照；日增 = 相邻两次快照相减，首次快照没有日增；点击率、完播率按曝光或播放加权，空 = 后台没给，或不到一半的内容有该指标所以不汇总。口径以各平台后台为准，不同平台的完播率不能直接比较。')}</p>
        </>
      )}
    </section>
  )
}
