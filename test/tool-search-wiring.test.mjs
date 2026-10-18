import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 装配路径的端到端验收：真 cordis Context + 真 McpManagerGateway + 高保真宿主替身。
// 覆盖的三段在此前只有分件测试：① index.js 构造函数里的 installToolSearchRuntime 装配；
// ② tool-search-config 配置桥（loader 条目 → deferServers，含 DSH_MCP_TOOL_SEARCH 总开关）；
// ③ 遮罩在真实装配后的可观测行为（守卫对延迟服务器工具的判定）。

const MCP_TOOLS = Array.from({ length: 16 }, (_, index) => ({
  name: `mcp__deferme__tool_${index}`,
  description: `deferred tool number ${index}`,
  parameters: { type: 'object', properties: {} },
}))

function createAgent() {
  return {
    session: { snapshotEvents: () => [] },
    ctx: { tools: { schemas: () => MCP_TOOLS } },
  }
}

/** 装载真插件，返回捕获面。deferEntries 控制 loader 条目里的 defer 配置。
 *  patchBody 覆盖写进 cordis.patch.yml 的初始内容（默认空列表）——需要真实 patch 条目
 *  的用例（如 setDeferAll）用它。occupied 模拟"工具名已被别人占用"（G4 重名预检）。 */
async function mountPlugin(deferEntries, { toolsMode, patchBody = '[]\n', occupied = [] } = {}) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { McpManagerGateway } = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-wiring-'))
  const patch = join(root, 'cordis.patch.yml')
  await writeFile(patch, patchBody)
  const registered = []
  const guards = []
  const sections = []
  // 稳定引用的 entry 对象：真实 loader 的 entries 是持久对象，每次调用返回同一批引用。
  // 若每次新建对象，任何"把新配置写回内存 entry"的路径都会改到一次性副本上——
  // 那恰好会把这类同步变成无声无息的无操作，于是测试全绿而真机不生效。
  const mcpEntries = deferEntries.map((config) => ({
    options: { id: `mcp-${config.serverName}`, name: '@deepseek-ai/dsh-mcp-client', config },
  }))
  const includeEntry = { options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(patch).href } } }
  // create/remove 必须补：add / removeServer / installBuiltins 靠它们在**运行中的进程**里
  // 增删 loader 条目（旧行为只写盘）。桩上做同一份 entries 数组上的增删——稳定引用、可观测，
  // 与 entries() 同一个真相源。真正的"连上了、子进程退了"由 test/real-host-loader.test.mjs
  // 的真 loader 夹具覆盖。
  // entry.parent.remove(id) 是 loader 里"停掉并移除一个条目"的原语，removeServer 走它
  // （不走 ctx.loader.remove——那条对 include 子树条目是静默 no-op，见 lib/index.js 的注释）。
  const loaderEntries = [includeEntry, ...mcpEntries]
  const group = {
    remove: async (id) => {
      const index = loaderEntries.findIndex((entry) => entry.options.id === id)
      if (index >= 0) loaderEntries.splice(index, 1)
    },
  }
  for (const entry of loaderEntries) entry.parent = group
  const ctx = new Context()
  await ctx.plugin({
    name: 'host-stub',
    apply(inner) {
      inner.provide('loader', {
        entries: () => loaderEntries,
        create: async (options) => {
          const entry = { options: { ...options }, parent: group }
          loaderEntries.push(entry)
          return options.id
        },
        remove: async (id) => group.remove(id),
      })
      inner.provide('tools', {
        schemas: () => [],
        register: (definition) => { registered.push(definition.name); return () => {} },
        guard: (fn) => { guards.push(fn); return () => {} },
        // 公开的重名预检入口（G4）：宿主 NamedEntries.insert 对重名直接抛错，所以注册前
        // 必须先用 get() 问一次。
        get: (name) => (occupied.includes(name) ? { name } : undefined),
        // 宿主读部署默认模式的公开 API（dsh-tools modeFor，不传 scope 即默认层）。
        // PTC 下 assembly.tools 只剩 run_code，工具面在 tools:sdk section 里——
        // assembly 遮罩与 guard 在那条路径上双失效。
        // 缺省也提供（返回 'native'）：真宿主恒有它，缺了插件要记一条退化日志——
        // 桩上故意不提供只会在测试输出里堆无关告警。
        modeFor: () => toolsMode ?? 'native',
      })
      // dsh-base 组合里的会话投影服务：发现集恢复靠它（PTC 下唯一可行的路径）。
      // 契约照 dsh-session-projection：register(definition) 返回 disposer、stateOf(session, key)。
      inner.provide('sessionProjections', {
        register: () => () => {},
        stateOf: () => undefined,
      })
      // systemPrompt 必须提供：ToolSearch 会注册一个静态引导 section。这里的 section()
      // **照抄宿主的 order 校验**——曾经就是少了它，导致"丢了 order"这种回归在 681 个
      // 全绿的用例里活了下来，直到真宿主一跑就炸（插件加载即抛错）。
      inner.provide('systemPrompt', {
        section: (section) => {
          if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
          sections.push(section)
          return () => {}
        },
        getSectionOrder: () => 0,
      })
    },
  })
  await ctx.plugin(McpManagerGateway, {})
  return { ctx, registered, guards, sections, patchPath: patch, dispose: () => rm(root, { recursive: true, force: true }) }
}

