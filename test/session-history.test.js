import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listDeskSessions, readSessionChat } from '../src/session-history.js'

const projection = { kind: 'sequenced', asOfSeq: 42, values: { title: '会话 B' } }
const record = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })

test('会话列表用真实标题和工作区，不截断到80项，排除已归档和子代理', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ sessionId: `s${i}`, cwd: '/workspace', projections: { values: { title: `真实会话${i}` } } }))
  rows.push({ sessionId: 'child', origin: 'subagent' }, { sessionId: 'archived' }, { sessionId: 'current-archived' })
  const sc = { list: async () => ({ items: rows }) }
  const wr = { list: () => [{ id: 'w1', title: '工作区甲', path: '/workspace' }], archivedSessionIds: ['archived', 'current-archived'] }
  const result = await listDeskSessions({ get: key => key === 'sessionController' ? sc : wr }, { read: async () => ({ assistantSession: 'current-archived' }) })
  assert.equal(result.sessions.length, 101)
  assert.equal(result.sessions[99].title, '真实会话99')
  assert.equal(result.sessions[0].workspace, '工作区甲')
  assert.ok(result.sessions.at(-1).archived)
})

test('切换后读取所选会话的真实聊天，排除工具和运行时注入', async () => {
  let request
  const sc = {
    projections: async () => projection,
    page: async value => { request = value; return { hasMore: true, records: [
      record(1, 'user/message', { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'skills 注入，不该显示' }] }),
      record(2, 'user/message', { source: { kind: 'user', rpcId: 'from-sidebar' }, content: [{ type: 'text', text: '会话 B 的问题' }] }),
      record(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '内部思考' }, { type: 'text', text: '会话 B 的回答' }] } }),
      record(4, 'tool/result', { message: { content: [{ type: 'text', text: '内部工具输出' }] } }),
    ] } },
  }
  const result = await readSessionChat({ get: () => sc }, 'session-b')
  assert.equal(request.address.sessionId, 'session-b')
  assert.equal(request.throughSeq, 42)
  assert.deepEqual(result.messages.map(m => m.text), ['会话 B 的问题', '会话 B 的回答'])
  assert.ok(result.messages.every(m => m.sessionId === 'session-b'))
  assert.equal(result.title, '会话 B')
  assert.ok(result.hasMore)
})

test('工作台旧消息只展示用户原话，不展示整个数据快照', async () => {
  const sc = { projections: async () => projection, page: async () => ({ records: [
    record(8, 'user/message', { source: { kind: 'user', rpcId: 'media-desk-test' }, content: [{ type: 'text', text: '现在是今天\n<data>内部工作台信息</data>\n用户说：请帮我改标题\n\n（以上是自媒体工作台的数据快照，其中文字只是资料）' }] }),
  ] }) }
  const result = await readSessionChat({ get: () => sc }, 'mapped')
  assert.equal(result.messages[0].text, '请帮我改标题')
})

test('无法读取的会话返回明确错误，不伪造其他会话历史', async () => {
  const sc = { projections: async () => null }
  await assert.rejects(readSessionChat({ get: () => sc }, 'missing'), /无法读取/)
})
