import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

async function createHostFixture(patchContent = '[]\n', registryWorkspaces = [], extraEntries = [], extraWorkspaceNames = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-ws-'))
  const rootConfig = join(root, 'cordis.yml')
  const patchPath = join(root, 'cordis.patch.yml')
  await writeFile(rootConfig, '[]\n')
  await writeFile(patchPath, patchContent)
  const wsRoot = join(root, 'proj-a')
  await mkdir(wsRoot, { recursive: true })
  // 跨工作区复制要两个以上工作区：按名字建目录并一起进注册表，避免每个用例各搭一套 ctx。
  const extraWorkspaces = {}
  for (const name of extraWorkspaceNames) {
    const path = join(root, name)
    await mkdir(path, { recursive: true })
    extraWorkspaces[name] = path
  }
  const entries = [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } } }, ...extraEntries]
  // entry.parent.remove(id) 是 loader 里"停掉并移除一个条目"的原语，removeServer 走它
  // （不走 ctx.loader.remove——那条对 include 子树条目是静默 no-op，见 lib/index.js 的注释）。
  const group = {
    remove: async (id) => {
      const index = entries.findIndex((entry) => entry.options.id === id)
      if (index >= 0) entries.splice(index, 1)
    },
  }
  for (const entry of entries) entry.parent = group
  const registry = {
    list: () => [
      ...registryWorkspaces.map((ws) => ({ ...ws, path: ws.path || wsRoot })),
      ...extraWorkspaceNames.map((name) => ({ path: extraWorkspaces[name], title: name })),
    ],
  }
  const ctx = {
    // create/remove 是 add / removeServer / installBuiltins 在运行中的进程里增删 loader
    // 条目的入口（旧行为只写盘）。桩上做同一份 entries 数组上的增删——稳定引用、可观测，
    // 与 entries() 同一个真相源；真正的连接效果由 test/real-host-loader.test.mjs 覆盖。
    loader: {
      entries: () => entries,
      create: async (options) => {
        const entry = { options: { ...options }, parent: group, update: async (next) => { Object.assign(entry.options, next ?? {}) } }
        entries.push(entry)
        return options.id
      },
      remove: async (id) => group.remove(id),
    },
    tools: { schemas: () => [] },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
  return {
    root,
    wsRoot,
    patchPath,
    ctx,
    extraWorkspaces,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

const configPath = (wsRoot) => join(wsRoot, '.dsh', 'mcp.json')

test('listWorkspaces enumerates registered workspaces with server counts', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { demo: { command: 'node' } }, exclude: ['github'] }))
    const result = await McpManagerGateway.prototype.listWorkspaces.call({ ctx: fixture.ctx })
    assert.equal(result.workspaces.length, 1)
    assert.equal(result.workspaces[0].name, 'proj-a')
    assert.equal(result.workspaces[0].serverCount, 1)
    assert.deepEqual(result.workspaces[0].excluded, ['github'])
    assert.equal(result.workspaces[0].error, '')
    assert.ok(result.revision)
  } finally {
    await fixture.cleanup()
  }
})

