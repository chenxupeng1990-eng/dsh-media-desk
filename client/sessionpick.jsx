import React from 'react'
import { createMappedSession, fetchSessions, selectMappedSession, setDesk, useDesk } from './desk.js'
import { t, useLang } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'

export function SessionButton() {
  const busy = useDesk(s => s.thinking || s.sessionSwitchBusy)
  return <button type="button" className="md-pill" disabled={busy} aria-label={t('切换会话')} onClick={() => setDesk({ settingsOpen: false, sessionPickOpen: true })}><Icon name="chat" size={14} />{t('切换会话')}</button>
}

export function SessionPicker() {
  useLang()
  const open = useDesk(s => s.sessionPickOpen)
  const current = useDesk(s => s.settings?.assistantSession ?? '')
  const busy = useDesk(s => s.sessionSwitchBusy)
  const [data, setData] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [workspace, setWorkspace] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    let alive = true
    setData(null)
    setQuery('')
    fetchSessions().then(value => {
      if (!alive) return
      setData(value ?? { sessions: [], workspaces: [], failed: true })
      const selected = value?.sessions.find(row => row.sessionId === current)
      setWorkspace(value?.workspaces.find(w => w.path === selected?.cwd)?.id ?? value?.workspaces[0]?.id ?? '')
    })
    return () => { alive = false }
  }, [open])
  if (!open) return null
  const close = () => setDesk({ sessionPickOpen: false })
  const choose = async id => { if (await selectMappedSession(id)) close() }
  const matches = (data?.sessions ?? []).filter(row => `${row.title} ${row.workspace} ${row.cwd}`.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <Dialog title={t('切换会话')} onClose={close} width={560}>
      <div className="md-form">
        <p className="md-muted">{t('选中即切换，无需再保存。接下来发送的消息会进入这个会话。')}</p>
        <input className="md-session-search" aria-label={t('搜索会话名称')} placeholder={t('搜索会话名称或工作区')} value={query} onChange={e => setQuery(e.target.value)} />
        {!data ? <p className="md-muted">{t('正在读取会话…')}</p> : null}
        {data?.failed ? <p role="alert">{t('会话列表读取失败，请关闭后重试')}</p> : null}
        <div className="md-session-options">
          <button type="button" className={`md-session-option ${!current ? 'is-current' : ''}`} aria-pressed={!current} disabled={busy || creating} onClick={() => choose('')}>
            <strong>{t('插件自带助手')}</strong><small>{t('不连接 Harness 会话')}</small>
          </button>
          {matches.map(row => <button key={row.sessionId} type="button" data-session-id={row.sessionId} className={`md-session-option ${current === row.sessionId ? 'is-current' : ''}`} aria-pressed={current === row.sessionId} disabled={busy || creating} onClick={() => choose(row.sessionId)}>
            <strong>{row.title}</strong>
            <small>{row.workspace || t('无工作区')}{row.running ? ` · ${t('运行中')}` : ''}{row.archived ? ` · ${t('已归档')}` : ''}{current === row.sessionId ? ` · ${t('当前会话')}` : ''}</small>
          </button>)}
          {data && !matches.length ? <p className="md-muted">{t('没有匹配的会话')}</p> : null}
        </div>
        {data?.workspaces.length ? <div className="md-field-row">
          <label className="md-field"><span>{t('新会话所属工作区')}</span><select aria-label={t('新会话所属工作区')} value={workspace} onChange={e => setWorkspace(e.target.value)}>{data.workspaces.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select></label>
          <button type="button" className="md-btn" disabled={busy || creating || !workspace} onClick={async () => {
            setCreating(true)
            try { const result = await createMappedSession(workspace); if (result?.sessionId) await choose(result.sessionId) }
            finally { setCreating(false) }
          }}>{creating ? t('正在新建…') : t('新建并使用')}</button>
        </div> : null}
        {busy ? <p role="status">{t('正在切换会话…')}</p> : null}
      </div>
    </Dialog>
  )
}
