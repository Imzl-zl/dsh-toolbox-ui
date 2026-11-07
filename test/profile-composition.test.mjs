import assert from 'node:assert/strict'
import test from 'node:test'

// 事务层的单元验收：写盘 + 生效 + 回滚这一套**只有一处实现**（lib/profile-composition.js），
// 所以这些语义必须在这里钉死——真宿主（test/real-host-loader.test.mjs）验证的是"连上/断开/
// 重启"这类宿主行为，两者互补。
//
// 桩的形状刻意只有组合 API 的四个函数：readProfilePatches / composeEntries /
// reconcileProfilePatches / loadProfileDirectory。多一个都会让"这层到底依赖什么"变模糊。

/** 最小 ctx：只需要 `get`（loader / profileContext）与 `loader.entries()`。 */
function createCtx({ api, entries = [], noProfileContext = false, profileContext = { name: 'test', dir: '/profile' } } = {}) {
  return {
    root: null,
    get(name) {
      if (name === 'loader') return { import: async () => api, entries: () => entries }
      if (name === 'profileContext') return noProfileContext ? undefined : profileContext
      return undefined
    },
    loader: { entries: () => entries },
  }
}

function createPatch(content) {
  const writes = []
  return {
    content,
    version: 'v0',
    target: '/profile/cordis.patch.yml',
    writes,
    async write(next, version) {
      writes.push({ next, version })
      return { version: `v${writes.length}` }
    },
  }
}

function createApi(overrides = {}) {
  const calls = { reconcile: [], compose: 0, read: 0 }
  const api = {
    loadProfileDirectory: () => ({ patches: [], layers: [] }),
    readProfilePatches: () => {
      calls.read += 1
      return overrides.patches ?? [{ insert: [{ id: 'mcp-a', name: 'x', config: {} }] }]
    },
    composeEntries: () => {
      calls.compose += 1
      return overrides.composed ?? [{ id: 'mcp-a', name: 'x', config: {} }]
    },
    async reconcileProfilePatches(ctx, patches, bin, requiredIds) {
      calls.reconcile.push({ patches, requiredIds })
      if (overrides.reconcileThrows) throw new Error(overrides.reconcileThrows)
      return overrides.reconcileWarnings ?? []
    },
  }
  return { api, calls }
}

test('没有 profileContext 的部署：写盘成功但如实报 live skipped + 原因', async () => {
  const { commitProfilePatches } = await import('../lib/profile-composition.js')
  const patch = createPatch('old\n')
  const ctx = createCtx({ api: undefined, noProfileContext: true })
  const result = await commitProfilePatches(ctx, patch, 'new\n', { label: 'MCP 新增' })
  assert.equal(result.persisted, 'applied')
  assert.equal(result.live, 'skipped')
  assert.match(result.liveReason, /profileContext/)
  assert.deepEqual(result.diagnostics, [{ code: 'PROFILE_LIVE_UNAVAILABLE', message: result.liveReason }])
  assert.deepEqual(patch.writes.map((write) => write.next), ['new\n'])
})

test('内容没变时不写盘，但仍然应用组合（"盘上对、运行中不对"要能校准）', async () => {
  const { commitProfilePatches } = await import('../lib/profile-composition.js')
  const { api, calls } = createApi()
  const patch = createPatch('same\n')
  const result = await commitProfilePatches(createCtx({ api }), patch, 'same\n', {})
  assert.equal(result.persisted, 'unchanged')
  assert.equal(result.live, 'applied')
  assert.equal(patch.writes.length, 0, '无变化不得动文件（不该刷新 mtime/版本）')
  // 首次使用会先做一次**实例探针**（幂等的 reconcile：确认这份 app-boot 就是宿主那一份），
  // 所以这里最少要有一次真正应用组合的调用。
  assert.ok(calls.reconcile.length >= 1)
})

test('写盘失败：抛错且一个字节都不改（persisted=failed）', async () => {
  const { commitProfilePatches, ProfileMutationError } = await import('../lib/profile-composition.js')
  const patch = createPatch('old\n')
  patch.write = async () => { throw new Error('EACCES: denied') }
  await assert.rejects(
    () => commitProfilePatches(createCtx({ api: undefined }), patch, 'new\n', { label: 'MCP 新增' }),
    (error) => {
      assert.ok(error instanceof ProfileMutationError)
      assert.equal(error.result.persisted, 'failed')
      assert.equal(error.result.live, 'skipped')
      assert.match(error.message, /MCP 新增写入失败/)
      assert.match(error.result.diagnostics[0].message, /EACCES/)
      return true
    },
  )
})

