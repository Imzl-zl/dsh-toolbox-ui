// 安装目标（skillTargets）：把「可以装到哪里」这件事钉住。
//
// 背景（用户的原话：「用户没有选择的权力？」）：面板原来的「安装到」候选来自**实际发现**
// （约束 12），于是「想装到 `~/.dsh/skills`，但那里还没建」和「想给还没建技能目录的项目装一份」
// 这两种需求都无处可选。观察 ≠ 能力：能不能装，必须来自宿主支持的**全部**位置。
//
// 这一层的真值来自 `@deepseek-ai/dsh-skill-filesystem` 的 `roots(cwd)`（随宿主发布，
// 从宿主 app.asar 里核过）。本插件照抄那份规则，并从 loader 树里读**它真正在用的 config**。
// provider 改算法时这里要一起改——下面这些用例钉的是**语义**（rank、路径形状、只读性、
// 项目根怎么找、DSH_HOME 怎么解析），而不是内部实现。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { listSkillViews, resolveSkillReference, resolveTargetReference, skillTargetsView } from '../lib/skills-registry.js'

const PROVIDER = '@deepseek-ai/dsh-skill-filesystem'

/** 造一个 loader 替身：provider 条目带着它的 config（真值就从这里取）。 */
const ctxWith = (config) => ({
  loader: { entries: () => [{ options: { name: PROVIDER, config } }] },
})

const tempRoot = () => mkdtemp(join(tmpdir(), 'dsh-skill-targets-'))

test('loader 的 Generator 保留自定义位置，并忽略已禁用的 provider', { timeout: 60_000 }, async (t) => {
  const base = await tempRoot()
  t.after(() => rm(base, { recursive: true, force: true }))
  const custom = join(base, 'custom')
  const config = { includeDefaultRoots: false, customSkillDirs: [custom] }
  const ctx = { loader: { *entries() {
    yield { disabled: true, options: { name: PROVIDER, config: { customSkillDirs: [join(base, 'inactive')] } } }
    yield { options: { name: PROVIDER, config } }
  } } }
  const { targets } = await skillTargetsView(ctx)
  assert.deepEqual(targets.map(({ source, root }) => ({ source, root })), [{ source: 'custom', root: custom }])
  assert.deepEqual(await resolveTargetReference(ctx, targets[0]), targets[0], '目标引用重新核对时仍能消费新 Generator')
})

test('真实 loader 与 provider 的表达式 custom root 能从列表解析到可操作引用', { timeout: 60_000 }, async (t) => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const base = await tempRoot()
  t.after(() => rm(base, { recursive: true, force: true }))
  const custom = join(base, 'custom')
  await mkdir(join(custom, 'disk-entry'), { recursive: true })
  await writeFile(join(custom, 'disk-entry', 'SKILL.md'), '---\nname: custom-probe\ndescription: custom root probe\n---\n\ncustom body\n')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve('package.json')).href })
  await ctx.plugin(SkillRegistry)
  const entryId = await ctx.loader.create({
    id: 'custom-skills', name: PROVIDER,
    config: { includeDefaultRoots: false, customSkillDirs: [{ __jsExpr: JSON.stringify(custom) }], watch: false },
  })
  const entry = [...ctx.loader.entries()].find((candidate) => candidate.options.id === entryId)
  assert.equal(Array.isArray(ctx.loader.entries()), false, '正式 loader 的枚举不是数组')
  assert.equal(typeof entry.options.config.customSkillDirs[0], 'object', '原始配置仍保留表达式')
  const rows = await listSkillViews(ctx)
  assert.equal(rows.length, 1)
  const [row] = rows
  const { targets } = await skillTargetsView(ctx)
  assert.deepEqual(targets.map((target) => target.root), [row.root], '安装位置使用 provider 真正收到的生效配置')
  assert.equal(row.root, custom)
  const target = await resolveTargetReference(ctx, { source: row.source, root: row.root })
  assert.equal(target.root, row.root)
  const reference = await resolveSkillReference(ctx, row)
  assert.equal(reference.entry, row.entry)
  assert.equal(reference.path, row.path)
  await assert.rejects(() => resolveTargetReference(ctx, { source: 'custom', root: base }), /未知的技能目标/)
})

