import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { sessionReply } from '../src/session-chat.js'

function fixture({ promptError } = {}) {
  const bus = new EventEmitter()
  let request
  let seq = 0
  const ctx = {
    get: () => ({ prompt: async value => { request = value; if (promptError) throw promptError; return { accepted: true } } }),
    on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn) },
  }
  return {
    ctx, bus, request: () => request,
    emit: (type, data, id = 'mapped') => bus.emit('session/event', { id }, { seq: ++seq, type, data }),
  }
}

const assistant = (turn, text) => ({ turn, message: { content: [{ type: 'text', text }] } })

test('映射回复等自己的轮次结束，忽略其他会话、排队前轮次和工具前的中途说明', async () => {
  const f = fixture()
  const reply = sessionReply(f.ctx, 'mapped', '新增一个灵感')
  let finished = false
  reply.then(() => { finished = true })
  f.emit('turn/start', { turn: 1 })
  f.emit('assistant/message', assistant(1, '上一轮回复'))
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.emit('turn/start', { turn: 99 }, 'other')
  f.emit('user/message', { source: { rpcId: f.request().requestId } }, 'other')
  f.emit('assistant/message', assistant(99, '别的会话'), 'other')
  f.emit('turn/start', { turn: 2 })
  f.emit('user/message', { source: { rpcId: f.request().requestId } })
  f.emit('assistant/message', assistant(2, '我先读取工作台'))
  f.emit('tool/result', { turn: 2, message: { content: [{ type: 'text', text: '写入成功' }] } })
  await Promise.resolve()
  assert.equal(finished, false)
  f.emit('assistant/message', assistant(2, '已新增灵感并设置排期'))
  f.emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(await reply, '已新增灵感并设置排期')
  assert.equal(f.bus.listenerCount('session/event'), 0)
})

test('Agent 出错时返回真实错误并移除订阅', async () => {
  const f = fixture()
  const reply = sessionReply(f.ctx, 'mapped', '修改灵感')
  const check = assert.rejects(reply, /测试供应方失败/)
  f.emit('turn/start', { turn: 1 })
  f.emit('user/message', { source: { rpcId: f.request().requestId } })
  f.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '测试供应方失败' } } })
  await check
  assert.equal(f.bus.listenerCount('session/event'), 0)
})

test('投递失败和超时都清理订阅，不重发操作', async () => {
  const failed = fixture({ promptError: new Error('目标会话不可用') })
  await assert.rejects(sessionReply(failed.ctx, 'mapped', '记灵感'), /目标会话不可用/)
  assert.equal(failed.bus.listenerCount('session/event'), 0)
  const waiting = fixture()
  await assert.rejects(sessionReply(waiting.ctx, 'mapped', '记灵感', { timeoutMs: 20 }), /不要重复发送/)
  assert.equal(waiting.bus.listenerCount('session/event'), 0)
})