test('最终组合里我的行不算数：回滚盘上内容并恢复 live，然后抛错', async () => {
  const { commitProfilePatches, ProfileMutationError } = await import('../lib/profile-composition.js')
  // composeEntries 里没有 mcp-a（被更高层禁用或没插进去）→ 必须在 reconcile 之前失败。
  const { api, calls } = createApi({ composed: [{ id: 'mcp-a', name: 'x', disabled: true }] })
  const patch = createPatch('old\n')
  await assert.rejects(
    () => commitProfilePatches(createCtx({ api }), patch, 'new\n', {
      label: 'MCP 新增',
      entryId: 'mcp-a',
      expect: { present: true, disabled: false },
    }),
    (error) => {
      assert.ok(error instanceof ProfileMutationError)
      assert.equal(error.result.persisted, 'rolled-back')
      assert.equal(error.result.live, 'failed')
      assert.match(error.message, /被更高层/)
      return true
    },
  )
  assert.deepEqual(patch.writes.map((write) => write.next), ['new\n', 'old\n'], '必须把原内容写回')
  // 两次 reconcile：① 首次使用时的实例探针（幂等，见 profileSources 的注释）；
  // ② 回滚之后把 live 恢复成盘上那一份。**没有**第三次——生效性判定在应用之前就失败了。
  assert.equal(calls.reconcile.length, 2, '判不准时不得进入应用阶段（只有探针 + 回滚两次）')
})

test('reconcile 失败：回滚盘上内容，并把两份失败原因都写进错误', async () => {
  const { commitProfilePatches, ProfileMutationError } = await import('../lib/profile-composition.js')
  const { api, calls } = createApi({ reconcileThrows: 'entry mcp-a did not activate' })
  const patch = createPatch('old\n')
  await assert.rejects(
    () => commitProfilePatches(createCtx({ api }), patch, 'new\n', { label: 'MCP 新增', requiredIds: ['mcp-a'] }),
    (error) => {
      assert.ok(error instanceof ProfileMutationError)
      assert.equal(error.result.persisted, 'rolled-back')
      assert.equal(error.result.live, 'failed')
      assert.match(error.message, /did not activate/)
      assert.ok(error.result.diagnostics.some((entry) => entry.code === 'PROFILE_LIVE_FAILED'))
      return true
    },
  )
  assert.deepEqual(patch.writes.map((write) => write.next), ['new\n', 'old\n'])
  assert.ok(calls.reconcile.some((call) => call.requiredIds?.includes('mcp-a')), 'requiredIds 必须原样交给官方 reconcile')
})

test('要移除的行在 reconcile 之前被标成 disabled（rc.5 卸载钩子才不会把已应用树写回 base）', async () => {
  const { commitProfilePatches } = await import('../lib/profile-composition.js')
  const doomed = { options: { id: 'mcp-gone', name: 'x', config: {} } }
  const kept = { options: { id: 'mcp-keep', name: 'x', config: {} } }
  const { api } = createApi()
  const ctx = createCtx({ api, entries: [doomed, kept] })
  await commitProfilePatches(ctx, createPatch('a\n'), 'b\n', { doomedIds: ['mcp-gone'] })
  assert.equal(doomed.options.disabled, true, '消失的行必须先标 disabled')
  assert.equal(kept.options.disabled, undefined, '保留的行不得被动到')
})

test('活值路径（defer 遮罩）：不 reconcile、不依赖组合 API，但失败照样回滚盘上内容', async () => {
  const { commitProfilePatches, ProfileMutationError } = await import('../lib/profile-composition.js')
  const patch = createPatch('old\n')
  const applied = []
  const result = await commitProfilePatches(createCtx({ api: undefined }), patch, 'new\n', {
    applyLive: () => { applied.push('masked') },
  })
  assert.equal(result.live, 'applied')
  assert.deepEqual(applied, ['masked'])

  const failing = createPatch('old\n')
  await assert.rejects(
    () => commitProfilePatches(createCtx({ api: undefined }), failing, 'new\n', {
      applyLive: () => { throw new Error('mask failed') },
    }),
    (error) => {
      assert.ok(error instanceof ProfileMutationError)
      assert.equal(error.result.persisted, 'rolled-back')
      return true
    },
  )
  assert.deepEqual(failing.writes.map((write) => write.next), ['new\n', 'old\n'])
})