test('六档位置都列出来，并按宿主 rank 排序', async () => {
  const base = await tempRoot()
  const dshHome = join(base, 'dsh-home')
  const agentsHome = join(base, 'agents-home')
  const custom = join(base, 'custom-skills')
  const bundled = join(base, 'bundled-skills')
  await mkdir(custom, { recursive: true })
  await mkdir(bundled, { recursive: true })

  const project = join(base, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, 'packages', 'inner'), { recursive: true })

  const { targets } = await skillTargetsView(
    ctxWith({ dshHome, agentsHome, customSkillDirs: [custom], bundledSkillDir: bundled }),
    // 工作区给的是子目录：项目根必须往上找到 .git 那一层
    { workspaces: [join(project, 'packages', 'inner')] },
  )

  assert.deepEqual(targets.map((t) => t.source), [
    'project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled',
  ])
  assert.deepEqual(targets.map((t) => t.rank), [100, 200, 300, 400, 500, 600])
  const bySource = Object.fromEntries(targets.map((t) => [t.source, t]))
  assert.equal(bySource['project-dsh'].root, join(project, '.dsh', 'skills'), '项目根要往上找到 .git 那一层')
  assert.equal(bySource['project-agents'].root, join(project, '.agents', 'skills'))
  assert.equal(bySource['project-dsh'].projectRoot, project)
  assert.equal(bySource['project-dsh'].projectPath, join(project, 'packages', 'inner'), '保留原始工作区路径用于显示项目名')
  assert.equal(bySource['user-dsh'].root, join(dshHome, 'skills'))
  assert.equal(bySource['user-agents'].root, join(agentsHome, 'skills'))
  assert.equal(bySource.custom.root, custom)
  assert.equal(bySource.bundled.root, bundled)
})

test('还没建的位置照样列出来，并标 exists=false', async () => {
  const base = await tempRoot()
  const { targets } = await skillTargetsView(
    ctxWith({ dshHome: join(base, 'nothing-here'), agentsHome: join(base, 'nor-here'), bundledSkillDir: join(base, 'bundled') }),
    { workspaces: [] },
  )
  const bySource = Object.fromEntries(targets.map((t) => [t.source, t]))
  assert.equal(bySource['user-dsh'].exists, false, '目录不存在也要列出来（这正是「想用 .dsh/skills」的场景）')
  assert.equal(bySource['user-agents'].exists, false)
  // 对照：存在的目录要标 true，否则面板会把已经能用的位置说成「将创建」。
  const existing = await tempRoot()
  await mkdir(join(existing, 'skills'), { recursive: true })   // 根是 <home>/skills，不是 <home>
  const second = await skillTargetsView(ctxWith({ dshHome: existing, agentsHome: existing }), { workspaces: [] })
  const userDsh = second.targets.find((t) => t.source === 'user-dsh')
  assert.equal(userDsh.exists, true)
})

test('bundled 只读，其余可写', async () => {
  const base = await tempRoot()
  // ⚠️ 两个 home 必须**不同目录**：写成同一个 base 会让 user-dsh 与 user-agents 的根
  // （都是 `<home>/skills`）变成同一个物理目录，而那正是「同一目录被列两次」的缺陷形状——
  // skillTargetsView 现在会（正确地）把它们合成一项，于是这里就取不到 user-agents 了。
  const { targets } = await skillTargetsView(
    ctxWith({ dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), bundledSkillDir: join(base, 'bundled') }),
    { workspaces: [] },
  )
  const bySource = Object.fromEntries(targets.map((t) => [t.source, t]))
  assert.equal(bySource.bundled.writable, false, 'bundled 随包发布，装进去会被升级覆盖')
  for (const source of ['user-dsh', 'user-agents']) assert.equal(bySource[source].writable, true)
  assert.equal(bySource['user-dsh'].scope, 'global')
})