test('addWorkspaceServer writes the project file and rejects duplicates and global collisions', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    const added = await McpManagerGateway.prototype.addWorkspaceServer.call(gateway, {
      wsPath: fixture.wsRoot,
      spec: { name: 'demo', transport: 'stdio', command: 'node', env: { KEY: '${KEY}' } },
    })
    assert.match(added.note, /demo/)
    const parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(parsed, {
      mcpServers: { demo: { command: 'node', env: { KEY: '${KEY}' } } },
    })

    await assert.rejects(
      McpManagerGateway.prototype.addWorkspaceServer.call(gateway, {
        wsPath: fixture.wsRoot,
        spec: { name: 'demo', transport: 'stdio', command: 'node' },
      }),
      /该项目已存在/,
    )

    // 全局已有同名 → 项目层允许：DSH 0.1.5 起 mcp-client 按注册作用域判 serverName 唯一性，
    // 本项目是独立作用域，跨作用域同名是合法配置（实测：同一作用域内仍会被拒绝）。
    const globalFixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
    try {
      await McpManagerGateway.prototype.add.call({ ctx: globalFixture.ctx }, { name: 'global-x', transport: 'stdio', command: 'node' })
      const crossScope = await McpManagerGateway.prototype.addWorkspaceServer.call({ ctx: globalFixture.ctx }, {
        wsPath: globalFixture.wsRoot,
        spec: { name: 'global-x', transport: 'stdio', command: 'node' },
      })
      assert.match(crossScope.note, /global-x/)
      const written = JSON.parse(await readFile(configPath(globalFixture.wsRoot), 'utf8'))
      assert.ok(written.mcpServers['global-x'], '项目层与全局同名必须能落盘，不再被当作冲突拦截')
    } finally {
      await globalFixture.cleanup()
    }
  } finally {
    await fixture.cleanup()
  }
})

test('getWorkspaceView returns project servers plus global servers with excluded marks', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const githubEntry = {
    options: { id: 'mcp-github', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'github', transport: 'streamable-http', url: 'https://api.github.com/mcp' } },
    disabled: false,
    fiber: null,
  }
  const exaEntry = {
    options: { id: 'mcp-exa', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'exa', transport: 'streamable-http', url: 'https://mcp.exa.ai/mcp' } },
    disabled: false,
    fiber: null,
  }
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [githubEntry, exaEntry])
  try {
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({
      mcpServers: { db: { command: 'psql', env: { SECRET: 'plaintext' } } },
      exclude: ['github'],
    }))

    const view = await McpManagerGateway.prototype.getWorkspaceView.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot })
    assert.equal(view.error, '')
    assert.deepEqual(view.mountErrors, [])
    assert.equal(view.servers.length, 1)
    assert.equal(view.servers[0].serverName, 'db')
    assert.equal(view.servers[0].scope, 'workspace')
    assert.equal(view.servers[0].env.SECRET, '__DSH_MCP_REDACTED__')
    assert.deepEqual(view.exclude, ['github'])
    const globalNames = view.global.map((server) => server.serverName)
    assert.deepEqual(globalNames, ['github', 'exa'])
    assert.equal(view.global.find((server) => server.serverName === 'github').excluded, true)
    assert.equal(view.global.find((server) => server.serverName === 'exa').excluded, false)
  } finally {
    await fixture.cleanup()
  }
})

test('setWorkspaceExclude toggles exclude and roundtrips', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { db: { command: 'psql' } } }))
    await McpManagerGateway.prototype.setWorkspaceExclude.call(gateway, { wsPath: fixture.wsRoot, serverName: 'github', hidden: true })
    let parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(parsed.exclude, ['github'])
    await McpManagerGateway.prototype.setWorkspaceExclude.call(gateway, { wsPath: fixture.wsRoot, serverName: 'exa', hidden: true })
    parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(parsed.exclude, ['github', 'exa'])
    await McpManagerGateway.prototype.setWorkspaceExclude.call(gateway, { wsPath: fixture.wsRoot, serverName: 'github', hidden: false })
    parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(parsed.exclude, ['exa'])
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent workspace writes are serialized without losing updates', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    // 两个并发添加基于同一份旧配置读改写：无串行化时后写者覆盖先写者，丢一条更新。
    await Promise.all([
      McpManagerGateway.prototype.addWorkspaceServer.call(gateway, { wsPath: fixture.wsRoot, spec: { name: 'alpha', transport: 'stdio', command: 'node' } }),
      McpManagerGateway.prototype.addWorkspaceServer.call(gateway, { wsPath: fixture.wsRoot, spec: { name: 'beta', transport: 'stdio', command: 'node' } }),
    ])
    const parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['alpha', 'beta'])
  } finally {
    await fixture.cleanup()
  }
})

