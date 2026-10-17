// 宿主服务 skillsManager（row 7）。
//
// 这是 skills 能力面的宿主入口：一个**独立**的 TypertRemoteService，serviceKey='skillsManager'。
//
// 两条硬约束（SPEC 约束 15/16，都有已验证的失败模式）：
//
// 1. **`skills` 不得进现有 gateway 的 static inject。** Cordis 的 inject 是**依赖声明**：
//    服务缺失时该 fiber 只是保持不激活并等待，**不报错也不激活**（cordis 的 notify() →
//    fiber._refresh()）。宿主的内置插件 dsh-skill 是可被用户禁用的，一旦把 skills 加进现有
//    gateway 的 inject，那些 profile 会连 **MCP 面板一起失效**——不可接受的回归。
//    正解：SkillsManagerGateway 作独立子插件、自带 inject=["skills"]，其未满足只影响技能面。
//
// 2. **不得新增 cordis.patch.yml 条目。** 只有一条 `- id: mcp-manager-ui / name: <包名>`，
//    而 test/package-contract.test.mjs:59-60 断言该 id 与 name **各出现恰好 1 次**。
//    所以第二个服务必须在同一 patch 条目内挂载（`ctx.plugin(...)`，cordis/lib/index.js:1619）。
//
// 3. **管理动作不依赖会话**（SPEC 约束 14）：面板的读取与文件操作都不得要求存在活动会话
//    （官方 ctx.remote.skills.list 需要真实 sessionId，会激活冷 Agent，故本插件走自己的 RPC）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SkillsManagerGateway } from '../lib/index.js'
import { skillRowKey } from '../lib/skills-registry.js'
import { diagnoseSkill } from '../lib/skills-frontmatter.js'

const hostIndex = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('MCP panel still activates on a real cordis Context when skills is absent', async () => {
  // SPEC 约束 16 的**行为级**验收（比断言 inject 数组强得多）：Cordis 的 inject 是依赖声明，
  // 服务缺失时 fiber 只保持不激活并等待、**不报错**，所以「inject 写错了」在静态断言之外
  // 还会表现为「静默失效」。这里用真 cordis Context 装载两个 gateway，在**不提供 skills**
  // 的环境里确认 mcpManager 照常激活——那正是这条约束要保住的东西。
  const { Context } = await import('@deepseek-ai/cordis')
  const { McpManagerGateway } = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-inject-'))
  const patch = join(root, 'cordis.patch.yml')
  await writeFile(patch, '[]\n')
  try {
    const ctx = new Context()
    await ctx.plugin({
      name: 'host-stub',
      apply(inner) {
        inner.provide('loader', {
          entries: () => [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(patch).href } } }],
        })
        // 工具服务的最小可用 mock：schemas 供 toolInventory/workspace 用，register/guard 供
        // ToolSearch 装配用（真实宿主恒提供三者——dsh-tools 服务契约）。
        inner.provide('tools', { schemas: () => [], register: () => () => {}, guard: () => () => {} })
      },
    })
    // 刻意**不**提供 skills：模拟用户禁用了内置插件 dsh-skill。
    await ctx.plugin(McpManagerGateway, {})
    await ctx.plugin(SkillsManagerGateway, {})

    assert.notEqual(ctx.get('mcpManager'), undefined, '缺 skills 时 MCP 面板必须照常可用（否则是静默回归）')
    // 技能侧只是等待依赖，不抛错、也不激活——这正是「只影响技能这一块」。
    assert.equal(ctx.get('skillsManager'), undefined, '依赖未满足时技能服务应保持未激活')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** 造一个只提供 skills 服务的宿主替身。 */
function skillsHost(ctx = {}) {
  return { ...ctx, get: (name) => (name === 'skills' ? ctx.skills : ctx[name]) }
}

test('mounting the plugin exposes the skills service without a second patch entry', async () => {
  // SPEC 约束 15：第二个服务必须在**同一** patch 条目内挂载，即由现有插件自己
  // `ctx.plugin(SkillsManagerGateway)`。上面那条用例是手工 mount 的，**不覆盖**生产路径——
  // 只导出类而没挂载，生产里 skillsManager 就永远不存在（面板「技能服务未连接」）。
  // 这条走真实装载路径：只 mount 默认导出（= McpManagerGateway，与 patch 里那个 name 对应）。
  const { Context } = await import('@deepseek-ai/cordis')
  const pluginDefault = (await import('../lib/index.js')).default
  const root = await mkdtemp(join(tmpdir(), 'dsh-mount-'))
  const patch = join(root, 'cordis.patch.yml')
  await writeFile(patch, '[]\n')
  try {
    const ctx = new Context()
    await ctx.plugin({
      name: 'host-stub',
      apply(inner) {
        inner.provide('loader', {
          entries: () => [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(patch).href } } }],
        })
        inner.provide('tools', { schemas: () => [], register: () => () => {}, guard: () => () => {} })
        inner.provide('skills', {
          async list() { return [] },
          async get() { return undefined },
        })
      },
    })
    // 只装载插件本身——不手工挂任何子服务。
    await ctx.plugin(pluginDefault, {})

    assert.notEqual(ctx.get('mcpManager'), undefined, 'MCP 服务应已激活')
    assert.notEqual(ctx.get('skillsManager'), undefined,
      '装载插件本身就必须带出 skills 服务（由现有插件内部 ctx.plugin 挂载，而不是靠外部再挂一次）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the handover probe never reports the plugin itself as a conflicting manager', async () => {
  // SPEC 约束 10 / D15：本插件自己的 loader `name` 恒等于 package.json.name
  // （cordis.patch.yml 的 `name:` 由 package-rename 钉住），所以自身判据是**包名**。
  //
  // ⚠️ 不能用 patch 的 `id` 排自身：新旧两个包共用 `id: mcp-manager-ui`，
  // 按 id 排会把旧包一起排掉 → 让位检测永不触发（下一条用例就是这个形态）。
  const ctx = {
    loader: {
      entries: () => [
        // 就是本插件自己：name 与 package.json.name 相同。
        { options: { id: 'mcp-manager-ui', name: 'dsh-toolbox-ui' } },
      ],
    },
  }
  const conflict = await SkillsManagerGateway.prototype.conflictingManager.call({ ctx })
  assert.equal(conflict, null,
    '只有自身条目时必须报告「无冲突」，否则面板会静默让位、完全打不开')
})

test('the handover probe sees the OLD package even though it shares our patch id', async () => {
  // 真机形态：新旧两包**同 id**（都是 `mcp-manager-ui`），旧包的 name 是 `dsh-mcp-manager-ui`。
  // 首版按 id 排自身，于是这一条被一起跳过、让位永不触发——而 desktop profile 恰恰装着旧包。
  const ctx = {
    loader: {
      entries: () => [
        { options: { id: 'mcp-manager-ui', name: 'dsh-toolbox-ui' } },
        { options: { id: 'mcp-manager-ui', name: 'dsh-mcp-manager-ui' } },
      ],
    },
  }
  const conflict = await SkillsManagerGateway.prototype.conflictingManager.call({ ctx })
  assert.notEqual(conflict, null, '旧包在场（哪怕与我们同 id）必须报告冲突，否则让位形同不存在')
  assert.equal(conflict.name, 'dsh-mcp-manager-ui')
})

test('the handover probe reports a genuinely different manager plugin', async () => {
  const ctx = {
    loader: {
      entries: () => [
        { options: { id: 'mcp-manager-ui', name: 'dsh-toolbox-ui' } },
        { options: { id: 'some-other-manager', name: 'dsh-mcp-manager-ui-legacy' } },
      ],
    },
  }
  const conflict = await SkillsManagerGateway.prototype.conflictingManager.call({ ctx })
  assert.notEqual(conflict, null, '另一个管理插件在场时必须报告冲突')
  assert.equal(conflict.id, 'some-other-manager')
})

