// 会话选择使用 Harness 已有的标题投影；聊天展示只读原会话，不复制或改写日志。
import { tr } from './i18n.js'

export async function listDeskSessions(ctx, settings) {
  const sc = ctx.get('sessionController')
  if (!sc) throw new Error(tr('会话服务不可用'))
  const wr = ctx.get('workspaceRegistry')
  const workspaces = (wr?.list() ?? []).map(w => ({ id: w.id, title: w.title, path: w.path }))
  const archived = new Set(wr?.archivedSessionIds ?? [])
  const current = (await settings.read()).assistantSession ?? ''
  const listed = await sc.list({}, AbortSignal.timeout(15000))
  const sessions = (listed.items ?? [])
    .filter(row => row.origin !== 'subagent' && (!archived.has(row.sessionId) || row.sessionId === current))
    .map(row => ({
      sessionId: row.sessionId,
      title: row.projections?.values?.title || tr('未命名会话'),
      workspace: workspaces.find(w => w.path === row.cwd)?.title || '',
      cwd: row.cwd ?? '', updatedAt: row.updatedAt ?? 0,
      running: Boolean(row.running), archived: archived.has(row.sessionId),
    }))
  return { workspaces, sessions, current }
}

function userText(event) {
  const source = event.data.source
  // 排除运行时注入的 skills、工作区说明等上下文，只展示用户提交的消息。
  if (source?.kind !== 'user') return ''
  const text = (event.data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
  if (!source.rpcId?.startsWith('media-desk-')) return text
  // 旧映射请求中包含工作台数据快照，界面只显示用户原话。
  const marker = '\n用户说：'
  const at = text.indexOf(marker)
  return (at >= 0 ? text.slice(at + marker.length) : text).split('\n\n（以上是自媒体工作台的数据快照')[0].trim()
}

export async function readSessionChat(ctx, sessionId) {
  const sc = ctx.get('sessionController')
  if (!sc) throw new Error(tr('会话服务不可用'))
  const projection = await sc.projections({ sessionId }, AbortSignal.timeout(10000))
  if (!projection || projection.kind === 'migration-required') throw new Error(tr('该会话暂时无法读取，请先在侧边栏打开'))
  const page = await sc.page({ address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 60 }, AbortSignal.timeout(15000))
  const messages = []
  for (const record of page.records ?? []) {
    const event = record.event
    if (!event) continue
    let role, text
    if (event.type === 'user/message') {
      role = 'user'
      text = userText(event)
    } else if (event.type === 'assistant/message') {
      role = 'assistant'
      text = (event.data.message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
    }
    if (text) messages.push({ id: `${sessionId}:${event.seq}`, sessionId, role, text, engine: 'session' })
  }
  return { sessionId, title: projection.values?.title || tr('未命名会话'), messages, hasMore: Boolean(page.hasMore), cursor: projection.asOfSeq }
}