test('workspace view keeps file templates while reveal returns the live value', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({
      mcpServers: { hl: { command: 'npx', args: ['${DSH_MCP_REVEAL_PROBE}'], env: { KEY: '${DSH_MCP_REVEAL_PROBE}' } } },
    }))
    const view = await McpManagerGateway.prototype.getWorkspaceView.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot })
    assert.equal(view.servers[0].command, 'npx')
    // 列表与详情的默认显示一律掩码：明文与 `!!js` 引用一视同仁，key 名保留作信息。
    // 旧实现把环境变量引用原样保留，结果是内部 `!!js` 表达式会直接出现在界面上。
    assert.equal(view.servers[0].env.KEY, '__DSH_MCP_REDACTED__')
    assert.deepEqual(view.servers[0].args, ['__DSH_MCP_REDACTED__'])

    // 眼睛点开的是 reveal：要「有效运行值」。变量未设置时如实为空，而不是把模板
    // ${DSH_MCP_REVEAL_PROBE} 当值返回（那会让人以为看到的就是密钥）。
    delete process.env.DSH_MCP_REVEAL_PROBE
    const unset = await McpManagerGateway.prototype.revealWorkspaceServer.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot, name: 'hl', field: 'args' })
    assert.deepEqual(unset.value, [''])

    process.env.DSH_MCP_REVEAL_PROBE = 'live-token-42'
    const liveOne = await McpManagerGateway.prototype.revealWorkspaceServer.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot, name: 'hl', field: 'env', key: 'KEY' })
    assert.equal(liveOne.value, 'live-token-42')
    const liveList = await McpManagerGateway.prototype.revealWorkspaceServer.call({ ctx: fixture.ctx }, { wsPath: fixture.wsRoot, name: 'hl', field: 'args' })
    assert.deepEqual(liveList.value, ['live-token-42'])
  } finally {
    delete process.env.DSH_MCP_REVEAL_PROBE
    await fixture.cleanup()
  }
})

test('updateWorkspaceServer and removeWorkspaceServer mutate the project file', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { db: { command: 'psql' } } }))
    await McpManagerGateway.prototype.updateWorkspaceServer.call(gateway, {
      wsPath: fixture.wsRoot,
      spec: { name: 'db', transport: 'stdio', command: 'psql', args: ['-U', 'admin'] },
    })
    let parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(parsed.mcpServers.db, { command: 'psql', args: ['-U', 'admin'] })
    await McpManagerGateway.prototype.removeWorkspaceServer.call(gateway, { wsPath: fixture.wsRoot, name: 'db' })
    parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(parsed.mcpServers, {})
    await assert.rejects(
      McpManagerGateway.prototype.removeWorkspaceServer.call(gateway, { wsPath: fixture.wsRoot, name: 'db' }),
      /该项目中没有此 MCP/,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('setDeferAll 在项目作用域改 .dsh/mcp.json，不动 profile patch', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({
      mcpServers: { db: { command: 'psql' }, web: { type: 'http', url: 'https://x.test/mcp' } },
      exclude: ['db'],
    }, null, 2))

    const on = await McpManagerGateway.prototype.setDeferAll.call(gateway, { wsPath: fixture.wsRoot, defer: true })
    assert.equal(on.changed, 2)
    const parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.equal(parsed.mcpServers.db.defer, true)
    assert.equal(parsed.mcpServers.web.defer, true)
    // 原有字段与 exclude 都不能丢。
    assert.equal(parsed.mcpServers.db.command, 'psql')
    assert.equal(parsed.mcpServers.web.url, 'https://x.test/mcp')
    assert.deepEqual(parsed.exclude, ['db'])

    // 反向不留残影。
    await McpManagerGateway.prototype.setDeferAll.call(gateway, { wsPath: fixture.wsRoot, defer: false })
    const back = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.equal(back.mcpServers.db.defer, false)
    assert.equal(back.mcpServers.web.defer, false)
    assert.deepEqual(back.exclude, ['db'])
    assert.equal(back.mcpServers.db.command, 'psql', '关掉时同样不能丢字段')

    // profile patch 完全没被碰（全局与项目两条写路径必须分开）。
    assert.match(await readFile(fixture.patchPath, 'utf8'), /^\[\]/)
  } finally {
    await fixture.cleanup()
  }
})