test('the handover probe fails open, so a broken loader never hides the panel', async () => {
  // SPEC 约束 10：检测失败必须 fail-open（照常注册入口）。
  // 漏检最坏是两个按钮并存；误判则用户**完全打不开面板**——两者代价不对称。
  for (const broken of [
    { loader: { entries: () => { throw new Error('loader exploded') } } },
    { loader: undefined },
    { loader: { entries: () => 'not-an-array' } },
    {},
  ]) {
    const conflict = await SkillsManagerGateway.prototype.conflictingManager.call({ ctx: broken })
    assert.equal(conflict, null, '检测失败必须返回「无冲突」（fail-open），而不是抛错')
  }
})

test('the handover probe ignores unrelated loader entries', async () => {
  const ctx = {
    loader: {
      entries: () => [
        { options: { id: 'mcp-manager-ui', name: 'dsh-toolbox-ui' } },
        { options: { id: 'include', name: 'cordis:include' } },
        { options: { id: 'mcp-github', name: '@deepseek-ai/dsh-mcp-client' } },
        { options: { id: 'skills-fs', name: 'skill-filesystem' } },
      ],
    },
  }
  assert.equal(await SkillsManagerGateway.prototype.conflictingManager.call({ ctx }), null,
    '只有无关条目时必须报告无冲突')
})

test('the handover probe requires both mcp and manager in the name', async () => {
  // ⚠️ 这条专治「判据放宽」：把 `mcp && manager` 改成只查 manager（或只查 mcp），
  // 会让下面这些**无关插件**被判成冲突 → 用户面板完全打不开。
  // 一条必须同时含两段的判据，只能用「只含一段的名字」来测——用 `skill-filesystem`
  // 这类两段都不含的名字测不出放宽（那正是首版漏掉这个变异的原因）。
  const unrelated = [
    { id: 'pkg-manager', name: 'some-package-manager' },      // 只有 manager
    { id: 'mcp-client-x', name: '@deepseek-ai/dsh-mcp-client' }, // 只有 mcp
    { id: 'manager-only', name: 'plugin-manager' },
    { id: 'mcp-only', name: 'mcp-tools' },
  ]
  for (const entry of unrelated) {
    // ⚠️ 注意包装：loader 条目是 `{ options: { id, name, … } }`。
    // 首版这里写成 `[..., entry]`（少了 options 一层），于是被测代码读 `entry.options`
    // 得到 undefined、直接 continue ——用例因此**恒真**，判据放宽了也测不出来。
    // 变异测试当场发现：把 `mcp && manager` 改成只查 manager，这条用例照样绿。
    const ctx = {
      loader: {
        entries: () => [
          { options: { id: 'mcp-manager-ui', name: 'dsh-toolbox-ui' } },
          { options: entry },
        ],
      },
    }
    assert.equal(await SkillsManagerGateway.prototype.conflictingManager.call({ ctx }), null,
      `${entry.name} 不含 mcp+manager 两段，不得被判成冲突（否则面板打不开）`)
  }
})

test('the skills gateway registers under its own service key and injects only skills', () => {
  // serviceKey 同时是 Cordis 服务键与默认 wire namespace（dsh-typert-protocol 的
  // TypertRemoteService 构造签名是 (ctx, serviceKey, options?)）。MCP 用 mcpManager，
  // skills 用 skillsManager，两者互不影响。
  assert.equal(typeof SkillsManagerGateway, 'function')
  // 自带 inject=["skills"]：缺 dsh-skill 时只有技能面不激活，MCP 面板不受影响。
  assert.deepEqual(SkillsManagerGateway.inject, ['skills'])
})

test('the existing MCP gateway keeps exactly its original inject list', () => {
  // SPEC 约束 16 的回归闸门：把 skills 加进现有 gateway 的 inject 会让未挂载 dsh-skill 的
  // profile 连 MCP 面板一起失效（服务缺失时 fiber 只等待、不报错，所以是**静默**失效）。
  //
  // ⚠️ 这里必须断言**完整数组相等**，不能用「包含 loader, tools」这类子串判断——
  // 首版就是那么写的，于是 ["loader","tools","skills"] 依然匹配（子串仍成立），
  // 变异测试当场证明它抓不到。多一个元素就是回归，必须精确比较。
  const lists = [...hostIndex.matchAll(/static inject = \[([^\]]*)\]/g)]
    .map((match) => match[1].split(',').map((part) => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean))
  assert.ok(lists.length >= 2, `应至少有两个 gateway 的 inject 声明，实际 ${lists.length}`)
  const mcpInject = lists.find((list) => list.includes('loader'))
  assert.ok(mcpInject, '找不到 MCP gateway 的 inject 声明')
  assert.deepEqual(mcpInject, ['loader', 'tools'],
    `现有 gateway 的 inject 必须**恰好**是 ["loader","tools"]（多一个 skills 就会连累 MCP 面板）`)
})

test('no second cordis.patch.yml entry was added for the skills service', () => {
  // 第二个服务必须在**同一** patch 条目内挂载：SPEC 约束 15 说该文件只有一条
  // `- id: mcp-manager-ui / name: <包名>`。
  //
  // ⚠️ 必须数**条目总数**，不能只数某个特定 id——首版只断言 `id: mcp-manager-ui` 出现 1 次，
  // 于是「新增一条别的 id 的条目」照样通过（变异测试抓到）。真正的约束是
  // 「不得为 skills 新增 patch 条目」，与那条新条目叫什么名字无关。
  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((match) => match[1])
  assert.deepEqual(ids, ['mcp-manager-ui'],
    `cordis.patch.yml 必须恰好只有一条挂载条目，实际：${JSON.stringify(ids)}`)
  // 名字也只能出现一次（内容层面）。
  // 挂载名等于包名——从 package.json 推导，改名只发生在一个地方。
  const packageName = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).name
  assert.equal((patch.match(new RegExp('name: ' + packageName, 'g')) ?? []).length, 1)
})

test('lists skills without requiring an active session', async () => {
  // SPEC 约束 14：不得要求 sessionId。宿主替身里**故意不放任何 session 相关字段**，
  // 若实现偷偷依赖会话，这里会直接抛错而不是「恰好通过」。
  const ctx = skillsHost({
    skills: {
      async list() {
        return [{
          name: 'zhanggui',
          description: '端到端拥有一个开发请求',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-agents',
          provider: 'filesystem',
          path: '/home/u/.agents/skills/zhanggui/SKILL.md',
        }]
      },
    },
  })
  const result = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0].name, 'zhanggui')
  // 面板要按 source 显示**真实**作用域（本机 ~/.dsh/skills 就不存在，技能都在 ~/.agents/skills），
  // 所以 source 必须原样带出来，UI 不得写死根路径（SPEC 约束 12）。
  assert.equal(result.skills[0].source, 'user-agents')
})

test('degrades to an empty list when the skills service is missing', async () => {
  // 未挂载 dsh-skill 时，技能面必须降级而不是抛错（抛错会让整个面板打不开）。
  const ctx = skillsHost({})
  const result = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
  assert.deepEqual(result.skills, [])
})

