import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import { installProjectionPort } from '../lib/tool-search-projections.js'
import { discoveryProjection, PROJECTION_KEY } from '../lib/tool-search-state.js'
import { z } from 'zod'

const definition = () => discoveryProjection({ z, toolName: 'tool_search', max: 10 })

test('legacy 宿主：同步 disposer + stateOf(session, key)，cleanup 也是同步的', async () => {
  const units = new Map()
  const cells = new Map()
  const service = {
    register: (def) => {
      units.set(def.key, def)
      return () => units.delete(def.key)
    },
    stateOf: (session, key) => {
      if (!units.has(key)) return undefined
      const state = cells.get(session) ?? []
      return { discovered: [...state] }
    },
  }
  const ctx = { get: (name) => (name === 'sessionProjections' ? service : undefined) }
  const port = installProjectionPort(ctx, definition(), { key: PROJECTION_KEY })
  assert.equal(port.available, true)
  assert.deepEqual(await port.ready, { state: 'ready' })
  assert.equal(port.status().legacy, true)
  cells.set({ id: 's' }, ['a'])
  const session = { id: 's' }
  cells.set(session, ['a'])
  assert.deepEqual(port.stateOf(session), { discovered: ['a'] })
  // cleanup 必须**同步**生效：现代宿主的 HMR 会在同一 tick 内重新注册同一个 key。
  assert.equal(port.dispose(), undefined)
  assert.equal(units.size, 0)
})

test('modern 宿主：异步 handle——就绪前读取返回 undefined，释放要 await handle.dispose', async () => {
  let disposed = false
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const handle = {
    stateOf: (session) => ({ discovered: session === undefined ? [] : ['from-handle'] }),
    dispose: async () => { disposed = true },
  }
  const service = {
    // 现代宿主返回 thenable handle；注册本身也是异步完成的。
    register: () => ready.then(() => handle),
    stateOf: () => { throw new Error('deprecated sync stateOf must not be used when a handle exists') },
  }
  const ctx = { get: (name) => (name === 'sessionProjections' ? service : undefined) }
  const port = installProjectionPort(ctx, definition(), { key: PROJECTION_KEY })
  // 未就绪：读取返回 undefined（调用方退回派生消息），且不会去碰废弃的同步 API。
  assert.equal(port.stateOf({ id: 's' }), undefined)
  assert.equal(port.status().state, 'pending')
  release()
  assert.deepEqual(await port.ready, { state: 'ready' })
  assert.equal(port.status().state, 'ready')
  assert.deepEqual(port.stateOf({ id: 's' }), { discovered: ['from-handle'] })
  await port.dispose()
  assert.equal(disposed, true)
  assert.equal(port.stateOf({ id: 's' }), undefined)
})

test('注册失败：明确报 failed + 诊断，恢复能力不得写成 ready', async () => {
  const diagnostics = []
  const service = { register: () => Promise.reject(new Error('duplicate key')) }
  const ctx = { get: (name) => (name === 'sessionProjections' ? service : undefined) }
  const port = installProjectionPort(ctx, definition(), { key: PROJECTION_KEY, onDiagnostic: (event) => diagnostics.push(event) })
  const result = await port.ready
  assert.equal(result.state, 'failed')
  assert.match(result.reason, /duplicate key/)
  assert.deepEqual(diagnostics.map((event) => event.code), ['PROJECTION_REGISTER_FAILED'])
  assert.equal(port.stateOf({ id: 's' }), undefined)
  await port.dispose()
})

test('投影句柄缺失读取契约时，失败不能同时发布 ready', async () => {
  const diagnostics = []
  let released = false
  const service = { register: async () => ({ async dispose() { released = true } }) }
  const port = installProjectionPort({ get: () => service }, definition(), { key: PROJECTION_KEY, onDiagnostic: (event) => diagnostics.push(event) })
  try {
    assert.equal((await port.ready).state, 'failed')
    assert.equal(port.status().state, 'failed')
    assert.equal(port.stateOf({ id: 's' }), undefined)
    assert.deepEqual(diagnostics.map(({ code }) => code), ['PROJECTION_REGISTER_FAILED'])
  } finally {
    await port.dispose()
  }
  assert.equal(released, true, '即使句柄无效也要释放已获得的资源')
})

const hasNewHost = typeof Tools.prototype.resolve === 'function' && typeof Tools.prototype.definitions === 'function'
const modern = { skip: !hasNewHost && 'legacy host' }
async function setupRealProjectionRegistry() {
  const require = createRequire(import.meta.url)
  const fromLoop = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
  const [{ default: SessionProjectionRegistry }, { Session }] = await Promise.all([
    import(pathToFileURL(fromLoop.resolve('@deepseek-ai/dsh-session-projection')).href),
    import(pathToFileURL(fromLoop.resolve('@deepseek-ai/dsh-session')).href),
  ])
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, Session, service: ctx.get('sessionProjections') }
}

test('真实现代投影：await 可调用的注册对象，等到句柄后才读取并等待释放', modern, async () => {
  const { ctx, Session } = await setupRealProjectionRegistry()
  const session = new Session('tool-search-projection-fixture')
  const port = installProjectionPort(ctx, definition(), { key: PROJECTION_KEY })
  try {
    assert.equal(port.status().state, 'pending', '现代宿主未交付句柄前不能发布 ready')
    assert.equal(port.stateOf(session), undefined)
    assert.deepEqual(await port.ready, { state: 'ready' })
    assert.equal(port.status().legacy, false, '可调用 thenable 仍是现代注册')
    assert.deepEqual(port.stateOf(session)?.discovered, [])
    const disposing = port.dispose()
    assert.ok(disposing instanceof Promise, '现代释放必须可等待')
    await disposing
    assert.equal(port.stateOf(session), undefined)
  } finally {
    await port.dispose()
    await ctx.fiber.dispose()
  }
})

test('真实现代投影：宿主拒绝注册时暴露 failed 与诊断', modern, async () => {
  const { ctx, service } = await setupRealProjectionRegistry()
  const active = await service.register(definition())
  const port = installProjectionPort(ctx, { ...definition(), stateVersion: definition().stateVersion + 1 }, { key: PROJECTION_KEY })
  try {
    const result = await port.ready
    assert.equal(result.state, 'failed', '不可把被宿主拒绝的注册报为 ready')
    assert.match(result.reason, /stateVersion/)
    assert.equal(port.status().state, 'failed')
    assert.deepEqual(port.status().diagnostics.map(({ code }) => code), ['PROJECTION_REGISTER_FAILED'])
  } finally {
    await port.dispose()
    if (typeof active?.dispose === 'function') await active.dispose()
    await ctx.fiber.dispose()
  }
})

test('宿主没有投影服务：unavailable，不假装注册过', async () => {
  const port = installProjectionPort({ get: () => undefined }, definition(), { key: PROJECTION_KEY })
  assert.equal(port.available, false)
  assert.equal((await port.ready).state, 'unavailable')
  assert.equal(port.stateOf({ id: 's' }), undefined)
  await port.dispose()
})