test('setDeferAll 在项目没有 MCP 时返回 0 且不写文件', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: {}, exclude: [] }, null, 2))
    const before = await readFile(configPath(fixture.wsRoot), 'utf8')
    const result = await McpManagerGateway.prototype.setDeferAll.call(gateway, { wsPath: fixture.wsRoot, defer: true })
    assert.equal(result.changed, 0)
    assert.equal(await readFile(configPath(fixture.wsRoot), 'utf8'), before, '空项目不得重写文件')
  } finally {
    await fixture.cleanup()
  }
})

test('revealWorkspaceServer returns real values from the project file', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { db: { command: 'psql', env: { SECRET: 'topsecret' } } } }))
    const revealed = await McpManagerGateway.prototype.revealWorkspaceServer.call(gateway, { wsPath: fixture.wsRoot, name: 'db', field: 'env', key: 'SECRET' })
    assert.equal(revealed.value, 'topsecret')
    await assert.rejects(
      McpManagerGateway.prototype.revealWorkspaceServer.call(gateway, { wsPath: fixture.wsRoot, name: 'nope', field: 'env', key: 'SECRET' }),
      /该项目中没有此 MCP/,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('installWorkspaceBuiltins appends only missing builtins', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }])
  try {
    const gateway = { ctx: fixture.ctx }
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' } } }))
    const result = await McpManagerGateway.prototype.installWorkspaceBuiltins.call(gateway, { wsPath: fixture.wsRoot, ids: ['exa', 'tavily'] })
    assert.match(result.note, /tavily/)
    assert.match(result.note, /exa/)
    const parsed = JSON.parse(await readFile(configPath(fixture.wsRoot), 'utf8'))
    assert.deepEqual(Object.keys(parsed.mcpServers), ['exa', 'tavily'])
  } finally {
    await fixture.cleanup()
  }
})

test('copyWorkspaceServers adds entries to another workspace and keeps same names by default', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({
      mcpServers: {
        alpha: { command: 'node', args: ['-y', 'alpha-mcp'], env: { TOKEN: '${TOKEN}' } },
        beta: { type: 'http', url: 'https://example.com/mcp' },
      },
      exclude: ['github'],
    }))
    await mkdir(join(target, '.dsh'), { recursive: true })
    await writeFile(configPath(target), JSON.stringify({ mcpServers: { beta: { command: 'other' } }, exclude: ['exa'] }))

    const result = await McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target })
    assert.deepEqual(result.added, ['alpha'])
    assert.deepEqual(result.updated, [])
    // 默认同名跳过：目标已有的 beta 原样保留，且必须被说出来，否则用户以为搬过去了。
    assert.deepEqual(result.skipped, ['beta'])
    assert.match(result.note, /beta/)
    const parsed = JSON.parse(await readFile(configPath(target), 'utf8'))
    // `${VAR}` 引用原样过关：复制不解析环境变量，也不会把明文写进目标文件。
    assert.deepEqual(parsed.mcpServers.alpha, { command: 'node', args: ['-y', 'alpha-mcp'], env: { TOKEN: '${TOKEN}' } })
    assert.deepEqual(parsed.mcpServers.beta, { command: 'other' })
    // 屏蔽清单是目标工作区自己的意图，不跟着配置一起搬。
    assert.deepEqual(parsed.exclude, ['exa'])
  } finally {
    await fixture.cleanup()
  }
})

