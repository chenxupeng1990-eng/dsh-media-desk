import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store.js'
import { registerDeskTools } from '../src/tools.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const definitions = new Map()
  const dispose = registerDeskTools({ get: () => ({ register: tool => {
    definitions.set(tool.name, tool)
    return () => definitions.delete(tool.name)
  } }) }, store)
  t.after(dispose)
  return { store, definitions, dispose, call: (name, args = {}, signal) => definitions.get(name).execute(args, { signal }) }
}

test('Agent 工具复用界面操作：创建、改标题、排期、错误回执和撤销', async t => {
  const f = await fixture(t)
  const created = await f.call('media_desk_ops', { ops: [{ op: 'add_item', title: '工具验证', kind: 'note', platform: '小红书' }] })
  assert.deepEqual(created.errors, [])
  const id = created.receipts[0].target
  const state = await f.call('media_desk_state')
  assert.ok(state.items.some(item => item.id === id))
  const scheduledAt = '2026-11-09T01:00:00.000Z'
  await f.call('media_desk_ops', { ops: [{ op: 'update_item', id, title: '标题已修改' }, { op: 'schedule_item', id, scheduledAt }] })
  const current = (await f.call('media_desk_state')).items.find(item => item.id === id)
  assert.equal(current.title, '标题已修改')
  assert.equal(current.scheduledAt, scheduledAt)
  assert.equal(current.status, 'outline')
  await f.store.undoLast()
  const undone = (await f.call('media_desk_state')).items.find(item => item.id === id)
  assert.equal(undone.title, '工具验证')
  assert.equal(undone.scheduledAt, null)
  const invalid = await f.call('media_desk_ops', { ops: [{ op: 'update_item', id: 'not-an-item', title: '无效' }] })
  assert.equal(invalid.errors.length, 1)
  assert.equal(invalid.receipts.length, 0)
  assert.doesNotThrow(() => f.definitions.get('media_desk_ops').output.render({}, invalid))
  const insights = await f.call('media_desk_insights')
  assert.equal(typeof insights.views, 'number')
  f.dispose()
  assert.equal(f.definitions.size, 0)
})

test('取消的工具写入不改数据', async t => {
  const f = await fixture(t)
  const before = (await f.call('media_desk_state')).items.length
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.call('media_desk_ops', { ops: [{ op: 'add_item', title: '不该写入' }] }, abort.signal))
  assert.equal((await f.call('media_desk_state')).items.length, before)
})
