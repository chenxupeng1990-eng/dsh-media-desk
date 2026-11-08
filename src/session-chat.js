// 映射会话保持单写者：投递走 Session Controller，只观察对应请求所在轮次的持久化事件。
import { randomUUID } from 'node:crypto'
import { tr } from './i18n.js'

export async function sessionReply(ctx, sessionId, text, { timeoutMs = 120_000 } = {}) {
  const sc = ctx.get('sessionController')
  if (!sc) throw new Error(tr('会话服务不可用'))
  const requestId = `media-desk-${randomUUID()}`
  return new Promise((resolve, reject) => {
    let currentTurn = null
    let targetTurn = null
    let reply = ''
    let settled = false
    let dispose = () => {}
    let timer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      dispose()
      if (error) reject(error)
      else resolve(reply || tr('处理好了。'))
    }
    // 订阅先于投递，避免快速回复漏读；不能把工具执行前的“我来处理”当完成。
    dispose = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      if (event.type === 'turn/start') currentTurn = event.data.turn
      if (event.type === 'user/message' && event.data.source?.rpcId === requestId) targetTurn = currentTurn
      if (targetTurn === null || event.data?.turn !== targetTurn) return
      if (event.type === 'assistant/message') {
        const content = event.data.message?.content ?? []
        const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
        if (text) reply = text
      }
      if (event.type === 'turn/end') {
        const reason = event.data.reason
        finish(reason?.kind === 'completed' ? null : new Error(reason?.error?.message || tr('映射会话未完成：{reason}', { reason: reason?.kind ?? 'unknown' })))
      }
    })
    timer = setTimeout(() => finish(new Error(tr('映射会话仍在处理，请到所选会话查看进度；不要重复发送同一操作'))), timeoutMs)
    sc.prompt(
      { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      AbortSignal.timeout(30000),
    ).catch(finish)
  })
}
