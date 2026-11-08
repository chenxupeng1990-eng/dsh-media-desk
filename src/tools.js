// 工作台能力以 Tool 的形式注册给 Harness 的真实 Agent。
// 映射会话里的 Agent（以及主会话）通过这些工具读写工作台数据，接手原先插件助手的结构化操作。
import { applyOps } from './ops.js'
import { computeInsights } from './learn.js'
import { tr } from './i18n.js'

const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

function deskState(state) {
  const items = (state.items ?? []).map(row => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    platform: row.platform ?? null,
    scheduledAt: row.scheduledAt ?? null,
    hasProduction: Boolean(row.production?.article),
    productionTitle: row.production?.title ?? null,
  }))
  return {
    items,
    styles: (state.styles ?? []).map(row => ({ id: row.id, name: row.name, preset: Boolean(row.preset) })),
    activeStyleId: state.activeStyleId ?? '',
    skills: (state.skills ?? []).map(row => ({ id: row.id, name: row.name, status: row.status })),
    accounts: (state.accounts ?? []).map(row => ({ id: row.id, platform: row.platform, handle: row.handle })),
    metricCount: (state.metrics ?? []).length,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * 在插件 Host 上下文里注册工具。全局注册：所有会话的 Agent 都可调。
 * @returns 注销函数
 */
export function registerDeskTools(ctx, store) {
  const tools = ctx.get('tools')
  if (!tools?.register) return () => {}

  const disposers = []
  const add = definition => disposers.push(tools.register(definition))

  add({
    name: 'media_desk_state',
    description: '读取自媒体工作台当前状态：灵感条目（含真实 id、状态、排期、成稿标题）、风格卡、规则、账号和数据条数。执行任何写操作前先用它确认真实存在的 id，不要编造。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        items: { type: 'array', items: { type: 'object' } },
        styles: { type: 'array', items: { type: 'object' } },
        activeStyleId: { type: 'string' },
        skills: { type: 'array', items: { type: 'object' } },
        accounts: { type: 'array', items: { type: 'object' } },
        metricCount: { type: 'integer' },
        generatedAt: { type: 'string' },
      } },
      render: (_args, value) => text(value),
    },
    async execute() {
      return deskState(await store.read())
    },
  })

  add({
    name: 'media_desk_ops',
    description: '对自媒体工作台执行结构化写操作。传 ops 数组，每项是一个对象，op 为操作名。常用：{"op":"add_item","title":"灵感标题","body":"正文","kind":"note","platform":"小红书"}；{"op":"update_item","id":"条目id","title":"新标题"}；{"op":"schedule_item","id":"条目id","scheduledAt":"2026-11-10T12:00:00.000Z"}（传 null 取消排期）；{"op":"set_style","id":"风格id或null"}；{"op":"delete_item","id":"条目id"}；{"op":"add_skill","name":"规则名","rule":"规则内容"}。id 必须先用 media_desk_state 查得。',
    parameters: { type: 'object', additionalProperties: false, required: ['ops'], properties: {
      ops: { type: 'array', description: '操作对象数组', items: { type: 'object' } },
    } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        receipts: { type: 'array' },
        errors: { type: 'array' },
      } },
      render: (_args, value) => text(value.errors?.length ? `操作完成，但有错误：${JSON.stringify(value.errors)}` : `已执行 ${value.receipts?.length ?? 0} 项操作：${(value.receipts ?? []).map(r => r.text).join('；')}`),
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted()
      const ops = Array.isArray(args?.ops) ? args.ops : []
      const result = await store.mutate(tr('Agent 操作工作台'), (draft) => {
        exec?.signal?.throwIfAborted()
        const applied = applyOps(draft, ops)
        return { ...applied, state: draft }
      })
      return { receipts: result.receipts ?? [], errors: result.errors ?? [] }
    },
  })

  add({
    name: 'media_desk_insights',
    description: '读取自媒体工作台的复盘统计：总播放/互动、互动率、按平台分布、表现最好的内容、每日趋势。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(value),
    },
    async execute() {
      return computeInsights(await store.read())
    },
  })

  return () => { for (const dispose of disposers) dispose() }
}