test('copyWorkspaceServers overwrites same names only when asked, and honours the selection', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({
      mcpServers: { alpha: { command: 'node' }, beta: { type: 'http', url: 'https://example.com/mcp' } },
    }))
    await mkdir(join(target, '.dsh'), { recursive: true })
    await writeFile(configPath(target), JSON.stringify({ mcpServers: { beta: { command: 'other' } } }))

    const partial = await McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, {
      from: fixture.wsRoot,
      to: target,
      names: ['beta'],
      overwrite: true,
    })
    assert.deepEqual(partial.updated, ['beta'])
    assert.deepEqual(partial.added, [])
    const parsed = JSON.parse(await readFile(configPath(target), 'utf8'))
    assert.deepEqual(parsed.mcpServers.beta, { type: 'http', url: 'https://example.com/mcp' })
    assert.equal(parsed.mcpServers.alpha, undefined, '没选中的条目不该被带过去')
  } finally {
    await fixture.cleanup()
  }
})

test('copyWorkspaceServers refuses unregistered targets, self copies and unknown names', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }))

    // 写路径比读路径严：目标必须是这台机器上注册过的工作区，否则这就是「往任意目录写文件」。
    // 目录真实存在（下面 mkdir）："注册过"与"目录存在"必须能区分，否则存在性检查也能糊过这条。
    const notRegistered = join(fixture.root, 'not-registered')
    await mkdir(notRegistered, { recursive: true })
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: notRegistered }),
      /不在已注册的工作区列表/,
    )
    // copy 这条腿是被写门（withRegisteredWorkspaceWrite）拦下的；**预览没有写动作**，它的目标校验
    // 只存在于 resolveWorkspaceCopy 里，所以必须单独钉一次——否则把那行校验删掉，全仓测试不会红，
    // 而 resolveWorkspaceCopy 的注释恰恰声称"用户正是在预览里该知道这个目标不能写"。
    await assert.rejects(
      McpManagerGateway.prototype.previewWorkspaceCopy.call(gateway, { from: fixture.wsRoot, to: notRegistered }),
      /不在已注册的工作区列表/,
    )
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: fixture.wsRoot }),
      /同一个工作区/,
    )
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target, names: ['ghost'] }),
      /源工作区中没有这些 MCP/,
    )
    // 被拒的调用不该留下半个文件。
    await assert.rejects(readFile(configPath(target), 'utf8'), /ENOENT/)
  } finally {
    await fixture.cleanup()
  }
})

test('copyWorkspaceServers leaves the target file untouched when everything is skipped', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }))
    await mkdir(join(target, '.dsh'), { recursive: true })
    await writeFile(configPath(target), JSON.stringify({ mcpServers: { alpha: { command: 'other' } } }))
    // 哨兵时间戳：把 mtime 先钉到 2001 年再断言它没变。直接比"写入前后的 now"在 1s/2s 粒度的
    // 文件系统（HFS+、exFAT/FAT32、部分网络目录）上会静默变成永真，与分辨率无关的哨兵才不会。
    await utimes(configPath(target), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
    const before = await stat(configPath(target))

    const result = await McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target })
    assert.deepEqual(result.skipped, ['alpha'])
    assert.deepEqual(result.added, [])
    assert.equal(result.changed, false)
    // 只比文件内容不够：内容一样也可能是"原样重写了一遍"。这条捷径的意义正是不碰文件
    // （不刷新 mtime → 配置缓存不失效、不白跑一次连接对齐），所以直接钉时间戳。
    assert.equal((await stat(configPath(target))).mtimeMs, before.mtimeMs)
    // 内容也得一字不动（不能借"跳过"顺手规范化目标文件）。
    assert.deepEqual(JSON.parse(await readFile(configPath(target), 'utf8')), { mcpServers: { alpha: { command: 'other' } } })
    // 正控：同一环境下真写一次必须让哨兵前移。少了它，上面那两条断言在粗粒度文件系统上会
    // 静默失效而没人知道。
    const rewritten = await McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target, overwrite: true })
    assert.deepEqual(rewritten.updated, ['alpha'])
    assert.notEqual((await stat(configPath(target))).mtimeMs, before.mtimeMs, '覆盖模式必须真的落盘')
  } finally {
    await fixture.cleanup()
  }
})