test('merges project skills per workspace without duplicating globals', async () => {
  // SPEC 约束 13：每个工作区各调一次 list({cwd}) 再合并。宿主传 cwd 时返回的是
  // 「项目+用户+bundled」完整合并视图，所以项目查询结果**已含全局**——直接 concat 会重复。
  const calls = []
  const globalSkills = [
    { name: 'zhanggui', description: 'g', source: 'user-agents', provider: 'filesystem', invocation: {} },
  ]
  const ctx = skillsHost({
    skills: {
      async list(options = {}) {
        calls.push(options.cwd)
        if (options.cwd === undefined) return globalSkills
        return [
          ...globalSkills,
          { name: 'proj-only', description: 'p', source: 'project-dsh', provider: 'filesystem', invocation: {} },
        ]
      },
    },
  })
  const result = await SkillsManagerGateway.prototype.list.call({ ctx }, { workspaces: ['/ws/a', '/ws/b'] })
  // 全局各查一次（不传 cwd），每个工作区各查一次。
  assert.equal(calls.filter((cwd) => cwd === undefined).length, 1)
  assert.deepEqual(calls.filter((cwd) => cwd !== undefined), ['/ws/a', '/ws/b'])
  const names = result.skills.map((row) => row.name).sort()
  assert.deepEqual(names, ['proj-only', 'proj-only', 'zhanggui'])
  // 全局技能只出现一次，不因两个工作区而重复。
  assert.equal(result.skills.filter((row) => row.name === 'zhanggui').length, 1)
})