test('同一个物理目录只列一次（DSH_HOME 与工作区重合时）', async () => {
  // ⚠️ 真机缺陷（issue #5，2026-10-11 复现）：`DSH_HOME=D:\DSH\.dsh` 而工作区 `D:\DSH`
  // 本身是 git 根 → project-dsh 根 = `<DSH_HOME>/skills` = user-dsh 根，**同一个物理目录**。
  // 不去重的话安装下拉里同一个位置出现两次（一个写「项目 DSH」、一个写「全局」），
  // 用户以为有两个落点可选。留 rank 更前的那份——rank 决定宿主优先采纳哪个根。
  const base = await tempRoot()
  const dshHome = join(base, 'dsh-home')
  const project = join(base, 'proj')
  // 项目根与 DSH_HOME 重合：`.dsh/skills` 两边算出来是同一个目录。
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh', 'skills'), { recursive: true })

  const { targets } = await skillTargetsView(
    ctxWith({ dshHome: join(project, '.dsh'), agentsHome: join(base, 'agents-home') }),
    { workspaces: [project] },
  )
  const skillsRoot = join(project, '.dsh', 'skills')
  const same = targets.filter((target) => target.root === skillsRoot)
  assert.equal(same.length, 1, `同一个物理目录只能列一次，实际：${JSON.stringify(same.map((t) => t.source))}`)
  assert.equal(same[0].source, 'project-dsh', '留 rank 更小（宿主优先采纳）的那份')
  assert.equal(same[0].rank, 100)

  // 对照：两个 home 真的是不同目录时，两档都还在（别把去重做成了误杀）。
  const { targets: separate } = await skillTargetsView(
    ctxWith({ dshHome: join(base, 'dsh-a'), agentsHome: join(base, 'dsh-b') }),
    { workspaces: [] },
  )
  assert.equal(separate.filter((t) => t.root === join(base, 'dsh-a', 'skills')).length, 1)
  assert.equal(separate.filter((t) => t.root === join(base, 'dsh-b', 'skills')).length, 1)
})

test('includeDefaultRoots=false 时不列默认位置（与 provider 的 roots 一致）', async () => {
  const base = await tempRoot()
  const custom = join(base, 'only-custom')
  const { targets } = await skillTargetsView(
    ctxWith({ includeDefaultRoots: false, dshHome: base, agentsHome: base, customSkillDirs: [custom], bundledSkillDir: join(base, 'b') }),
    { workspaces: [base] },
  )
  assert.deepEqual(targets.map((t) => t.source), ['custom', 'bundled'],
    '关掉默认根之后只剩自定义目录与内置目录——不能因为「我们觉得应该有」就补上')
})

test('DSH_HOME 走环境变量（与 dsh-home-paths 的 resolveDshHome 同语义）', async () => {
  const previous = process.env.DSH_HOME
  const base = await tempRoot()
  process.env.DSH_HOME = base
  try {
    // config 不给 dshHome → 应该取 DSH_HOME
    const { targets } = await skillTargetsView(ctxWith({ agentsHome: base }), { workspaces: [] })
    assert.equal(targets.find((t) => t.source === 'user-dsh').root, join(base, 'skills'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  // 没有配置也没有环境变量时退回 ~/.dsh（绝不写死某个磁盘路径）。
  // 这里必须**真的**把 DSH_HOME 摘掉：CI 会全局导出 DSH_HOME，断言却写着"没有环境变量"，
  // 不摘就是拿环境当结论（本机跑绿、CI 红，或反过来）。
  const savedHome = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    const { targets: fallback } = await skillTargetsView({ loader: { entries: () => [] } }, { workspaces: [] })
    const userDsh = fallback.find((t) => t.source === 'user-dsh')
    if (userDsh) assert.equal(userDsh.root, resolve(join(homedir(), '.dsh', 'skills')))
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
})

test('同一个项目根只列一次，且不因找不到 provider 条目而失败', async () => {
  const base = await tempRoot()
  const project = join(base, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  // 两个工作区指向同一个项目（子目录 + 根）→ 项目位置只该出现一次
  const { targets } = await skillTargetsView(ctxWith({ dshHome: base, agentsHome: base }), {
    workspaces: [project, join(project, 'sub')],
  })
  assert.equal(targets.filter((t) => t.source === 'project-dsh').length, 1)
  assert.equal(targets.filter((t) => t.source === 'project-agents').length, 1)

  // loader 树里没有 provider 条目（旧宿主/替身）：退回环境变量与默认值，不抛。
  const { targets: bare } = await skillTargetsView(undefined, { workspaces: [] })
  assert.ok(Array.isArray(bare))
  assert.equal(bare.some((t) => t.source === 'user-agents'), true)
})