test('copyWorkspaceServers rejects an empty selection and a malformed names payload', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b', 'proj-c'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }))

    // 「这次一条都没勾」与「源里本来就没有」是两件事：报同一句话会把用户指向错误的方向
    //（源项目里明明有 MCP，却被告知"源工作区没有可复制的 MCP"）。
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target, names: [] }),
      /没有选中任何要复制的 MCP/,
    )
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.extraWorkspaces['proj-c'], to: target }),
      /源工作区没有可复制的 MCP/,
    )
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target, names: 'alpha' }),
      /必须是字符串数组/,
    )
    // 元素类型也要钉：只留 Array.isArray 而丢掉 every(typeof === 'string') 时，上面那条仍会通过。
    await assert.rejects(
      McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target, names: ['alpha', 42] }),
      /必须是字符串数组/,
    )
    // 空选择不该顺手把目标配置建出来。
    await assert.rejects(readFile(configPath(target), 'utf8'), /ENOENT/)
  } finally {
    await fixture.cleanup()
  }
})

test('a server named __proto__ is really written instead of vanishing into the prototype', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    // serverName 允许这个形状（SERVER_NAME_PATTERN = [A-Za-z0-9_-]{1,32}），而普通对象赋值
    // 会走原型 setter：写盘的人以为成功，文件里根本没有这条。计算键写出来的是 own property，
    // 所以这里模拟的是"用户配置里真有这么一条"。
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { ['__proto__']: { command: 'node' } } }))

    const exported = await McpManagerGateway.prototype.exportWorkspaceJson.call(gateway, { wsPath: fixture.wsRoot })
    assert.equal(exported.count, 1, '读侧要认出这条（Object.entries 必须能看到 own property）')

    const result = await McpManagerGateway.prototype.copyWorkspaceServers.call(gateway, { from: fixture.wsRoot, to: target })
    assert.deepEqual(result.added, ['__proto__'])
    const written = JSON.parse(await readFile(configPath(target), 'utf8'))
    assert.ok(
      Object.prototype.hasOwnProperty.call(written.mcpServers, '__proto__'),
      '写盘结果必须真的含这条——否则就是"报成功但没写"',
    )
    assert.deepEqual(Object.getOwnPropertyDescriptor(written.mcpServers, '__proto__').value, { command: 'node' })
  } finally {
    await fixture.cleanup()
  }
})

test('previewWorkspaceCopy reports the plan without writing anything', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b', 'proj-c'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({ mcpServers: { alpha: { command: 'node' }, beta: { command: 'node' } } }))
    await mkdir(join(target, '.dsh'), { recursive: true })
    await writeFile(configPath(target), JSON.stringify({ mcpServers: { beta: { command: 'other' } } }))
    await utimes(configPath(target), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
    const before = await stat(configPath(target))

    const preview = await McpManagerGateway.prototype.previewWorkspaceCopy.call(gateway, { from: fixture.wsRoot, to: target })
    assert.deepEqual(preview.added, ['alpha'])
    assert.deepEqual(preview.skipped, ['beta'])
    assert.deepEqual(preview.updated, [])
    assert.equal(preview.targetCount, 1)
    assert.equal(preview.changed, true)

    // 策略跟着参数走：同一个目标，选了覆盖就只有 updated、没有 skipped。
    const overwriting = await McpManagerGateway.prototype.previewWorkspaceCopy.call(gateway, { from: fixture.wsRoot, to: target, overwrite: true })
    assert.deepEqual(overwriting.updated, ['beta'])
    assert.deepEqual(overwriting.skipped, [])

    // 预览是纯读：目标文件一个字节都不该变（写盘那次会在锁内重新解析）。
    assert.equal((await stat(configPath(target))).mtimeMs, before.mtimeMs)
    assert.deepEqual(JSON.parse(await readFile(configPath(target), 'utf8')), { mcpServers: { beta: { command: 'other' } } })
    // 目标还没有 .dsh/ 时也不能被"读"出目录和文件来：纯读包括不产生副作用。
    const virgin = fixture.extraWorkspaces['proj-c']
    await McpManagerGateway.prototype.previewWorkspaceCopy.call(gateway, { from: fixture.wsRoot, to: virgin })
    await assert.rejects(readFile(configPath(virgin), 'utf8'), /ENOENT/)
  } finally {
    await fixture.cleanup()
  }
})