test('lists a disabled skill even when a whole root is disabled', async () => {
  // ⚠️ 新机制下这条用例的**含义变了**，值得说清楚：停用是写 frontmatter 的两个调用面字段，
  // 所以宿主**照样报得出**这条技能（list 是调用无关的）——面板根本不需要扫盘。
  // 旧版必须自己扫 .disabled，因为改名后宿主看不见它；那正是第二真值来源。
  // 现在这里断言的是：一条两面都关掉的技能仍然出现在列表里，且 enabled=false 由**文件**推出。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-host-'))
  const agentsHome = join(base, 'agents-home')
  const skillsRoot = join(agentsHome, 'skills')
  await mkdir(join(skillsRoot, 'visible'), { recursive: true })
  await writeFile(join(skillsRoot, 'visible', 'SKILL.md'), '---\nname: visible\ndescription: v\n---\n\n正文\n')
  await mkdir(join(skillsRoot, 'switched-off'), { recursive: true })
  await writeFile(join(skillsRoot, 'switched-off', 'SKILL.md'),
    '---\nname: switched-off\ndescription: h\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n正文\n')
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
    const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = ctx.plugin({
      apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
    }, { dshHome: join(base, 'dsh-home'), agentsHome, watch: false })
    await fiber

    const hostCtx = { get: (name) => ctx.get(name) }
    const result = await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, {})
    const rows = result.skills
    assert.deepEqual(rows.map((row) => row.name).sort(), ['switched-off', 'visible'],
      '两个面都关掉的技能必须**照样在列表里**（宿主报得出它，面板不必扫盘）')
    const off = rows.find((row) => row.name === 'switched-off')
    assert.equal(off.enabled, false, 'enabled 由文件里的两个字段派生')
    assert.equal(off.modelInvocable, false)
    assert.equal(off.userInvocable, false)
    // 定位信息必须齐（否则那一行照样操作不了）：根、形态、磁盘条目。
    assert.equal(off.entry, 'switched-off')
    assert.equal(off.kind, 'bundle')
    assert.equal(off.root, skillsRoot)
    await fiber.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an old .disabled leftover is surfaced once, and never doubles a host-visible row', async () => {
  // 旧机制（1.6.x 的改名）留下的条目：**一次性迁移读取**，不是第二个真值来源。
  // 两种情形都要成立：
  //   ① 宿主看不见它（文件确实还叫 .disabled）→ 面板必须补一行出来，否则技能永远回不来；
  //   ② 它同时也能被宿主看见（用户手工把 SKILL.md 改回来了、或两边都存在）
  //      → 必须仍然**只有一个身份一行**，否则客户端按身份做行 key 会出现重复 key
  //      （生产版不报警告，只是静默重复渲染）。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-migrate-'))
  const agentsHome = join(base, 'agents-home')
  const skillsRoot = join(agentsHome, 'skills')
  await mkdir(join(skillsRoot, 'parked'), { recursive: true })
  await writeFile(join(skillsRoot, 'parked', 'SKILL.md.disabled'),
    '---\nname: parked\ndescription: 旧机制停用\n---\n\n正文\n')
  try {
    const ctx = {
      // 宿主目录里看不到它（旧机制就是靠改名让它消失的）
      get: (name) => (name === 'skills' ? { list: async () => [] } : undefined),
      loader: {
        entries: () => [{
          options: {
            name: '@deepseek-ai/dsh-skill-filesystem',
            config: { dshHome: join(base, 'dsh-home'), agentsHome },
          },
        }],
      },
    }
    const result = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
    const parked = result.skills.filter((row) => row.name === 'parked')
    assert.equal(parked.length, 1, '旧机制残留必须被列出来（否则用户再也启用不回来）')
    assert.equal(parked[0].enabled, false)
    assert.equal(parked[0].migrated, true, '要标明它是旧机制的残留，好让面板区别对待')
    assert.equal(parked[0].entry, 'parked', '条目必须是可操作的那个（启用态那一段）')
    assert.equal(parked[0].kind, 'bundle')
    assert.equal(parked[0].root, skillsRoot, '必须带根，否则无法恢复')
    assert.equal(parked[0].source, 'user-agents', '必须带来源：客户端的分组与作用域标签靠它')
    // 契约本身：一个身份一行（客户端行 key 就是这个身份）。
    const keys = result.skills.map((row) => skillRowKey(row))
    assert.equal(new Set(keys).size, keys.length, `同一个身份只能出现一次，实际：${JSON.stringify(keys)}`)
    // 元组钉死：与客户端 lib/client.js 的 skillIdentity 必须是同一个字面量
    // （client-behavior 那条用例钉的是同一串）。
    assert.equal(skillRowKey({ source: 'user-agents', cwd: undefined, name: 'parked' }),
      'user-agents\u0000\u0000parked',
      '身份元组变了就要同时改客户端 skillIdentity —— 否则去重失效、重复 key 回归')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('reads one skill body from the referenced root, on demand', async () => {  // 同一个名字可以存在于多个根（同名跨作用域是合法配置）。detail 必须读**引用指向的那个根**，
  // 而不是宿主按 rank 给的胜者 —— 否则点「被遮蔽」那一行看到的是别人的正文（D8 的精确模型）。
  // 这里让 user-dsh（rank 400，胜者）与 user-agents（rank 500）各有一份，读后者。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-detail-'))
  const agentsHome = join(base, 'agents-home')
  const dshHome = join(base, 'dsh-home')
  const agentsRoot = join(agentsHome, 'skills')
  const dshRoot = join(dshHome, 'skills')
  await mkdir(join(agentsRoot, 'zhanggui'), { recursive: true })
  await writeFile(join(agentsRoot, 'zhanggui', 'SKILL.md'), '---\nname: zhanggui\ndescription: 端到端拥有一个开发请求\n---\n\n# 掌柜\n\n正文\n')
  await mkdir(join(dshRoot, 'zhanggui'), { recursive: true })
  await writeFile(join(dshRoot, 'zhanggui', 'SKILL.md'), '---\nname: zhanggui\ndescription: 另一份\n---\n\n# 另一个根\n')
  try {
    const ctx = {
      get: () => undefined,
      loader: {
        entries: () => [{
          options: {
            name: '@deepseek-ai/dsh-skill-filesystem',
            config: { dshHome, agentsHome },
          },
        }],
      },
    }
    const found = await SkillsManagerGateway.prototype.detail.call({ ctx },
      { entry: 'zhanggui', kind: 'bundle', name: 'zhanggui', source: 'user-agents', root: agentsRoot })
    assert.equal(found.skill.name, 'zhanggui')
    assert.match(found.skill.content, /正文/)
    assert.equal(found.skill.source, 'user-agents')
    const other = await SkillsManagerGateway.prototype.detail.call({ ctx },
      { entry: 'zhanggui', kind: 'bundle', name: 'zhanggui', source: 'user-dsh', root: dshRoot })
    assert.match(other.skill.content, /另一个根/, '读的必须是引用指向的那个根，不是 rank 胜者')
    // 找不到要**报错**而不是返回空对象：面板要区分「没有这个技能」与「读失败」。
    await assert.rejects(
      () => SkillsManagerGateway.prototype.detail.call({ ctx },
        { entry: 'nope', kind: 'bundle', name: 'nope', source: 'user-agents', root: agentsRoot }),
      /nope/,
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('importSkill lands in the referenced root and refuses a read-only one', async () => {
  // 网关层的导入路径（`skillsManager/importSkill`）：落点只认引用，只读根一律拒。
  // 这条补的是「变更类 RPC 零用例」的缺口——之前只有 skillHubInstall 被端到端跑过。
  const base = await mkdtemp(join(tmpdir(), 'dsh-import-rpc-'))
  const agentsHome = join(base, 'agents-home')
  const bundled = join(base, 'bundled')
  const source = join(base, 'to-import')
  await mkdir(source, { recursive: true })
  // 只读根也要先建出来：下面那条「内置根不得被写入」要靠 readdir 去**看**这个目录，
  // 不建就是 ENOENT——断言写在那儿却从来没跑到（真实动机是「拒绝了，就什么都没落下」）。
  await mkdir(bundled, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '---\nname: imported-by-rpc\ndescription: 来自 RPC 的导入\n---\n\n正文\n')
  const ctx = {
    get: () => undefined,
    loader: {
      entries: () => [{
        options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome: join(base, 'dsh-home'), agentsHome, bundledSkillDir: bundled } },
      }],
    },
  }
  const root = join(agentsHome, 'skills')
  try {
    const result = await SkillsManagerGateway.prototype.importSkill.call({ ctx }, {
      source: 'user-agents',
      root,
      type: 'directory',
      path: source,
    })
    assert.equal(result.name, 'imported-by-rpc')
    assert.equal(existsSync(join(root, 'imported-by-rpc', 'SKILL.md')), true)
    // 只读根（bundled）：即使载荷里没有任何 writable 字段也必须被拒
    await assert.rejects(
      () => SkillsManagerGateway.prototype.importSkill.call({ ctx }, {
        source: 'bundled',
        root: bundled,
        type: 'directory',
        path: source,
      }),
      /只读/,
    )
    assert.deepEqual(await readdir(bundled), [], '内置根不得被写入')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── 调用权限：一律来自磁盘上的技能文件 ──────────────────────────────────────
//
// 为什么不能让行上的权限继续取自宿主 summary：那是**发现缓存**（同文件上方那条「陈旧行」用例
// 已经证明它会在改名后继续报旧状态）。而调用权限正是本面板要**写**的东西——写盘后若显示回退，
// 用户看到的是「点了没反应」；更糟的是宿主缓存里的值会被当成事实展示。
// 所以行的权限从**那个文件本身**解析，与 detail 读的正文同源；读不到就是 null（不知道），
// 不编一个布尔值出来。

/** 造一个宿主 summary：面板行靠 path + resourceBase 反推根、形态与磁盘条目（见 locateSkill）。 */
function hostSummary({ name, root, source = 'user-agents', invocation, entry = name }) {
  const directory = join(root, entry)
  return {
    name,
    description: '宿主缓存里的描述',
    source,
    provider: 'filesystem',
    ...(invocation === undefined ? {} : { invocation }),
    path: join(directory, 'SKILL.md'),
    resourceBase: { path: directory },
  }
}

/** 只提供 skills 与 filesystem provider 配置的宿主替身。 */
function hostWith(rows, { base, agentsHome }) {
  return {
    get: (name) => (name === 'skills' ? { list: async () => rows } : undefined),
    loader: {
      entries: () => [{
        options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome: join(base, 'dsh-home'), agentsHome } },
      }],
    },
  }
}

test('list reports the invocation that is on disk, not the one the host cache still holds', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-invocation-cache-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  await mkdir(join(root, 'zhanggui'), { recursive: true })
  await writeFile(join(root, 'zhanggui', 'SKILL.md'),
    '---\nname: zhanggui\ndescription: 磁盘上这份是禁止模型调用的\ndisable-model-invocation: true\n---\n\n正文\n')
  try {
    // 宿主缓存说「模型可调用」——磁盘说不是。磁盘赢。
    const ctx = hostWith([hostSummary({ name: 'zhanggui', root, invocation: { modelInvocable: true, userInvocable: true } })], { base, agentsHome })
    const result = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
    assert.equal(result.skills.length, 1)
    assert.equal(result.skills[0].modelInvocable, false, '面板必须显示文件里写的那个值')
    assert.equal(result.skills[0].userInvocable, true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the derived enabled flag follows BOTH invocation faces, across all four states', async () => {
  // ⚠️ 这条补的是审查发现的**零覆盖缺口**（变异「enabled 只看 modelInvocable、漏掉 userInvocable」
  // 跑全量仍然全绿）。漏掉 userInvocable 会把「仅用户可调用」这一档误判成「已停用」——
  // 而那一档正是用户最常用的一档（模型别自动用，我手动点名时才用）。
  //
  // 四态表（宿主原生两个字段的全部组合）：
  //   都不写                      → 模型可调用 + 用户可调用 → enabled = true
  //   disable-model-invocation    → 仅用户可调用           → enabled = **true**（不是停用！）
  //   user-invocable: false       → 仅模型可调用           → enabled = true
  //   两个都写                    → 两个面都关掉           → enabled = **false**（= 停用）
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')

  const base = await mkdtemp(join(tmpdir(), 'dsh-four-states-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  const cases = [
    ['both-open', '', true, true, true],
    ['user-only', 'disable-model-invocation: true\n', false, true, true],
    ['model-only', 'user-invocable: false\n', true, false, true],
    ['switched-off', 'disable-model-invocation: true\nuser-invocable: false\n', false, false, false],
  ]
  for (const [name, extra] of cases) {
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n${extra}---\n\n正文\n`)
  }
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = ctx.plugin({
    apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
  }, { dshHome: join(base, 'dsh-home'), agentsHome, watch: false })
  await fiber
  try {
    const hostCtx = { get: (n) => ctx.get(n) }
    const result = await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, {})
    const byName = new Map(result.skills.map((row) => [row.name, row]))
    for (const [name, , modelInvocable, userInvocable, enabled] of cases) {
      const row = byName.get(name)
      assert.notEqual(row, undefined, `${name} 必须出现在列表里`)
      assert.equal(row.modelInvocable, modelInvocable, `${name} 的模型面`)
      assert.equal(row.userInvocable, userInvocable, `${name} 的用户面`)
      assert.equal(row.enabled, enabled,
        `${name} 的 enabled 必须由**两个面**共同决定（只看模型面会把 user-only 误判成已停用）`)
    }
    // 另一条不可省的检查：**只有**「两个面都关」才算停用，所以恰好一条为 false。
    assert.deepEqual(result.skills.filter((row) => row.enabled === false).map((row) => row.name), ['switched-off'])
  } finally {
    await fiber.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
})

test('detail reports the same enabled verdict as list, for both normal and migrated rows', async () => {
  // ⚠️ 补审查发现的第二处零覆盖：`detail` 的 `enabled` 改回恒 true 曾跑全量仍绿。
  // 两个 RPC 对同一个概念给相反结论就是第二判据——而迁移行正是最容易分叉的那一类：
  // 它的「停用」在**文件名**里，照文件内容派生会把它说成「已启用」（真机实测过）。
  const base = await mkdtemp(join(tmpdir(), 'dsh-detail-enabled-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  await mkdir(join(root, 'normal'), { recursive: true })
  await writeFile(join(root, 'normal', 'SKILL.md'), '---\nname: normal\ndescription: x\n---\n\n正文\n')
  await mkdir(join(root, 'off'), { recursive: true })
  await writeFile(join(root, 'off', 'SKILL.md'),
    '---\nname: off\ndescription: x\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n正文\n')
  // 旧机制残留：注意它**文件内容里**写着 disable-model-invocation: true（用户当年关过模型面），
  // 照内容派生会得到「一个面关着 → 不算停用」→ enabled=true（错），它在磁盘上的形态就是停用。
  await mkdir(join(root, 'parked'), { recursive: true })
  await writeFile(join(root, 'parked', 'SKILL.md.disabled'),
    '---\nname: parked\ndescription: 旧机制停用\ndisable-model-invocation: true\n---\n\n正文\n')
  try {
    // ⚠️ 用**真宿主**而不是替身：这条要同时覆盖「宿主看得见的两种」与「只有我们看得见的残留」，
    // 替身 `list: async () => []` 会把前两种一起抹掉，于是循环只剩一行、证明不了「两处判据一致」。
    const { Context } = await import('@deepseek-ai/cordis')
    const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
    const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')
    const live = new Context()
    await live.plugin(SkillRegistry)
    const fiber = live.plugin({
      apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
    }, { dshHome: join(base, 'dsh-home'), agentsHome, watch: false })
    await fiber
    const ctx = {
      get: (name) => live.get(name),
      loader: {
        entries: () => [{
          options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome: join(base, 'dsh-home'), agentsHome } },
        }],
      },
    }
    const listed = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
    for (const row of listed.skills) {
      const detail = await SkillsManagerGateway.prototype.detail.call({ ctx }, {
        name: row.name, entry: row.entry, kind: row.kind, source: row.source, root: row.root, projectPath: row.cwd,
      })
      assert.equal(detail.skill.enabled, row.enabled,
        `${row.name}：detail 与 list 的 enabled 必须一致（两个 RPC 给相反结论就是第二判据）`)
      assert.equal(detail.skill.migrated, row.migrated === true, `${row.name} 的 migrated 也要一致`)
    }
    // 前提检查：这一批里确实三种都有，否则上面的循环证明不了什么。
    assert.deepEqual(listed.skills.map((row) => [row.name, row.enabled]).sort(),
      [['normal', true], ['off', false], ['parked', false]],
      '前提：正常 / 两个面都关 / 旧机制残留 三种都要在场')
    await fiber.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a migrated row reports the name from its frontmatter, not the disk entry name', async () => {
  // ⚠️ 补审查发现的第三处零覆盖（变异「迁移行取磁盘条目名」曾跑全量仍绿）。
  // 旧机制的条目名同样不保证等于技能名，而面板显示的名字必须是技能名（宿主就是这么认定的）。
  const base = await mkdtemp(join(tmpdir(), 'dsh-migrated-name-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  await mkdir(join(root, 'disk-parked'), { recursive: true })
  await writeFile(join(root, 'disk-parked', 'SKILL.md.disabled'),
    '---\nname: alias-parked\ndescription: 磁盘名与技能名不同\n---\n\n正文\n')
  try {
    const ctx = {
      get: (name) => (name === 'skills' ? { list: async () => [] } : undefined),
      loader: {
        entries: () => [{
          options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome: join(base, 'dsh-home'), agentsHome } },
        }],
      },
    }
    const [row] = (await SkillsManagerGateway.prototype.list.call({ ctx }, {})).skills
    assert.equal(row.name, 'alias-parked', '显示名必须取自 frontmatter（宿主认定的技能名）')
    assert.equal(row.entry, 'disk-parked', '条目仍是磁盘上的那个名字（定位要用它）')
    assert.equal(row.description, '磁盘名与技能名不同', '描述同样取自那个文件')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
test('list reports the real invocation of a migrated leftover instead of claiming it cannot be called', async () => {
  // 旧机制残留（`.disabled`）在宿主目录里不存在，所以它**只有**我们能读到的这份文件。
  // 之前这些行完全没有 invocation 字段，客户端于是把它渲染成「模型不可调用 / 用户不可调用」——
  // 一个凭空的断言。停用与调用权限是两件事：残留的文件照样可以声明自己允许被调用。
  const base = await mkdtemp(join(tmpdir(), 'dsh-invocation-disabled-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  await mkdir(join(root, 'paused'), { recursive: true })
  await writeFile(join(root, 'paused', 'SKILL.md.disabled'),
    '---\nname: paused\ndescription: 旧机制停用，但只是不给用户手动调用\nuser-invocable: false\n---\n\n正文\n')
  try {
    const ctx = hostWith([], { base, agentsHome })
    const result = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
    const rows = result.skills.filter((row) => row.name === 'paused')
    assert.equal(rows.length, 1, '旧机制残留必须列出来（宿主看不见它，只有我们能补）')
    const [row] = rows
    assert.equal(row.migrated, true)
    assert.equal(row.modelInvocable, true, '文件没禁止模型调用，就不许说它不可调用')
    assert.equal(row.userInvocable, false)
    assert.equal(row.enabled, false, 'enabled 是派生的：两个面没都关，所以严格说它不算「已停用」')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a row whose file cannot be read reports an unknown invocation, not a made-up one', async () => {
  // 宿主的发现缓存可能指向一个已经被删掉/搬走的技能（缓存又比磁盘旧）。此时「能不能被模型调用」
  // 没有答案：面板必须收到 null 并显示「未知」，而不是替它编一个 false。
  const base = await mkdtemp(join(tmpdir(), 'dsh-invocation-gone-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  await mkdir(root, { recursive: true })
  try {
    const ctx = hostWith([hostSummary({ name: 'ghost', root, invocation: { modelInvocable: true, userInvocable: true } })], { base, agentsHome })
    const result = await SkillsManagerGateway.prototype.list.call({ ctx }, {})
    assert.equal(result.skills.length, 1, '宿主的陈旧行照样列出来（它由另一条用例管去重）')
    assert.equal(result.skills[0].modelInvocable, null, '读不到文件就必须说「不知道」')
    assert.equal(result.skills[0].userInvocable, null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('detail reports the invocation parsed from the very bytes it returns as the body', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-invocation-detail-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  await mkdir(join(root, 'zhanggui'), { recursive: true })
  await writeFile(join(root, 'zhanggui', 'SKILL.md'),
    '---\nname: zhanggui\ndescription: 演示\ndisable-model-invocation: true\n---\n\n# 掌柜\n\n正文\n')
  try {
    const ctx = hostWith([], { base, agentsHome })
    const found = await SkillsManagerGateway.prototype.detail.call({ ctx },
      { entry: 'zhanggui', kind: 'bundle', source: 'user-agents', root })
    assert.match(found.skill.content, /正文/)
    assert.equal(found.skill.modelInvocable, false, '正文与权限必须来自同一次读')
    assert.equal(found.skill.userInvocable, true)
    assert.equal(found.skill.entry, 'zhanggui', '详情要回带可操作的条目（客户端据此继续操作）')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the host picks up a disabled skill without a restart (the docs must not tell users to restart)', async () => {
  // ⚠️ 这条钉的是**用户可见文案的前提**：docs/skills.md 与详情页的提示都说「不必重启 DSH」，
  // 而旧文案写的是「重启 DSH 最稳妥」——那句话会让用户白重启一次。
  //
  // 断言必须问**真宿主**：文件监听（chokidar，depth 1）是宿主的行为，替身测不出它。
  // 实测这个窗口约 0.25 秒（8 次采样中位数 246ms；受 watcher 的 200ms stabilityThreshold 支配），
  // 这里给 5s 余量——用例要证明的是「会自动生效」，不是「多快生效」（钉死时间会变成 flaky）。
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry, isModelInvocable } = await import('@deepseek-ai/dsh-skill')
  const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')

  const base = await mkdtemp(join(tmpdir(), 'dsh-live-refresh-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  const dshHome = join(base, 'dsh-home')
  await mkdir(join(root, 'the-skill'), { recursive: true })
  const file = join(root, 'the-skill', 'SKILL.md')
  await writeFile(file, '---\nname: the-skill\ndescription: 演示\n---\n\n正文\n')

  // ⚠️ `watch: true` 是真机默认（presets 都没关它，profile 也没覆盖）——这正是这条用例的前提。
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = ctx.plugin({
    apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
  }, { dshHome, agentsHome, watch: true })
  await fiber
  try {
    const hostCtx = {
      get: (n) => ctx.get(n),
      loader: { entries: () => [{ options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome, agentsHome } } }] },
    }
    const modelHas = async () => (await ctx.skills.list({})).filter(isModelInvocable).some((s) => s.name === 'the-skill')
    assert.equal(await modelHas(), true, '前提：停用前模型目录里有它')

    // 用**面板自己的写路径**停用（不是手改文件）
    const row = (await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, {})).skills[0]
    await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx },
      { ...row, projectPath: row.cwd, enabled: false })

    let elapsed = null
    for (let i = 0; i < 50; i += 1) {
      if (!(await modelHas())) { elapsed = i * 100; break }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.notEqual(elapsed, null,
      '宿主必须**自己**发现这次改动（文件监听）——若这条红了，文档里「不必重启」的说法就不成立，要么改实现要么改文案')
  } finally {
    await fiber.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
})

test('the two invocation faces are reachable over RPC, so every bracket is operable', async () => {
  // ⚠️ 这条证明「面板与文件 1:1」在 **wire 层**也成立：两个面各有一条 RPC，都能真的改盘，
  // 而且断言落在**真宿主看到的行为**上（不是一个面在文件里写了什么）。
  // 以前只有 setModelInvocable 一条，于是「仅手动可调用」那一档在面板里**够不到**；
  // 用户在面板里把技能从「仅手动」拨到停用再拨回启用，会落到「两个都能用」而没有开关能拨回去。
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry, isModelInvocable, isUserInvocable } = await import('@deepseek-ai/dsh-skill')
  const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')

  const base = await mkdtemp(join(tmpdir(), 'dsh-faces-rpc-'))
  const agentsHome = join(base, 'agents-home')
  const root = join(agentsHome, 'skills')
  const file = join(root, 'the-skill', 'SKILL.md')
  const dshHome = join(base, 'dsh-home')
  await mkdir(join(root, 'the-skill'), { recursive: true })
  const original = '---\nname: the-skill\ndescription: 演示\n---\n\n正文\n'
  await writeFile(file, original)

  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  // ⚠️ `watch: true`（真机默认）：宿主的技能目录有**发现缓存**，我们改了盘之后要靠它的
  // watcher 作废缓存才会反映到 `list()`。用 `watch: false` 跑会让下面的断言读到旧缓存，
  // 把一个**正确**的实现报成失败（本轮在验收脚本上踩过同一个坑）。
  const fiber = ctx.plugin({
    apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
  }, { dshHome, agentsHome, watch: true })
  await fiber
  try {
    const hostCtx = {
      get: (n) => ctx.get(n),
      loader: { entries: () => [{ options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome, agentsHome } } }] },
    }
    const row = (await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, {})).skills[0]
    const ref = { ...row, projectPath: row.cwd }
    /**
     * 宿主当前**两个面**分别拿不拿得到它。
     * 等到它变成期望值为止（watcher 的稳定阈值是 200ms，给足余量）——探的是宿主行为，
     * 不是文件内容，所以必须等它自己重新发现。
     */
    const expectFaces = async (expected, why) => {
      let actual
      for (let i = 0; i < 40; i += 1) {
        const list = await ctx.skills.list({})
        actual = {
          model: list.filter(isModelInvocable).some((s) => s.name === 'the-skill'),
          user: list.filter(isUserInvocable).some((s) => s.name === 'the-skill'),
          reported: list.some((s) => s.name === 'the-skill'),
        }
        if (actual.model === expected.model && actual.user === expected.user && actual.reported === expected.reported) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.deepEqual(actual, expected, why)
    }

    // ① 只关用户面 → 规范里「仅模型可调用」那一档（以前从面板够不到）
    const userOff = await SkillsManagerGateway.prototype.setUserInvocable.call({ ctx: hostCtx },
      { ...ref, userInvocable: false })
    assert.equal(userOff.changed, true)
    await expectFaces({ model: true, user: false, reported: true },
      '只关用户面：模型仍可自动调用，用户不能手动调用')

    // ② 只关模型面 → 「仅手动可调用」那一档
    await SkillsManagerGateway.prototype.setUserInvocable.call({ ctx: hostCtx }, { ...ref, userInvocable: true })
    await SkillsManagerGateway.prototype.setModelInvocable.call({ ctx: hostCtx }, { ...ref, modelInvocable: false })
    await expectFaces({ model: false, user: true, reported: true },
      '只关模型面：模型不自动发现，用户仍能手动调用')

    // ③ 两个都关 → 停用（两个面都拿不到，而宿主仍报告它 → 面板列得出来、能恢复）
    await SkillsManagerGateway.prototype.setUserInvocable.call({ ctx: hostCtx }, { ...ref, userInvocable: false })
    await expectFaces({ model: false, user: false, reported: true },
      '两个面都关 = 停用；而宿主照样报告它（这就是面板不必扫盘的原因）')

    // ④ 两个都打开 → 逐字节还原原文
    await SkillsManagerGateway.prototype.setUserInvocable.call({ ctx: hostCtx }, { ...ref, userInvocable: true })
    await SkillsManagerGateway.prototype.setModelInvocable.call({ ctx: hostCtx }, { ...ref, modelInvocable: true })
    assert.equal(await readFile(file, 'utf8'), original, '两个面恢复后必须逐字节还原原文')
    await expectFaces({ model: true, user: true, reported: true }, '两个面都恢复成可调用')
  } finally {
    await fiber.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
})

test('setModelInvocable writes the referenced file and refuses a read-only root', async () => {
  // 面板的开关走这条 RPC。落点只认引用（与 setEnabled 同一条纪律）：客户端送 root，服务端拿
  // 自己算出来的目标核对；bundled 根一律拒。
  const base = await mkdtemp(join(tmpdir(), 'dsh-invocation-rpc-'))
  const agentsHome = join(base, 'agents-home')
  const bundled = join(base, 'bundled')
  const root = join(agentsHome, 'skills')
  await mkdir(join(root, 'zhanggui'), { recursive: true })
  await mkdir(join(bundled, 'builtin'), { recursive: true })
  await writeFile(join(root, 'zhanggui', 'SKILL.md'), '---\nname: zhanggui\ndescription: 演示\n---\n\n正文\n')
  await writeFile(join(bundled, 'builtin', 'SKILL.md'), '---\nname: builtin\ndescription: 内置\n---\n\n正文\n')
  const loaderEntries = () => [{
    options: {
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { dshHome: join(base, 'dsh-home'), agentsHome, bundledSkillDir: bundled },
    },
  }]
  const ctx = { get: () => undefined, loader: { entries: loaderEntries } }
  try {
    const result = await SkillsManagerGateway.prototype.setModelInvocable.call({ ctx }, {
      entry: 'zhanggui',
      kind: 'bundle',
      source: 'user-agents',
      root,
      modelInvocable: false,
    })
    assert.equal(result.changed, true)
    assert.equal(result.modelInvocable, false)
    const text = await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8')
    assert.equal(diagnoseSkill(text).invocation.modelInvocable, false, '写盘结果必须被宿主读成「不可调用」')
    assert.equal(diagnoseSkill(text).invocation.userInvocable, true,
      '只动模型面：用户面必须原样（不许顺手改成不可调用）')

    const before = await readFile(join(bundled, 'builtin', 'SKILL.md'), 'utf8')
    await assert.rejects(
      () => SkillsManagerGateway.prototype.setModelInvocable.call({ ctx }, {
        entry: 'builtin',
        kind: 'bundle',
        source: 'bundled',
        root: bundled,
        modelInvocable: false,
      }),
      /只读/,
    )
    assert.equal(await readFile(join(bundled, 'builtin', 'SKILL.md'), 'utf8'), before, '内置根不得被写入')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the user-reported shape: linked skill dirs + DSH_HOME inside the workspace stay fully operable', async () => {
  // ⚠️ 这条来自 issue #5 后续反馈，抓到的是**两个条件叠加**才出现的缺陷：
  //    ① `DSH_HOME` 就在工作区里（工作区自己是 git 根）→ 项目级根与全局根是同一个物理目录；
  //    ② 技能目录全是指向外部同步库的**符号链接/junction**。
  // 单独测任一条都发现不了：单独测 ① 只是"行重复"，单独测 ② 只是"根定位不到"。
  // 叠加起来是：宿主把每条技能按**每个工作区**各报一份（实测 5 条 → 15 行），
  // 而每一份的根都定位不到 → 全部 `root === undefined` → **点哪个都报「缺少技能目标引用」**。
  // 也就是「面板列得满满当当，但一个都用不了」——用户的原话。
  //
  // ⚠️⚠️ 这条**必须用真 provider**（@deepseek-ai/dsh-skill-filesystem）。理由是本缺陷的
  // 根因就在那个包的两个字段口径不同（`resourceBase.path` 是展示路径、`path` 是 realpath），
  // 而手搓 summary 是我"以为"的宿主形状——上一轮的用例全是手搓的，于是整类缺陷都测不到。
  // 这个包原先不在 devDependencies 里，正是"测试网够不着这一层"的原因；已补上。
  //
  // 断言必须落在**可操作性**上（真的去改盘），不能只断言"列出了几行"——那正是上一轮的漏法。
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')

  const base = await mkdtemp(join(tmpdir(), 'dsh-user-shape-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-user-shape-ext-'))
  const workspace = join(base, 'DSH')
  const nested = join(workspace, 'temp')
  await mkdir(join(workspace, '.git'), { recursive: true })
  await mkdir(nested, { recursive: true })
  // DSH_HOME 落在工作区里 → project-dsh 根 == user-dsh 根（同一个物理目录）
  const dshHome = join(workspace, '.dsh')
  const skillsRoot = join(dshHome, 'skills')
  const agentsHome = join(base, 'agents-home')
  await mkdir(skillsRoot, { recursive: true })

  const names = ['alpha', 'beta', 'gamma']
  for (const name of names) {
    // 技能本体在外部库里，技能根下只放 junction（用户 11 条技能的真实形态）
    await mkdir(join(external, name), { recursive: true })
    await writeFile(join(external, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n${name} 正文。\n`)
    try {
      await symlink(join(external, name), join(skillsRoot, name), 'junction')
    } catch (error) {
      await rm(base, { recursive: true, force: true })
      await rm(external, { recursive: true, force: true })
      throw new Error(`本环境无法创建链接（${error.code}），该用例未能执行`)
    }
  }

  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  // provider 必须带自己的 inject（它靠这个拿到 skills 服务）
  const fiber = ctx.plugin({
    apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
  }, { dshHome, agentsHome, watch: false })
  await fiber
  const hostCtx = {
    get: (name) => ctx.get(name),
    loader: {
      entries: () => [{
        options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome, agentsHome } },
      }],
    },
  }
  try {
    const listed = await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, { workspaces: [workspace, nested] })

    // ① 每个技能只占一行（不是每工作区一份）
    assert.deepEqual(listed.skills.map((row) => row.name).sort(), [...names].sort(),
      `既不能重复列出、也不能丢：实际 ${listed.skills.length} 行`)
    // ② 每一行都定位到**根 + 磁盘条目**，且能读出调用权限（链接目录下这三件事以前都做不到）
    for (const row of listed.skills) {
      assert.notEqual(row.root, undefined, `${row.name} 必须定位到根（链接目录也不例外）`)
      assert.equal(row.entry, row.name, `${row.name} 的条目必须是链接的展示名（磁盘上就是它）`)
      assert.equal(row.kind, 'bundle')
      assert.equal(row.modelInvocable, true, `${row.name} 的调用权限要从文件里读出来`)
    }
    // ③ 最关键：每一行都**真的能操作**。客户端送的是行上的引用（见 lib/client.js 的 toggleRow）。
    for (const row of listed.skills) {
      const off = await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx }, {
        name: row.name, entry: row.entry, kind: row.kind, source: row.source, root: row.root, projectPath: row.cwd, enabled: false,
      })
      assert.equal(off.changed, true, `${row.name} 必须能被停用（此前这里报「缺少技能目标引用」）`)
      // ⚠️ 断言落在**盘上的真相**：停用写的是宿主两个原生字段，而且写在**外部库那份真实文件**上
      // （链接要跟过去）。文件本身**不得改名**——改名会让技能在 VS Code/Codex 里坏掉。
      const parkedText = await readFile(join(external, row.name, 'SKILL.md'), 'utf8')
      assert.deepEqual(diagnoseSkill(parkedText).invocation, { modelInvocable: false, userInvocable: false },
        `${row.name} 的停用必须落到真实文件的两个字段上`)
      assert.equal(existsSync(join(external, row.name, 'SKILL.md.disabled')), false,
        `${row.name} 不得被改名（旧机制才会留下 .disabled）`)
      const back = await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx }, {
        name: row.name, entry: row.entry, kind: row.kind, source: row.source, root: row.root, projectPath: row.cwd, enabled: true,
      })
      assert.equal(back.changed, true, `${row.name} 必须能再启用回来`)
    }
    // ④ 正文也读得出（"用不了"的另一半）
    const first = listed.skills[0]
    const detail = await SkillsManagerGateway.prototype.detail.call({ ctx: hostCtx }, {
      name: first.name, entry: first.entry, kind: first.kind, source: first.source, root: first.root, projectPath: first.cwd,
    })
    assert.match(detail.skill.content, new RegExp(`${first.name} 正文`), '正文必须读得出')

    // ⑤ 停用一条后它**照样在列表里**、只是状态变了——这正是新机制相对旧机制的结构性好处：
    // 宿主 list 是调用无关的，所以面板不需要扫盘、也就没有「同一身份两行」的可能。
    const victim = listed.skills[0]
    await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx }, {
      name: victim.name, entry: victim.entry, kind: victim.kind, source: victim.source, root: victim.root, projectPath: victim.cwd, enabled: false,
    })
    const afterDisable = await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, { workspaces: [workspace, nested] })
    assert.equal(afterDisable.skills.length, names.length,
      '停用不该让条目凭空消失：宿主照样报得出它（面板因此不必扫盘）')
    const parked = afterDisable.skills.filter((row) => row.name === victim.name)
    assert.equal(parked.length, 1, `${victim.name} 停用后必须仍然只有一行`)
    assert.equal(parked[0].enabled, false, `${victim.name} 的 enabled 必须由文件里的两个字段派生为 false`)
    const revived = await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx }, {
      name: parked[0].name, entry: parked[0].entry, kind: parked[0].kind, source: parked[0].source, root: parked[0].root, projectPath: parked[0].cwd, enabled: true,
    })
    assert.equal(revived.changed, true, `${victim.name} 必须能点「启用」恢复`)

    // ⑥ 删除：只删链接，**不能碰外部库里的真实内容**。技能本体在用户的同步库里，
    // 删错方向就是删掉用户自己的数据——这是本套动作里唯一不可逆的一步。
    const doomed = afterDisable.skills[0]
    await SkillsManagerGateway.prototype.removeSkill.call({ ctx: hostCtx }, {
      name: doomed.name, entry: doomed.entry, kind: doomed.kind, source: doomed.source, root: doomed.root, projectPath: doomed.cwd,
    })
    assert.equal(existsSync(join(skillsRoot, doomed.name)), false, `${doomed.name} 的链接必须被删掉`)
    assert.equal(existsSync(join(external, doomed.name, 'SKILL.md')), true,
      `${doomed.name} 在外部库里的真实内容不能被删（那是用户的数据，不是我们的副本）`)

    // ⑦ 一个身份一行（客户端行 key 就是这个身份）
    const keys = afterDisable.skills.map((row) => skillRowKey(row))
    assert.equal(new Set(keys).size, keys.length, `同一个身份只能出现一次，实际：${JSON.stringify(keys)}`)
  } finally {
    await fiber.dispose?.()
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('the user shape with MISMATCHED disk names: every operation works and only the link is touched', async () => {
  // ⚠️ 本轮审计的核心缺陷（真机实测 6 种形态里 4 种不可操作）：
  // 宿主**允许**磁盘条目名与 frontmatter 的 `name` 不一致（`disk-name/SKILL.md` 里写
  // `name: skill-alias` 照收，技能名来自 frontmatter）。而面板曾经按**技能名**拼磁盘路径
  // （`join(root, name, 'SKILL.md')`），于是这类技能读正文/启停/删除**全部失败**。
  //
  // 这条把「用户完整形状」（DSH_HOME 在工作区里 × 技能全是 junction × 两个工作区）
  // 与「名字不一致」**叠在一起**——两个条件各自都已被证明能单独制造缺陷，叠加才是真机的样子。
  // 并且必须用**真宿主包**：`path`（realpath）与 `resourceBase.path`（展示路径）的口径差异
  // 只有真 provider 才产得出来（教训 13：手搓 summary 是我以为的宿主形状）。
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const fsProvider = await import('@deepseek-ai/dsh-skill-filesystem')

  const base = await mkdtemp(join(tmpdir(), 'dsh-alias-shape-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-alias-shape-ext-'))
  const workspace = join(base, 'DSH')
  const nested = join(workspace, 'temp')
  await mkdir(join(workspace, '.git'), { recursive: true })
  await mkdir(nested, { recursive: true })
  const dshHome = join(workspace, '.dsh')
  const skillsRoot = join(dshHome, 'skills')
  const agentsHome = join(base, 'agents-home')
  await mkdir(skillsRoot, { recursive: true })

  // 每条技能：**磁盘目录名 != frontmatter 的 name**，且本体在外部库里（junction）。
  const skills = [
    { disk: 'disk-alpha', name: 'alpha-alias' },
    { disk: 'disk-beta', name: 'beta-alias' },
  ]
  for (const skill of skills) {
    await mkdir(join(external, skill.disk), { recursive: true })
    await writeFile(join(external, skill.disk, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.name} 的说明\n---\n\n${skill.name} 正文。\n`)
    try {
      await symlink(join(external, skill.disk), join(skillsRoot, skill.disk), 'junction')
    } catch (error) {
      await rm(base, { recursive: true, force: true })
      await rm(external, { recursive: true, force: true })
      throw new Error(`本环境无法创建链接（${error.code}），该用例未能执行`)
    }
  }

  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = ctx.plugin({
    apply: fsProvider.apply, inject: fsProvider.inject, name: fsProvider.name, Config: fsProvider.Config,
  }, { dshHome, agentsHome, watch: false })
  await fiber
  const hostCtx = {
    get: (name) => ctx.get(name),
    loader: {
      entries: () => [{
        options: { name: '@deepseek-ai/dsh-skill-filesystem', config: { dshHome, agentsHome } },
      }],
    },
  }
  try {
    const listed = await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, { workspaces: [workspace, nested] })
    // 宿主报的名字是 frontmatter 里的那个（不是磁盘名）——这正是当初误用它的原因。
    assert.deepEqual(listed.skills.map((row) => row.name).sort(), ['alpha-alias', 'beta-alias'],
      '宿主按 frontmatter 取名')
    // 而面板必须给出**磁盘条目**，才能定位。
    assert.deepEqual(listed.skills.map((row) => row.entry).sort(), ['disk-alpha', 'disk-beta'],
      '面板必须从宿主字段还原出磁盘条目名（不是拿技能名）')

    for (const row of listed.skills) {
      const reference = {
        name: row.name, entry: row.entry, kind: row.kind, source: row.source, root: row.root, projectPath: row.cwd,
      }
      // ① 读正文：以前这里直接报「找不到技能 <别名>」
      const detail = await SkillsManagerGateway.prototype.detail.call({ ctx: hostCtx }, reference)
      assert.match(detail.skill.content, new RegExp(`${row.name} 正文`), `${row.name} 的正文必须读得出`)
      assert.equal(detail.skill.name, row.name, '详情回带的技能名取自文件本身')
      // ② 停用 → 落到外部库那份真实文件的两个字段上
      const off = await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx }, { ...reference, enabled: false })
      assert.equal(off.changed, true, `${row.name} 必须能停用`)
      const parkedText = await readFile(join(external, row.entry, 'SKILL.md'), 'utf8')
      assert.deepEqual(diagnoseSkill(parkedText).invocation, { modelInvocable: false, userInvocable: false },
        `${row.name} 的停用必须落在真实文件的字段上`)
      // ③ 停用后仍在列表里（新机制：宿主照样报得出它），并且能启用回来
      const afterOff = await SkillsManagerGateway.prototype.list.call({ ctx: hostCtx }, { workspaces: [workspace, nested] })
      assert.equal(afterOff.skills.filter((r) => r.name === row.name).length, 1, `${row.name} 停用后仍在列表里`)
      assert.equal(afterOff.skills.find((r) => r.name === row.name).enabled, false)
      const on = await SkillsManagerGateway.prototype.setEnabled.call({ ctx: hostCtx }, { ...reference, enabled: true })
      assert.equal(on.changed, true, `${row.name} 必须能启用回来`)
    }

    // ④ 删除：删的是**链接**，外部库那份真实内容必须一个字节不少。
    const doomed = listed.skills.find((row) => row.name === 'alpha-alias')
    await SkillsManagerGateway.prototype.removeSkill.call({ ctx: hostCtx }, {
      name: doomed.name, entry: doomed.entry, kind: doomed.kind, source: doomed.source, root: doomed.root, projectPath: doomed.cwd,
    })
    assert.equal(existsSync(join(skillsRoot, doomed.entry)), false, '链接必须被删掉')
    assert.equal(existsSync(join(external, doomed.entry, 'SKILL.md')), true,
      '外部库里的真实内容不能被删（那是用户的数据）')
    // 另一条技能不受影响：删错范围会连它一起带走
    assert.equal(existsSync(join(skillsRoot, 'disk-beta')), true, '只删点名的那一条')
  } finally {
    await fiber.dispose?.()
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})


