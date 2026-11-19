// 宿主侧 `contextReport` 的**形状**用例。
//
// 为什么单独一条：`buildContextReport` 是纯函数，它的单测夹具直接把内层 breakdown
// （`{systemTokens, toolsTokens, messageTokens}`）传进去——那是**函数要的形状**，不是
// **宿主给的形状**。宿主 `contextBreakdown` 投影的 state 是
//
//   { systems, surfaceTokens, claim?, breakdown: { systemTokens, toolsTokens, messageTokens } }
//
// 两层。装配处（`lib/index.js` 的 `contextReportFor`）如果直接把 state 传下去，
// 纯函数读到的 `toolsTokens` 永远是 undefined，面板的「占上下文」就一直是 "—"，
// 而上面那组纯函数用例**全绿**——两边各自都"对"，错的是接缝。
//
// 2026-11-19 真机复现：面板工具卡显示「37 工具数 / — 占上下文 / 0 搜索次数」。
// 这条用例钉住接缝：喂**宿主真实形状**，断言报告里真的带上了工具定义的价格。
import assert from 'node:assert/strict'
import test from 'node:test'

import { McpManagerGateway } from '../lib/index.js'

/**
 * 一个足够真实的宿主 context：活会话 + tokenMeter + sessionProjections。
 * 只实现 `contextReportFor` 真正会读的那几个成员（多给的会掩盖真实依赖）。
 */
function fakeHost({ projectionState, measurement = null, pressure = null }) {
  const events = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'assistant/message', seq: 2, turn: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const session = {
    id: 'session-shape',
    header: { cwd: '/ws' },
    snapshotEvents: () => events,
    requestContext: () => ({ provider: 'deepseek', model: 'm', contextWindow: 1000 }),
    requestHeader: () => ({ tools: [{ name: 'read' }, { name: 'pwsh' }] }),
  }
  const services = {
    agents: { list: () => [{ session }] },
    sessions: { list: () => [session] },
    tokenMeter: {
      measure: () => measurement,
      contextPressure: () => pressure,
    },
    sessionProjections: {
      // ⚠️ 这里刻意返回**投影 state**（宿主 `stateOf('contextBreakdown')` 的真实返回），
      // 不是内层 breakdown。
      stateOf: (_session, key) => (key === 'contextBreakdown' ? projectionState : undefined),
    },
  }
  return {
    ctx: {
      get: (name) => services[name],
      logger: { warn() {}, debug() {} },
    },
  }
}

const PROJECTION_STATE = {
  systems: [{ seq: 0, tokens: 120 }],
  surfaceTokens: 400,
  breakdown: { systemTokens: 120, toolsTokens: 77, messageTokens: 300 },
}

test('contextReport 读的是投影 state 里的 breakdown，工具定义的价格必须落到报告上', async () => {
  const { ctx } = fakeHost({ projectionState: PROJECTION_STATE })
  const report = await McpManagerGateway.prototype.contextReport.call({ ctx }, { sessionId: 'session-shape' })

  assert.equal(report.tools.total, 2, '工具数量来自请求头')
  assert.equal(report.tools.tokens, 77, '工具定义的价格来自投影 state 的 breakdown.toolsTokens（不是 state 顶层）')
  const toolsKind = report.kinds.find((kind) => kind.kind === 'tools')
  assert.equal(toolsKind.tokens, 77, '分类合计里也要有，客户端工具卡的「占上下文」就是读这个')
})

test('投影缺席时如实给 null，不把「没有」写成 0', async () => {
  const { ctx } = fakeHost({ projectionState: undefined })
  const report = await McpManagerGateway.prototype.contextReport.call({ ctx }, { sessionId: 'session-shape' })
  assert.equal(report.tools.tokens, null, '宿主没给价格时要如实为空')
  assert.equal(report.tools.total, 2, '没有价格不影响工具数量本身')
})