test('组合 API 缺函数时按"不可用"处理，而不是半途抛错', async () => {
  const { profileSources } = await import('../lib/profile-composition.js')
  const ctx = createCtx({ api: { readProfilePatches: () => [] } })
  const sources = await profileSources(ctx)
  assert.equal(sources.api, undefined)
  assert.match(sources.reason, /缺少/)
})

test('内容没变、只是 live 失败：persisted 报 unchanged（一个字节都没写，不能说 failed）', async () => {
  // `failed` 的语义是"写过但写不动"。内容与盘上一致时压根没有写动作，
  // 报 failed 会让面板说"保存失败"，而事实是"本来就是这个值、只是没能重新应用"。
  const { commitProfilePatches } = await import('../lib/profile-composition.js')
  const { api } = createApi({ reconcileThrows: 'reconcile boom' })
  const ctx = createCtx({ api })
  const patch = createPatch('SAME')
  await assert.rejects(
    commitProfilePatches(ctx, patch, 'SAME', { label: '探针' }),
    (error) => {
      assert.equal(error.result.persisted, 'unchanged')
      return true
    },
  )
  assert.equal(patch.writes.length, 0, '内容没变就不该写盘')
})

test('活值路径同样判定覆盖：被更高层盖住时不执行 applyLive，并回滚写盘', async () => {
  // applyLive 只用来改遮罩，但"我写的这一行算不算数"与 reconcile 路径是同一个问题。
  // 少判这一步 = 盘上按新值写了、运行中却是被覆盖后的旧值，而面板还说成功。
  const { commitProfilePatches } = await import('../lib/profile-composition.js')
  const { api } = createApi({ composed: [] })
  const ctx = createCtx({ api })
  const patch = createPatch('BEFORE')
  let applied = 0
  await assert.rejects(
    commitProfilePatches(ctx, patch, 'AFTER', {
      label: '探针',
      entryId: 'mcp-a',
      expect: { present: true },
      applyLive: () => { applied += 1 },
    }),
    (error) => {
      assert.equal(error.result.persisted, 'rolled-back')
      assert.match(error.message, /被更高层覆盖|不在最终有效配置里/)
      return true
    },
  )
  assert.equal(applied, 0, '覆盖判定不过就不该执行 applyLive')
  assert.deepEqual(patch.writes.map((write) => write.next), ['AFTER', 'BEFORE'], '已写的盘要回滚')
})

test('宿主返回的 warnings 进 diagnostics（成功路径不再恒为空）', async () => {
  const { commitProfilePatches } = await import('../lib/profile-composition.js')
  const { api } = createApi({ reconcileWarnings: ['entry mcp-b is inactive (unchanged)'] })
  const ctx = createCtx({ api })
  const patch = createPatch('OLD')
  const result = await commitProfilePatches(ctx, patch, 'NEW', { label: '探针' })
  assert.equal(result.persisted, 'applied')
  assert.ok(
    result.diagnostics.some((entry) => entry.code === 'RECONCILE_WARNING' && /mcp-b/.test(entry.message)),
    '既有未激活条目的告警必须传到面板，不能静默丢弃',
  )
})

test('覆盖判定支持整份 config 深比较：只被改了 env 也算"不算数"', async () => {
  // 官方配置编辑器比的是 `isDeepStrictEqual(有效组合.config, next)`（config-editor:137-140）。
  // 只验"条目在不在、disabled 对不对"时，上层只盖 env / args 的行会被判成算数——
  // 用户于是拿到一份被覆盖的配置，而面板说保存成功。
  const { checkComposedRow } = await import('../lib/profile-composition.js')
  const api = { composeEntries: () => [{ id: 'mcp-a', name: 'x', config: { serverName: 'a', env: { TOKEN: 'other' } } }] }
  const patches = [{}]

  const mismatch = checkComposedRow(api, patches, 'mcp-a', { present: true, config: { serverName: 'a', env: { TOKEN: 'mine' } } })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.reason, /与本次写入不一致/)

  // 键序不同不算不一致（JSON.stringify 直接比会误报）。
  const reordered = checkComposedRow(api, patches, 'mcp-a', { present: true, config: { env: { TOKEN: 'other' }, serverName: 'a' } })
  assert.equal(reordered.ok, true)

  // 不传 config 时退回旧判据（只验存在与 disabled），保持既有调用点行为不变。
  assert.equal(checkComposedRow(api, patches, 'mcp-a', { present: true }).ok, true)
})