test('exportWorkspaceJson round-trips through the paste import path', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createHostFixture('[]\n', [{ title: 'proj-a' }], [], ['proj-b'])
  try {
    const gateway = { ctx: fixture.ctx }
    const target = fixture.extraWorkspaces['proj-b']
    await mkdir(join(fixture.wsRoot, '.dsh'), { recursive: true })
    await writeFile(configPath(fixture.wsRoot), JSON.stringify({
      mcpServers: {
        alpha: { command: 'node', args: ['-y', 'alpha-mcp'], env: { TOKEN: '${TOKEN}' }, idleTimeoutMs: 60000, disabled: true },
        beta: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, readyTimeoutMs: 0 },
      },
      exclude: ['github'],
    }))

    const exported = await McpManagerGateway.prototype.exportWorkspaceJson.call(gateway, { wsPath: fixture.wsRoot })
    assert.equal(exported.count, 2)
    assert.deepEqual(exported.excluded, ['github'])
    // 导出的是文件形态（`${VAR}` 模板 + mcpServers），不是内部 `!!js` 表达式；否则这份 JSON
    // 既不能被别的客户端读，也不能当 .dsh/mcp.json 直接放过去。
    assert.ok(!exported.json.includes('!!js'))
    const doc = JSON.parse(exported.json)
    assert.deepEqual(doc.mcpServers.alpha, { command: 'node', args: ['-y', 'alpha-mcp'], env: { TOKEN: '${TOKEN}' }, idleTimeoutMs: 60000, disabled: true })
    assert.deepEqual(doc.exclude, ['github'])
    // 键集合必须单独钉：下面的往返比较是"生产 vs 生产"，某一类条目在导出里整体蒸发时两边会一起少，
    // deepEqual 照样相等，而 count 也来自 config.servers.length，看不出来。
    assert.deepEqual(Object.keys(doc.mcpServers).sort(), ['alpha', 'beta'])
    // http 条目走的是另一个分支（type/url/headers），逐字段钉住，别只靠对称往返自证。
    assert.deepEqual(doc.mcpServers.beta, {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
      readyTimeoutMs: 0,
    })

    // 往返不变量：导出的 mcpServers 经粘贴导入进另一个工作区后再导出，逐字段一致
    //（环境变量引用、插件专有字段都不能在某一趟里被悄悄丢掉）。
    await mkdir(join(target, '.dsh'), { recursive: true })
    await writeFile(configPath(target), JSON.stringify({ mcpServers: {}, exclude: ['exa'] }))
    await McpManagerGateway.prototype.importWorkspaceJson.call(gateway, {
      wsPath: target,
      json: JSON.stringify({ mcpServers: doc.mcpServers }),
      mode: 'merge',
    })
    const roundTripped = await McpManagerGateway.prototype.exportWorkspaceJson.call(gateway, { wsPath: target })
    assert.deepEqual(JSON.parse(roundTripped.json).mcpServers, doc.mcpServers)
    // 粘贴导入只读 mcpServers：exclude 不跟着走（文档与面板都按这条写）。
    assert.deepEqual(JSON.parse(roundTripped.json).exclude, ['exa'])
  } finally {
    await fixture.cleanup()
  }
})