// ── 一键「全部延迟」的 Host RPC ────────────────────────────────────────────
const TWO_ENTRY_PATCH = `- insert:
    - id: mcp-alpha
      name: '@deepseek-ai/dsh-mcp-client'
      # keep managed comment
      config:
        transport: stdio
        serverName: alpha
        command: node
        futureConfig: keep-config
    - id: mcp-beta
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: beta
        command: node
`

/** 单条目 patch：serverName 与 MCP_TOOLS 的 `mcp__deferme__*` 名字对齐，
 *  这样 guard 才真的把它当可延迟服务器（名字对不上时 guard 直接放行，测不到东西）。 */
const ONE_DEFERME_PATCH = `- insert:
    - id: mcp-deferme
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: deferme
        command: node
`

test('setDeferAll 一次把本 profile 的所有 MCP 切到延迟，且不丢字段', async () => {
  const mounted = await mountPlugin(
    [
      { serverName: 'alpha', transport: 'stdio', command: 'node' },
      { serverName: 'beta', transport: 'stdio', command: 'node' },
    ],
    { patchBody: TWO_ENTRY_PATCH },
  )
  try {
    const manager = mounted.ctx.get('mcpManager')
    const on = await manager.setDeferAll({ defer: true })
    assert.equal(on.changed, 2, '两个本 profile 条目都要被改')

    const written = await readFile(mounted.patchPath, 'utf8')
    assert.equal((written.match(/defer: true/g) || []).length, 2)
    // 注释、条目 id、非 defer 配置都不能丢（updateEntry 是重建 config 节点的）。
    assert.match(written, /# keep managed comment/)
    assert.match(written, /futureConfig: keep-config/)
    assert.match(written, /id: mcp-alpha/)
    assert.match(written, /id: mcp-beta/)
    assert.match(written, /command: node/)

    // 反向后不留 true 残影。
    const off = await manager.setDeferAll({ defer: false })
    assert.equal(off.changed, 2)
    const back = await readFile(mounted.patchPath, 'utf8')
    assert.doesNotMatch(back, /defer: true/)
    assert.match(back, /futureConfig: keep-config/, '关掉时同样不能丢字段')
  } finally {
    await mounted.dispose()
  }
})

test('setDeferAll 跳过同名冲突的服务器，其余照改', async () => {
  // loader 里 alpha 有两条（serverName 冲突）。这时 `managedLiveEntry` 定位不到唯一活条目，
  // 与 update 的拒绝语义一致——一键全部不能猜一个改。beta 没有冲突，必须照改。
  const mounted = await mountPlugin(
    [
      { serverName: 'alpha', transport: 'stdio', command: 'node' },
      { serverName: 'alpha', transport: 'stdio', command: 'other' },
      { serverName: 'beta', transport: 'stdio', command: 'node' },
    ],
    { patchBody: TWO_ENTRY_PATCH },
  )
  try {
    const manager = mounted.ctx.get('mcpManager')
    const result = await manager.setDeferAll({ defer: true })
    assert.equal(result.changed, 1, '冲突的 alpha 被跳过，只剩 beta 可改')

    const written = await readFile(mounted.patchPath, 'utf8')
    assert.equal((written.match(/defer: true/g) || []).length, 1)
    assert.match(written, /id: mcp-beta/)
    assert.doesNotMatch(written, /id: mcp-alpha\n\s+name: '@deepseek-ai\/dsh-mcp-client'\n\s+config:\n\s+transport: stdio\n\s+serverName: alpha\n\s+command: node\n\s+defer: true/, '冲突条目的 config 不得被改写')
    assert.match(written, /command: node/, 'beta 的配置要留在原处')
  } finally {
    await mounted.dispose()
  }
})

test('setDeferAll 在没有可改条目时返回 0 且不动 patch', async () => {
  const mounted = await mountPlugin([], { patchBody: TWO_ENTRY_PATCH })
  try {
    const manager = mounted.ctx.get('mcpManager')
    const before = await readFile(mounted.patchPath, 'utf8')
    const result = await manager.setDeferAll({ defer: true })
    assert.equal(result.changed, 0)
    assert.equal(await readFile(mounted.patchPath, 'utf8'), before, '无可改条目时不得重写 patch')
  } finally {
    await mounted.dispose()
  }
})

test('装配：插件装载即注册 tool_search 与守卫', async () => {
  const mounted = await mountPlugin([{ serverName: 'deferme', transport: 'stdio', command: 'x', defer: true }])
  try {
    assert.ok(mounted.registered.includes('tool_search'), '装配必须注册 tool_search')
    assert.equal(mounted.guards.length, 1, '装配必须注册一个守卫')
    // 引导 section 必须带有限 order（宿主 section() 的硬校验），且不插值。
    const guidance = mounted.sections.find((section) => section.name === 'tool-search:guidance')
    assert.ok(guidance, '装配必须注册引导 section')
    assert.ok(Number.isFinite(guidance.order), 'order 必须是有限数，否则宿主加载即抛错')
    assert.equal(guidance.interpolate, false)
  } finally {
    await mounted.dispose()
  }
})

test('装配：tool_search 名字被占时换名注册，且指引文案跟着换', async () => {
  // G4：宿主的 NamedEntries.insert 对重名直接抛错，而这是插件构造函数里的同步路径——
  // 不预检就等于"将来某个同名工具会让整个 mcp-manager 装不上"。换了还必须说清楚：
  // 守卫给出的指引里带的名字必须是**真正注册的那个**，否则模型照着提示调用会失败。
  const mounted = await mountPlugin(
    [{ serverName: 'deferme', transport: 'stdio', command: 'x', defer: true }],
    { occupied: ['tool_search'] },
  )
  try {
    assert.equal(mounted.registered.includes('tool_search'), false, '被占用的名字不得再注册')
    assert.ok(mounted.registered.includes('deferred_tool_search'), '必须换成确定性备选名注册')
    const denial = mounted.guards[0]({ name: 'mcp__deferme__tool_1', agent: createAgent() })
    assert.equal(typeof denial, 'string')
    assert.ok(denial.includes('deferred_tool_search'), '守卫指引必须指向真正注册的名字')
  } finally {
    await mounted.dispose()
  }
})

test('装配：setDeferAll 同步内存 entry：运行中的会话立即生效，无需重启进程', async () => {
  // 钉住的不变量：**patch 与内存 entry 一致**。
  // 修复前 setDeferAll 只 writePatch 就返回，内存 entry.options.config.defer 还是旧值，
  // 而 deferServersOf 读的正是那个字段——于是 patch 已是新值、运行中的会话永远读旧值，
  // 表现为"改完设置不生效，必须重启进程"。
  //
  // 这里刻意**不重新装载插件**：重装会让一切看起来正常，而那不是真机上发生的事
  // （用户在面板点一下，进程不重启）。
  const mounted = await mountPlugin(
    [{ serverName: 'deferme', transport: 'stdio', command: 'node', defer: true }],
    { patchBody: ONE_DEFERME_PATCH },
  )
  try {
    const guard = mounted.guards[0]
    const agent = createAgent()
    // 16 个工具 ≥ 阈值 15：延迟生效，未发现的直调被拒。
    assert.equal(typeof guard({ name: 'mcp__deferme__tool_1', agent }), 'string', '初始应拒绝直调')

    const off = await mounted.ctx.get('mcpManager').setDeferAll({ defer: false })
    assert.equal(off.changed, 1)
    // 同一份装配、同一个 agent：必须立刻放行。
    assert.equal(guard({ name: 'mcp__deferme__tool_1', agent }), undefined, '关掉延迟后应立即放行')
    assert.match(await readFile(mounted.patchPath, 'utf8'), /defer: false/, 'patch 也要落到盘上')

    // 反方向同样要立即生效，否则只是"能关不能开"。
    const on = await mounted.ctx.get('mcpManager').setDeferAll({ defer: true })
    assert.equal(on.changed, 1)
    assert.equal(typeof guard({ name: 'mcp__deferme__tool_1', agent }), 'string', '重新开启后应立即拒绝')

    // tool_search 是无条件注册的，两个方向都不该被摘掉。
    assert.ok(mounted.registered.includes('tool_search'))
  } finally {
    await mounted.dispose()
  }
})

test('update(spec) 只翻 defer 时同步内存：同进程立即生效，不重连', async () => {
  // 与 setDeferAll 同一条不变量（patch 与内存一致），但走的是单服务器编辑入口。
  // 修复前 update 只 writePatch 就返回，内存 entry.options.config.defer 还是旧值，
  // 于是"在面板上关掉某个服务器的延迟加载"在运行中的会话里完全不生效。
  const mounted = await mountPlugin(
    [{ serverName: 'deferme', transport: 'stdio', command: 'node', defer: true }],
    { patchBody: ONE_DEFERME_PATCH },
  )
  try {
    const guard = mounted.guards[0]
    const agent = createAgent()
    assert.equal(typeof guard({ name: 'mcp__deferme__tool_1', agent }), 'string', '初始应拒绝直调')

    const off = await mounted.ctx.get('mcpManager').update({ name: 'deferme', transport: 'stdio', command: 'node', defer: false })
    assert.match(off.note, /立即生效/)
    assert.equal(guard({ name: 'mcp__deferme__tool_1', agent }), undefined, '关掉延迟后应立即放行')
    assert.match(await readFile(mounted.patchPath, 'utf8'), /defer: false/)

    const on = await mounted.ctx.get('mcpManager').update({ name: 'deferme', transport: 'stdio', command: 'node', defer: true })
    assert.equal(typeof guard({ name: 'mcp__deferme__tool_1', agent }), 'string', '重新开启后应立即拒绝')
    assert.match(on.note, /立即生效/)
  } finally {
    await mounted.dispose()
  }
})

test('update(spec) 动了连接字段时走 entry.update()，note 说"正在重连"', async () => {
  // 这条守的是**分流**：改 command/args/env 等必须 restart fiber 才会重连，
  // 只同步内存是不够的（那会让新 command 永远不生效）。桩 entry 没有 update 方法，
  // 所以这里只断言"选择了重启路径"——真 loader 上的重连效果由手动探针
  // scripts/probe-live-defer.mjs 覆盖（桩上复现不了 fiber restart）。
  const mounted = await mountPlugin(
    [{ serverName: 'deferme', transport: 'stdio', command: 'node', defer: true }],
    { patchBody: ONE_DEFERME_PATCH },
  )
  try {
    // 给桩 entry 装一个可观测的 update：记录被调用时的 config。
    const entry = [...mounted.ctx.loader.entries()].find((e) => e.options.id === 'mcp-deferme')
    let seen = null
    entry.update = async (options) => { seen = options?.config ?? null }
    const r = await mounted.ctx.get('mcpManager').update({ name: 'deferme', transport: 'stdio', command: 'other-cmd', args: ['--x'] })
    assert.match(r.note, /正在重连/, '改了连接字段必须走重启路径')
    assert.ok(seen, '必须调用 entry.update()')
    assert.equal(seen.command, 'other-cmd', '重启用的 config 要带新 command')
    assert.deepEqual(seen.args, ['--x'])
    assert.equal(seen.serverName, 'deferme', 'config 必须带 serverName（mcp-client 的必需字段）')
    assert.match(await readFile(mounted.patchPath, 'utf8'), /other-cmd/, 'patch 也要落到盘上')
  } finally {
    await mounted.dispose()
  }
})

test('add(spec) 在运行中的进程里创建 loader 条目，并写进 profile patch', async () => {
  // 旧行为只写盘：loader 的 entry 由它自己从 include 子树物化，本插件的写路径不经过
  // loader，于是运行中的进程不会多出 entry、也不会连新服务器（note 只能如实说"重启后生效"）。
  // 现在 writePatch 之后立刻 ctx.loader.create 根部创建。这里守的是**两条都要发生**：
  // patch 里有行、loader 里也有条目（缺任一条都是"看起来成功了其实没生效"）。
  const mounted = await mountPlugin([], { patchBody: ONE_DEFERME_PATCH })
  try {
    const r = await mounted.ctx.get('mcpManager').add({ name: 'fresh', transport: 'stdio', command: 'node' })
    assert.match(r.note, /开始连接/)
    assert.doesNotMatch(r.note, /重启后生效/, 'note 不得再宣称需要重启')
    assert.match(await readFile(mounted.patchPath, 'utf8'), /serverName: fresh/)
    const created = [...mounted.ctx.loader.entries()].filter((entry) => entry.options.config?.serverName === 'fresh')
    assert.equal(created.length, 1, 'add 必须在 loader 里创建条目')
    // 根部创建：不走 include 子树（那条路会把 patch 条目写回 base 配置文件）。
    assert.equal(created[0].options.name, '@deepseek-ai/dsh-mcp-client')
    assert.equal(created[0].options.config.command, 'node')
  } finally {
    await mounted.dispose()
  }
})

test('add(spec) 在 loader.create 失败时回滚 patch，不留半套状态', async () => {
  const mounted = await mountPlugin([], { patchBody: ONE_DEFERME_PATCH })
  try {
    const before = await readFile(mounted.patchPath, 'utf8')
    const original = mounted.ctx.loader.create
    mounted.ctx.loader.create = async () => { throw new Error('loader exploded') }
    await assert.rejects(
      () => mounted.ctx.get('mcpManager').add({ name: 'fresh', transport: 'stdio', command: 'node' }),
      /loader exploded/,
    )
    mounted.ctx.loader.create = original
    assert.equal(await readFile(mounted.patchPath, 'utf8'), before, 'create 失败必须把 patch 写回原样')
    assert.equal(
      [...mounted.ctx.loader.entries()].some((entry) => entry.options.config?.serverName === 'fresh'),
      false,
      'create 失败后 loader 里不得留下条目',
    )
  } finally {
    await mounted.dispose()
  }
})

test('removeServer 停掉运行中的条目并删掉 patch 行', async () => {
  const mounted = await mountPlugin([{ serverName: 'deferme', transport: 'stdio', command: 'node' }], { patchBody: ONE_DEFERME_PATCH })
  try {
    const r = await mounted.ctx.get('mcpManager').removeServer('deferme')
    assert.match(r.note, /停止运行中的连接/)
    assert.equal(
      [...mounted.ctx.loader.entries()].some((entry) => entry.options.id === 'mcp-deferme'),
      false,
      'removeServer 必须真的移除 loader 条目',
    )
    assert.doesNotMatch(await readFile(mounted.patchPath, 'utf8'), /serverName: deferme/)
  } finally {
    await mounted.dispose()
  }
})

test('installBuiltins 追加的条目也进 loader，不只写盘', async () => {
  const mounted = await mountPlugin([], { patchBody: '[]\n' })
  try {
    const r = await mounted.ctx.get('mcpManager').installBuiltins({ ids: ['firecrawl'] })
    assert.deepEqual(r.added, ['firecrawl'])
    assert.match(r.note, /开始连接/)
    const created = [...mounted.ctx.loader.entries()].filter((entry) => entry.options.config?.serverName === 'firecrawl')
    assert.equal(created.length, 1, 'installBuiltins 必须在 loader 里创建条目')
    assert.equal(created[0].options.id, 'mcp-firecrawl', '条目 id 必须与 patch 行一致（resolveManagedEntry 靠它认人）')
    assert.match(await readFile(mounted.patchPath, 'utf8'), /serverName: firecrawl/)
  } finally {
    await mounted.dispose()
  }
})

test('装配：defer 配置从 loader 条目流入守卫行为', async () => {
  const mounted = await mountPlugin([{ serverName: 'deferme', transport: 'stdio', command: 'x', defer: true }])
  try {
    const guard = mounted.guards[0]
    const agent = createAgent()
    // 16 个工具 ≥ 阈值 15：延迟生效，未发现的直调被拒并附指引。
    const denial = guard({ name: 'mcp__deferme__tool_1', agent })
    assert.equal(typeof denial, 'string')
    assert.ok(denial.includes('tool_search'))
    // 未列入 defer 的服务器工具不受影响。
    assert.equal(guard({ name: 'mcp__other__tool_1', agent }), undefined)
  } finally {
    await mounted.dispose()
  }
})

test('装配：DSH_MCP_TOOL_SEARCH=off 总开关整体短路', async () => {
  const previous = process.env.DSH_MCP_TOOL_SEARCH
  try {
    process.env.DSH_MCP_TOOL_SEARCH = 'off'
    const mounted = await mountPlugin([{ serverName: 'deferme', transport: 'stdio', command: 'x', defer: true }])
    try {
      const guard = mounted.guards[0]
      const agent = createAgent()
      // 总开关置关：配置桥返回空 defer 集，守卫对任何工具都不置词。
      assert.equal(guard({ name: 'mcp__deferme__tool_1', agent }), undefined)
    } finally {
      await mounted.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_MCP_TOOL_SEARCH
    else process.env.DSH_MCP_TOOL_SEARCH = previous
  }
})

test('装配：没有 defer 条目时守卫不置词（零干预）', async () => {
  const mounted = await mountPlugin([{ serverName: 'plain', transport: 'stdio', command: 'x' }])
  try {
    const guard = mounted.guards[0]
    const agent = createAgent()
    assert.equal(guard({ name: 'mcp__deferme__tool_1', agent }), undefined)
  } finally {
    await mounted.dispose()
  }
})

test('装配：PTC 模式下**也**启用 ToolSearch（判据是 per-agent 的，不是进程级的）', async () => {
  // 这条旧断言钉的是「PTC 下不装」（F12）。第十轮改了：装配点只知道**部署默认层**的模式，
  // 而模式是 per-agent 的（preset 的 presentAs 可以覆盖）。PTC 下 `assembly.tools` 遮罩
  // 确实是 no-op，但目录段 / 引导段 / 守卫 / 手册裁剪在 PTC 下**反而**是唯一有效的那部分：
  // 手册是模型唯一的工具索引（F1）。
  const mounted = await mountPlugin([{ serverName: 'deferme', transport: 'stdio', command: 'x', defer: true }], { toolsMode: 'ptc' })
  try {
    assert.ok(mounted.registered.includes('tool_search'), 'PTC 下必须注册 tool_search')
    assert.equal(mounted.guards.length, 1, 'PTC 下必须注册守卫')
    // 守卫按 per-agent 模式取值：PTC agent 的未发现直调被拒（嵌套派发实测走完整管线，F7）。
    const denial = mounted.guards[0]({ name: 'mcp__deferme__tool_1', agent: createAgent() })
    assert.equal(typeof denial, 'string')
    assert.ok(denial.includes('tool_search'))
  } finally {
    await mounted.dispose()
  }
})

test('装配：both 模式 inert——注册但一笔不动（唯一 inert 的取值）', async () => {
  // B4/§11.4：`both` 下两条投影都有效，插件不介入。守卫必须放行（managed 被换成空视图），
  // 这正是"inert"与"半失效"的分界：**不是因为判不出而放行**，是因为这个模式选择不介入。
  const mounted = await mountPlugin([{ serverName: 'deferme', transport: 'stdio', command: 'x', defer: true }], { toolsMode: 'both' })
  try {
    assert.ok(mounted.registered.includes('tool_search'), '注册是无条件的（tool_search 可直调并给出明确说明）')
    assert.equal(mounted.guards.length, 1)
    assert.equal(mounted.guards[0]({ name: 'mcp__deferme__tool_1', agent: createAgent() }), undefined, 'both 下守卫必须放行')
  } finally {
    await mounted.dispose()
  }
})

test('徽标：延迟行只标记状态，不带 token 估算', async () => {
  // 曾经这里断言"行投影带估算 token、客户端用它渲染"。估算整套撤掉了，理由：
  // 我们不知道用户装了什么 MCP，schema 大小差一个量级，任何估算都给不出可用的数，
  // 而给了数用户就拿它做决定（"7.4K 好像不多，不用延迟"）——主动误导。
  // 现在钉的是反面：徽标与详情行**不得**再出现 token 估算。
  //
  // 1.8.1 起这颗徽标同时是**行内开关**（两种状态都渲染、都可点）：所以源码形状从
  // "开着才 `? h(Badge, {cls:'t-defer'})`" 改成"渲染 DeferChip，状态由 s.defer 决定"。
  // 两条都钉：接线（状态从哪来）与样式（开着时哪个 class）。
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /h\(DeferChip, \{ on: s\.defer === true, interactive: s\.managed === true && !busy/, '延迟行必须渲染状态芯片，且只有本插件管理的条目可点')
  assert.match(client, /className: 'dsh-mcp-badge as-btn' \+ \(on \? ' t-defer' : ''\)/, '芯片开着时必须带 t-defer（虚线 accent）')
  // 芯片点下去**不能顺带选中那一行**（行本身是 role=button，冒泡会让"点开关"变成"选中"）。
  assert.match(client, /onClick: \(e\) => \{ e\.stopPropagation\(\); onClick\(\); \}/, '芯片必须 stopPropagation')
  // 行内开关的写路径：单台 RPC，项目作用域带 wsPath（两个项目可能同名）。
  assert.match(client, /const toggleDeferOne = \(s\) => \{[\s\S]{0,900}?'setDefer'/, '行内开关必须走单台 RPC setDefer')
  assert.match(client, /s\.scope === 'workspace' \? \{ name: s\.serverName, wsPath: scope, defer: next \} : \{ name: s\.serverName, defer: next \}/, '项目行必须带 wsPath')
  // 两个作用域的列表都要把动作传下去（少一个，那个作用域就退回"只能进编辑框"）。
  assert.equal((client.match(/onToggleDefer: toggleDeferOne/g) || []).length, 2, '全局与项目两个列表都要接上行内开关')
  assert.doesNotMatch(client, /toolEstTokens/, '行上不得再有估算 token（精确感是假的）')
  assert.doesNotMatch(client, /fmtTokens/, '不得再有 token 紧凑格式化')
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(host, /toolEstTokens/, '行投影不得再算估算 token（全局与项目两路都不算）')
  // 开启前预告仍要在，但只带真实数据（工具数）——门槛已经不存在了。
  assert.match(client, /initial\.toolCount !== undefined/, '编辑表单必须带开启前预告')
})

test('「全部延迟」按钮在列表第一屏，不在底栏', async () => {
  // 用户原话：「功能的按钮在最下面还那么小，我都没注意到，差点以为没有呢」。
  // **位置与唯一性由 test/detail-panes.test.mjs 用真实渲染断言**（源码正则抓不住
  // "prop 还在但渲染处被挪回底栏"这种退化）。这里只留两条源码级的不变量：
  // 两个作用域都传这个动作，以及底栏不再承载它。
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal((client.match(/toolbarAction: deferAllAction/g) || []).length, 2, '全局与项目两个作用域都要把动作传给列表的过滤器行')
  // 底栏不得再放第二份：同一个概念两个渲染处，用户会在滚出视野时以为功能没了。
  assert.doesNotMatch(client, /action: \{\s*label: deferAll\.all/, 'ListFooter 不得再承载这个动作')
  // 估算 token 整套撤掉（徽标只标状态）。理由见 lib/index.js 的注释。
  assert.doesNotMatch(client, /toolEstTokens/, '行上不得再有估算 token')
  assert.doesNotMatch(client, /fmtTokens/, '不得再有 token 紧凑格式化')
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(host, /toolEstTokens/, '行投影不得再算估算 token（全局与项目两路都不算）')
  // 估算器已整套删除，这条守的是"不许再加回来"。⚠️ 正则必须是**真名**
  // `estimateSchemaTokens`（单数）：曾经这里写成 `/estimateSchemasTokens/`（Schemas 复数），
  // 与真实函数名差一个 s，于是即使有人用真名把估算器加回来，这条断言也永远绿——
  // 生来就是空的守卫比没有守卫更坏（它给人"守住了"的错觉）。
  assert.doesNotMatch(host, /estimateSchemaTokens/, 'host 不得再导入估算器')
})

test('setDeferAll 不传 wsPath 时走全局分支（空串不得被解析成 cwd）', async () => {
  // Windows 上 realpathSync('') 返回 **cwd** 而不抛错。若用
  // `canonicalWorkspacePath(String(payload?.wsPath || ''))` 判真假，"没传 wsPath"会被
  // 解析成当前目录、误走项目分支，然后在没有 workspaceRegistry 的宿主上直接抛错。
  const mounted = await mountPlugin(
    [
      { serverName: 'alpha', transport: 'stdio', command: 'node' },
      { serverName: 'beta', transport: 'stdio', command: 'node' },
    ],
    { patchBody: TWO_ENTRY_PATCH },
  )
  try {
    const manager = mounted.ctx.get('mcpManager')
    const result = await manager.setDeferAll({ defer: true })
    assert.equal(result.changed, 2, '必须走全局分支，改 patch 里的两个条目')
    assert.match(await readFile(mounted.patchPath, 'utf8'), /defer: true/)
    // 空串与空白同样算"没传"。
    assert.equal((await manager.setDeferAll({ defer: true, wsPath: '' })).changed, 2)
    assert.equal((await manager.setDeferAll({ defer: true, wsPath: '   ' })).changed, 2)
  } finally {
    await mounted.dispose()
  }
})
