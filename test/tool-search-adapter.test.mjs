import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CORDIS_ORIGINAL,
  GENERATIONS,
  detectToolsGeneration,
  installAssembleDecorator,
  installPresentationPort,
} from '../lib/tool-search-adapter.js'

// ── 代次判定：只按能力，不看版本号 ──

test('detectToolsGeneration: resolve/definitions 是现代，presentAs/sdkSchemas/modeFor 是旧代', () => {
  assert.equal(detectToolsGeneration({ resolve() {}, definitions() {} }).generation, GENERATIONS.MODERN)
  assert.equal(detectToolsGeneration({ presentAs() {} }).generation, GENERATIONS.LEGACY)
  assert.equal(detectToolsGeneration({ sdkSchemas() {} }).generation, GENERATIONS.LEGACY)
  assert.equal(detectToolsGeneration({ modeFor() {} }).generation, GENERATIONS.LEGACY)
  // 两者俱全：现代契约优先，并且如实标出 legacy 能力也在（可能在打补丁）。
  const both = detectToolsGeneration({ resolve() {}, definitions() {}, presentAs() {} })
  assert.equal(both.generation, GENERATIONS.MODERN)
  assert.equal(both.modern, true)
  assert.equal(both.legacy, true)
  // 都没有：明确 unknown，不许当成 legacy 装上去。
  const unknown = detectToolsGeneration({ register() {} })
  assert.equal(unknown.generation, GENERATIONS.UNKNOWN)
  assert.throws(
    () => installPresentationPort({}, { register() {} }, async (assembly) => assembly),
    /无法识别宿主工具契约/,
  )
})

// ── assemble 装饰：所有权 / 卸载 / 第三方冲突 / HMR ──

function fakeCtx(initialService) {
  const listeners = new Set()
  let service = initialService
  return {
    get: (name) => (name === 'systemPrompt' ? service : undefined),
    on: (event, handler) => {
      if (event !== 'internal/service') return () => {}
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    // 模拟 cordis：服务重挂时发 internal/service。
    remount(next) {
      service = next
      for (const handler of [...listeners]) handler('systemPrompt', next)
    },
    listeners,
  }
}

/** 一个最小 systemPrompt 服务：assemble 返回带 tools/sections 的 assembly。
 *  `service` 模拟 cordis 代理：读 assemble 永远转发到实例当前的值（装饰后才看得见）。 */
function fakeSystemPrompt(label, assembly = { tools: [{ name: 'keep' }, { name: 'hidden' }], sections: [{ name: 'guidance', text: 'x' }] }) {
  const target = {
    async assemble(context = {}) {
      target.calls.push(context)
      return { ...assembly, marker: label }
    },
    calls: [],
  }
  const service = {
    [CORDIS_ORIGINAL]: target,
    get assemble() { return target.assemble },
  }
  return { target, service }
}

test('assemble decorator: 装饰真实实例，投影函数拿到最终 assembly，卸载后恢复', async () => {
  const { target, service } = fakeSystemPrompt('host')
  const ctx = fakeCtx(service)
  const seen = []
  const port = installAssembleDecorator(ctx, async (assembly, context) => {
    seen.push({ assembly, agent: context.agent })
    return { ...assembly, tools: assembly.tools.filter((tool) => tool.name !== 'hidden') }
  })
  assert.equal(port.status().attached, true)
  const agent = { id: 'a1' }
  const viaProxy = await ctx.get('systemPrompt').assemble({ agent })
  assert.deepEqual(viaProxy.tools.map((tool) => tool.name), ['keep'])
  assert.equal(viaProxy.marker, 'host')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, agent)
  // 没有 agent 的组装（诊断/非 step）不该被投影。
  const diagnostic = await ctx.get('systemPrompt').assemble({})
  assert.deepEqual(diagnostic.tools.map((tool) => tool.name), ['keep', 'hidden'])
  port.dispose()
  assert.equal(port.status().attached, false)
  const after = await ctx.get('systemPrompt').assemble({ agent })
  assert.deepEqual(after.tools.map((tool) => tool.name), ['keep', 'hidden'], '卸载后必须回到宿主原样')
})

test('assemble decorator: 两个消费者共享一个分发层，只包一层', async () => {
  const { target, service } = fakeSystemPrompt('host')
  const ctx = fakeCtx(service)
  const first = installAssembleDecorator(ctx, async (assembly) => ({ ...assembly, first: true }))
  const wrappedOnce = target.assemble
  const second = installAssembleDecorator(ctx, async (assembly) => ({ ...assembly, second: true }))
  assert.equal(target.assemble, wrappedOnce, '第二个消费者不许再套一层（一次组装只能跑一遍投影链）')
  const out = await target.assemble({ agent: { id: 'a' } })
  assert.equal(out.first, true)
  assert.equal(out.second, true)
  first.dispose()
  const stillThere = await target.assemble({ agent: { id: 'a' } })
  assert.equal(stillThere.second, true, '还有消费者时不许摘掉分发层')
  assert.equal(stillThere.first, undefined)
  second.dispose()
  const restored = await target.assemble({ agent: { id: 'a' } })
  assert.equal(restored.second, undefined)
})

test('assemble decorator: 第三方先装 → 链在它后面；卸载只摘自己，恢复它的 descriptor', async () => {
  const { target, service } = fakeSystemPrompt('host')
  const plainAssemble = target.assemble
  const thirdParty = async function (context) {
    const assembly = await plainAssemble.call(this, context)
    return { ...assembly, third: true }
  }
  Object.defineProperty(target, 'assemble', { value: thirdParty, configurable: true, writable: true })
  const ctx = fakeCtx(service)
  const diagnostics = []
  const port = installAssembleDecorator(ctx, async (assembly) => ({ ...assembly, ours: true }), {
    onDiagnostic: (event) => diagnostics.push(event),
  })
  assert.ok(diagnostics.some((event) => event.code === 'PRESENTATION_CHAINED'))
  const out = await ctx.get('systemPrompt').assemble({ agent: { id: 'a' } })
  assert.equal(out.third, true)
  assert.equal(out.ours, true)
  port.dispose()
  assert.equal(target.assemble, thirdParty, '卸载必须恢复第三方的实现，而不是删掉它')
})

test('assemble decorator: 我们之后被第三方替换 → 卸载不覆盖，并报冲突', async () => {
  const { target, service } = fakeSystemPrompt('host')
  const ctx = fakeCtx(service)
  const diagnostics = []
  const port = installAssembleDecorator(ctx, async (assembly) => ({ ...assembly, ours: true }), {
    onDiagnostic: (event) => diagnostics.push(event),
  })
  const ours = target.assemble
  const replacement = async () => ({ tools: [], replaced: true })
  Object.defineProperty(target, 'assemble', { value: replacement, configurable: true, writable: true })
  port.dispose()
  assert.equal(target.assemble, replacement, '不覆盖别人的后续替换')
  assert.ok(diagnostics.some((event) => event.code === 'PRESENTATION_REPLACED'))
  assert.notEqual(target.assemble, ours)
})

test('assemble decorator: HMR 服务重挂后重新绑定到新实例，旧实例解绑', async () => {
  const firstHost = fakeSystemPrompt('v1')
  const ctx = fakeCtx(firstHost.service)
  const port = installAssembleDecorator(ctx, async (assembly) => ({ ...assembly, presented: 'v1' }))
  assert.equal((await firstHost.target.assemble({ agent: { id: 'a' } })).presented, 'v1')

  const secondHost = fakeSystemPrompt('v2')
  ctx.remount(secondHost.service)
  const rebound = await ctx.get('systemPrompt').assemble({ agent: { id: 'a' } })
  assert.equal(rebound.presented, 'v1', '新实例必须重新装上投影')
  assert.equal(rebound.marker, 'v2')
  // 旧实例已经解绑：不再被投影。
  const oldResult = await firstHost.target.assemble({ agent: { id: 'a' } })
  assert.equal(oldResult.presented, undefined)
  port.dispose()
  assert.equal(ctx.get('systemPrompt').assemble, secondHost.target.assemble)
})

test('assemble decorator: systemPrompt 缺席时明确报不可用，晚到后能重绑', async () => {
  const ctx = fakeCtx(undefined)
  const diagnostics = []
  const port = installAssembleDecorator(ctx, async (assembly) => assembly, {
    onDiagnostic: (event) => diagnostics.push(event),
  })
  assert.equal(port.status().attached, false)
  assert.ok(diagnostics.some((event) => event.code === 'PRESENTATION_SERVICE_UNAVAILABLE'))
  const late = fakeSystemPrompt('late')
  ctx.remount(late.service)
  assert.equal(port.status().attached, true)
  port.dispose()
})
