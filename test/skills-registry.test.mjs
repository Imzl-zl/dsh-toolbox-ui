// 宿主侧 skills 读取层：把 ctx.skills 的目录投影成面板要的形状。
//
// 这一层不写盘。**唯一的读盘**是「这一行的调用权限」——它必须来自技能文件本身（宿主的 summary
// 是发现缓存，会滞后），所以那些字段在假路径下就是 null（不知道，见本文件最后一条用例）；
// 其余投影仍是纯函数，用手搓 ctx 即可测（沿用 workspace-host.test.mjs 的 createHostFixture 手法）。
//
// 关键设计约束（见 .tasks/toolbox-ui/SPEC.md 约束 12/13）：
//   - 不传 cwd 时宿主只给用户级/自定义/bundled 技能；项目技能必须显式传 cwd。
//     故「列出全部作用域」必须对每个工作区各查一次再合并。
//   - 宿主返回的 source 是唯一可靠的作用域依据（本机 ~/.dsh/skills 就不存在，
//     技能都在 ~/.agents/skills），UI 不得写死根路径。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { listSkillViews } from '../lib/skills-registry.js'

/** 只看路径的目录部分（断言「两个字段确实分叉」用）。 */
const dirnameOf = (path) => dirname(path)

/** 手搓一个只实现 list/get/snapshot 的 skills 服务替身。 */
function fakeSkills(byCwd) {
  const calls = []
  return {
    calls,
    async list(options = {}) {
      calls.push(options)
      return byCwd[options.cwd ?? ''] ?? []
    },
    async get(name, options = {}) {
      const found = (byCwd[options.cwd ?? ''] ?? []).find((skill) => skill.name === name)
      return found === undefined ? undefined : { ...found, content: 'body of ' + name }
    },
    async snapshot(options = {}) {
      return { skills: await this.list(options), complete: true }
    },
  }
}

const skill = (over = {}) => ({
  name: 'zhanggui',
  description: '端到端拥有一个开发请求',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'user-agents',
  provider: 'filesystem',
  path: '/home/u/.agents/skills/zhanggui/SKILL.md',
  ...over,
})

function ctxWith(skills) {
  return { get: (name) => (name === 'skills' ? skills : undefined) }
}

test('does not duplicate global skills when a project query returns the merged view', async () => {
  // 宿主在传 cwd 时返回的是「项目根 + 用户根 + bundled」的**完整合并视图**——
  // provider 的 roots(cwd) 把项目根 push 进 cwd 分支，而用户根与 bundled 根的 push
  // 在该分支之外无条件执行（dsh-skill-filesystem/lib/index.js）。
  // 所以项目查询的结果里**已经包含**全局技能；直接 concat 会让全局技能在每个项目里
  // 各重复一份。面板必须只取该项目真正新增的那些。
  const globalSkill = skill()
  const projectSkill = skill({ name: 'proj-only', source: 'project-dsh' })
  const skills = fakeSkills({
    '': [globalSkill],
    '/proj/a': [globalSkill, projectSkill], // ← 宿主的真实形状：合并视图
  })
  const rows = await listSkillViews(ctxWith(skills), { workspaces: ['/proj/a'] })

  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    ['proj-only', 'zhanggui'],
    '全局技能不得因为项目查询也返回它而重复出现',
  )
  assert.equal(rows.filter((row) => row.name === 'zhanggui').length, 1)
})

test('lists every scope by querying once per workspace plus the unscoped root', async () => {
  // 不传 cwd 只有用户级技能；项目技能必须显式传该项目 cwd —— 这正是宿主 provider
  // 的 roots(cwd) 行为（includeDefaultRoots && cwd !== void 0 才加入项目根）。
  const skills = fakeSkills({
    '': [skill()],
    '/proj/a': [skill({ name: 'proj-only', source: 'project-dsh' })],
  })
  const rows = await listSkillViews(ctxWith(skills), { workspaces: ['/proj/a'] })

  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    ['proj-only', 'zhanggui'],
  )
  // 两个作用域各查一次：一次无 cwd、一次带项目 cwd。
  assert.deepEqual(skills.calls.map((call) => call.cwd), [undefined, '/proj/a'])
})

test('keeps same-named skills from different scopes as separate rows', async () => {
  // 同名跨作用域必须能区分：DSH 自己按 rank 裁决谁生效，但面板要能分别操作。
  const skills = fakeSkills({
    '': [skill()],
    '/proj/a': [skill({ source: 'project-dsh', path: '/proj/a/.dsh/skills/zhanggui/SKILL.md' })],
  })
  const rows = await listSkillViews(ctxWith(skills), { workspaces: ['/proj/a'] })

  const zhanggui = rows.filter((row) => row.name === 'zhanggui')
  assert.equal(zhanggui.length, 2, '同名跨作用域必须各占一行，不能合并')
  assert.deepEqual(
    zhanggui.map((row) => row.scope).sort(),
    ['global', 'project'],
  )
})

test('reports the scope and rank from the host source rather than guessing a path', async () => {
  // 本机实测 ~/.dsh/skills(rank 400) 不存在、技能都在 ~/.agents/skills(rank 500)，
  // 所以「全局」不等于某个写死的路径——必须照实投影 source。
  const skills = fakeSkills({ '': [skill({ source: 'user-dsh' }), skill({ name: 'b', source: 'bundled' })] })
  const rows = await listSkillViews(ctxWith(skills), {})

  assert.equal(rows.find((row) => row.name === 'zhanggui').source, 'user-dsh')
  assert.equal(rows.find((row) => row.name === 'b').source, 'bundled')
  assert.equal(rows.every((row) => row.scope === 'global'), true)
})

test('derives the skill root from the host resourceBase, for both skill shapes', async () => {
  // 启停/删除/导入都要按 (根, 条目) 精确定位，而 **ctx.skills 不暴露 roots()**
  // （实测：公开方法只有 registerProvider/register/list/snapshot/get/collect/... ）。
  //
  // 判别依据是宿主的 locator **构造规则**（dsh-skill-filesystem 的 discoverRoot）：
  //   目录捆绑：locator.path = <技能目录>/SKILL.md，locator.directory = <技能目录>
  //   扁平文件：locator.path = <根>/<条目>.md，    locator.directory = <根>
  // 也就是**形态由 path 的末段决定**（SKILL.md vs *.md），**根由 resourceBase 决定**。
  //
  // ⚠️ 扁平那条**必须落在真文件系统上**：它的条目是「在根下按 realpath 匹配宿主报的 path」
  // 查出来的（见 locateSkill / matchFlatEntry），手搓一对假路径时查不到、只能落进字面兜底，
  // 于是用例测的是兜底而不是主路径。真实文件才表达得出宿主的形状。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-shapes-'))
  const root = join(base, 'skills')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'flat-skill.md'), '---\nname: flat-skill\ndescription: 扁平\n---\n\n正文\n')
  try {
    const realFlat = await realpath(join(root, 'flat-skill.md'))
    const skills = fakeSkills({
      '': [
        skill({
          name: 'bundle-skill',
          // 目录捆绑：path 指向别人的外部库（realpath），resourceBase 是发现路径
          path: '/elsewhere/external/bundle-skill/SKILL.md',
          resourceBase: { kind: 'directory', path: '/u/.agents/skills/bundle-skill' },
        }),
        skill({
          name: 'flat-skill',
          // 扁平：真实文件 + 宿主真实的字段形状（path 是 realpath、resourceBase 是根）
          path: realFlat,
          resourceBase: { kind: 'directory', path: root },
        }),
      ],
    })
    const rows = await listSkillViews(ctxWith(skills), {})

    const bundle = rows.find((row) => row.name === 'bundle-skill')
    assert.equal(bundle.root, '/u/.agents/skills', '目录捆绑：根是其技能目录的父目录')
    assert.equal(bundle.kind, 'bundle')
    assert.equal(bundle.entry, 'bundle-skill', '目录捆绑的条目是资源基目录的末段（= 磁盘目录名）')

    const flat = rows.find((row) => row.name === 'flat-skill')
    assert.equal(flat.root, root, '扁平文件：根就是 resourceBase 自身')
    assert.equal(flat.kind, 'flat')
    assert.equal(flat.entry, 'flat-skill.md', '扁平的条目是根下那个文件名')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a flat skill whose file name differs from its frontmatter name still resolves', async () => {
  // 宿主**允许**扁平技能的文件名与 frontmatter 里的 `name` 不一致：技能名来自 frontmatter，
  // 文件名只承载它。`locateSkill` 曾按「文件名 === `<name>.md`」判别形态，于是这种技能定位不到
  // 根、整行不可操作（启停/删除都无从下手）。现在的判据是宿主的真实规则：末段以 `.md` 结尾
  // 就是扁平，与技能名无关；目录捆绑固定是 `<目录>/SKILL.md`。
  //
  // 这个坑的来源值得记住：宿主自己的测试助手（`writeFlatSkill`）**总是**写 `` `${name}.md` ``，
  // 所以它的用例里根本没有这种形状——拿测试的假设当契约就会漏掉真实契约。
  // 本用例的存在就是那条修复的**回归网**（修复本身早已在 lib 里，曾只缺这条用例）。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-name-mismatch-'))
  const root = join(base, 'skills')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'file-name.md'), '---\nname: skill-name\ndescription: 名字不一致\n---\n\n正文\n')
  try {
    const skills = fakeSkills({
      '': [
        skill({
          name: 'skill-name',
          path: await realpath(join(root, 'file-name.md')),
          resourceBase: { kind: 'directory', path: root },
        }),
      ],
    })
    const [row] = await listSkillViews(ctxWith(skills), {})
    assert.equal(row.kind, 'flat', '名字不一致不影响形态判别')
    assert.equal(row.root, root, '根来自 resourceBase，不是从 path 反推的')
    assert.equal(row.entry, 'file-name.md', '条目是磁盘上的真实文件名，不是技能名')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('resolves the root when the skill directory is a link (the two host fields disagree)', async () => {
  // ⚠️ 真机缺陷（issue #5，2026-10-11 复现）：技能目录本身是符号链接/junction 时，
  // 面板那一行显示「位置（未报告）/调用权限未知」，悬浮提示还冤枉 frontmatter。
  //
  // 根因是两个字段来自**不同的路径口径**（宿主源码，已核对）：
  //   resourceBase.path = locator.directory      —— 展示路径（配置原样，链接就是链接）
  //   path              = fs.processPath(target) —— realpath（fs-local 里就是 targetKey）
  // 链接目录下两者必然分叉，字面比较落进「形态不认识」→ 根推不出来 → 整行不可操作。
  // 宿主自己的用例也钉着这个分叉（skill-filesystem.spec.ts 的 linked-dir 那条）。
  //
  // 这条用**真实文件系统语义**（真建链接目录 + 真 realpath），不是手搓字符串——
  // 手搓一对「看起来像」的路径证明不了 realpath 之后它们会相等。
  //
  // Windows 上真正的 file symlink 需要特权（实测 EPERM），而目录 junction 不需要；
  // POSIX 上 type 参数被忽略，建的是普通符号链接（与 skills-file-ops.test.mjs 同一手法）。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-link-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-skills-ext-'))
  const root = join(base, '.dsh', 'skills')
  await mkdir(root, { recursive: true })
  await mkdir(join(external, 'linked-skill'), { recursive: true })
  await writeFile(
    join(external, 'linked-skill', 'SKILL.md'),
    '---\nname: linked-skill\ndescription: 链接技能\n---\n\n正文\n',
  )
  try {
    await symlink(join(external, 'linked-skill'), join(root, 'linked-skill'), 'junction')
  } catch (error) {
    // 环境连 junction 都不给建：这条用例无法表达它的意图，明说而不是静默放过。
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
    throw new Error(`本环境无法创建链接（${error.code}），该用例未能执行`)
  }
  try {
    const displayBase = join(root, 'linked-skill')
    const realFile = await realpath(join(displayBase, 'SKILL.md'))
    // 前提：磁盘上文件确实存在且宿主的两个字段确实分叉（否则这条用例测不到东西）。
    assert.notEqual(displayBase, await realpath(displayBase), '前提：该技能目录确实是链接')

    const skills = fakeSkills({
      '': [skill({
        name: 'linked-skill',
        // 宿主真实的形状：base 是展示路径，path 是 realpath。
        resourceBase: { kind: 'directory', path: displayBase },
        path: realFile,
      })],
    })
    const [row] = await listSkillViews(ctxWith(skills), {})

    assert.equal(row.root, root, '链接目录下根必须推得出来，且用**展示路径**（要喂给 fs、也要与目标集合对上）')
    assert.equal(row.kind, 'bundle')
    // 这一行必须真的可操作：调用权限来自文件本身，读得到就不是 null。
    assert.equal(row.modelInvocable, true, '根定位到之后，调用权限要从文件里读出来，不能再是「未知」')
    assert.equal(row.userInvocable, true)
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('one physical skill file is one row, even when two roots resolve to the same directory', async () => {
  // ⚠️ 真机缺陷（issue #5，2026-10-11 复现）：`DSH_HOME=D:\DSH\.dsh` 而工作区 `D:\DSH`
  // 本身是 git 根，于是 project-dsh 的根 = `<DSH_HOME>/skills` = user-dsh 的根——同一个物理
  // 目录被两种 source 各报一份。实测同一个文件被列成 N+1 行（全局 1 + 每个工作区 1），
  // 名字相同 → 面板互判「被遮蔽」，用户看到一整份重复的技能。
  //
  // 去重判据必须是**物理位置**（宿主给的 path 就是 realpath），不是字符串也不只是 source。
  const skills = fakeSkills({
    '': [skill({ name: 'decision-notes', path: 'D:/DSH/.dsh/skills/decision-notes/SKILL.md' })],
    // 项目查询返回合并视图；同一个文件在这里被换了个 source 再报一次。
    'D:/DSH': [skill({ name: 'decision-notes', source: 'project-dsh', path: 'D:/DSH/.dsh/skills/decision-notes/SKILL.md' })],
    'D:/DSH/temp': [skill({ name: 'decision-notes', source: 'project-dsh', path: 'D:/DSH/.dsh/skills/decision-notes/SKILL.md' })],
  })
  const rows = await listSkillViews(ctxWith(skills), { workspaces: ['D:/DSH', 'D:/DSH/temp'] })

  const same = rows.filter((row) => row.name === 'decision-notes')
  assert.equal(same.length, 1, '同一个物理文件只能占一行（原先会出 3 行）')
  // 留下的是 rank 更前的那份：它才是宿主实际采纳、模型真正收到的条目。
  assert.equal(same[0].source, 'project-dsh', '同一文件两处报时，留 rank 更小（真正生效）的那份')
})

test('keeps same-named skills in different roots as separate rows (real shadowing)', async () => {
  // 与上一条成对：**不同文件**的同名技能是真实的跨作用域遮蔽，必须各占一行。
  // 去重如果按名字做，就会把用户真装了的那份藏起来（这正是 SPEC 约束 12 的边界）。
  const skills = fakeSkills({
    '': [skill({ name: 'zhanggui', path: 'C:/u/.agents/skills/zhanggui/SKILL.md' })],
    'C:/proj': [skill({ name: 'zhanggui', source: 'project-dsh', path: 'C:/proj/.dsh/skills/zhanggui/SKILL.md' })],
  })
  const rows = await listSkillViews(ctxWith(skills), { workspaces: ['C:/proj'] })

  assert.equal(rows.filter((row) => row.name === 'zhanggui').length, 2, '不同根里的同名技能必须各占一行')
  assert.deepEqual(rows.map((row) => row.scope).sort(), ['global', 'project'])
})

test('locates a flat skill whose reported path is outside the root (only a root scan can name it)', async () => {
  // ⚠️ 宿主的两种 locator 都可能被链接打断。对**扁平**技能，后果最重的一种是：
  // 宿主报的 `path` 是 realpath，而 `resourceBase.path` 是**展示路径**——两者不在同一棵树下，
  // 所以任何「realpath 规范化后做路径前缀比较」的实现都判不出来（前一版就栽在这里）。
  //
  // 构造：把**技能根本身**做成 junction（本机可建），根里的 `flat-one.md` 因此
  //   resourceBase.path = <base>/skills      （展示路径，junction）
  //   path              = <external>/skills/flat-one.md （realpath）
  // 于是 `dirname(path) !== base` **字面上就不等**——字面兜底必然失败，
  // 只有「在根下扫一遍、按 realpath 匹配」才能给出那个条目名。
  // 这正是宿主 linked-flat 用例（skill-filesystem.spec.ts:449-458）所依赖的同一条路径。
  //
  // ⚠️ 本机建不了 **file** symlink（实测 EPERM，连 `mklink` 都要特权），所以「链接名 != 目标名」
  // 那种变体（宿主 spec:457-458 的 replacement.md）无法在此构造。它与本条走的是**同一段代码**
  // ——两者都表现为「path 的目录部分 != 根」——所以这里用可构造的等价形状覆盖它，
  // 而不是留一条跑不到的断言假装覆盖了。
  const base = await mkdtemp(join(tmpdir(), 'dsh-skills-linkflat-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-skills-linkflat-ext-'))
  const root = join(base, 'skills')
  const realRoot = join(external, 'skills')
  await mkdir(realRoot, { recursive: true })
  await writeFile(join(realRoot, 'flat-one.md'), '---\nname: flat-one\ndescription: 扁平\n---\n\n正文\n')
  try {
    await symlink(realRoot, root, 'junction')
  } catch (error) {
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
    throw new Error(`本环境无法创建链接（${error.code}），该用例未能执行`)
  }
  try {
    const reportedPath = await realpath(join(root, 'flat-one.md'))
    // 前提：宿主的两个字段确实分叉（否则这条用例测不到东西）。
    assert.notEqual(dirnameOf(reportedPath), root, '前提：path 的目录部分与展示根不同（根是链接）')

    const skills = fakeSkills({
      '': [skill({
        name: 'flat-one',
        path: reportedPath,                              // realpath：在外部库那棵树下
        resourceBase: { kind: 'directory', path: root },  // 展示路径：技能根（junction）
      })],
    })
    const [row] = await listSkillViews(ctxWith(skills), {})

    assert.equal(row.kind, 'flat', '末段是 *.md → 扁平形态（与它在不在外部库无关）')
    assert.equal(row.root, root, '根来自 resourceBase（展示路径），不是从 path 反推的')
    // ⚠️ 关键：条目必须**扫出来的**，不是拿 path 的末段顶替。
    // 这里 path 的末段与根下那个名字恰好相同，所以光比字符串分不出两者——
    // 用一个**根下不存在的名字**当 path 的末段才能真正分开（宿主在 linked-flat 里就是这么给的：
    // 链接叫 link-name.md，而它指向的 real-name.md 在外部库）。见下一条断言。
    assert.equal(row.entry, 'flat-one.md', '条目必须是根下的那个名字，否则启停/删除无从下手')
    // 这一行必须真的可读（根定位对了才读得到）：只有根对、条目对，文件才打得开。
    assert.equal(row.modelInvocable, true, '根与条目都定位到之后，调用权限要从文件里读出来')
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('refuses to locate a flat entry the root scan cannot confirm, instead of trusting the path tail', async () => {
  // ⚠️ 这条钉的是「证明不了就不填根」这条纪律在**扁平**分支上的表现。
  //
  // 背景：扁平的条目靠「在根下扫一遍、按 realpath 匹配宿主报的 path」查出来（见 matchFlatEntry）。
  // 宿主真实会给的形状（skill-filesystem.spec.ts:449-458 的 linked-flat）是：根下那个文件叫
  // `link-name.md`，而它是**符号链接**，指向外部库的 `real-name.md`；宿主报的 path 是 realpath，
  // 末段因此是 real-name.md。那种形状下「扫出来的条目」与「path 的末段」不同，
  // 而拿后者当条目会让启停/删除作用到**根外**那个真实文件上（用户同步库里的数据）。
  //
  // ⚠️ 但那种形状**在本机构造不出来**：file symlink 是 EPERM（连 `mklink` 都要特权），
  // 而 realpath 会把大小写归一（实测），所以在本机能造出的任何形状里
  // 「匹配到的条目」与「path 的末段」恰好相等——两者不可分辨。
  // 与其写一条这里永远跑不到的分辨断言（那正是教训 1 说的「看到绿以为测到了」），
  // 这里断言**可构造的那一半**：扫不到就**不填根**，绝不拿 path 的末段顶替。
  // 拿到「条目来自扫描而非 path 末段」的直接证据需要 POSIX 或符号链接特权；
  // resolveSkillTarget 那一侧的对应守卫（条目必须是单个路径段）由 file-ops 的用例覆盖。
  const base = await mkdtemp(join(tmpdir(), 'dsh-flat-unconfirmed-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-flat-unconfirmed-ext-'))
  const root = join(base, 'skills')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'link-name.md'), '---\nname: flat-one\ndescription: 扁平\n---\n\n正文\n')
  await writeFile(join(external, 'real-name.md'), '---\nname: flat-one\ndescription: 外部那份\n---\n\n正文\n')
  try {
    const skills = fakeSkills({
      '': [skill({
        name: 'flat-one',
        // path 指向根外（模拟「它是链接、宿主报的是目标 realpath」这一半条件）
        path: join(external, 'real-name.md'),
        resourceBase: { kind: 'directory', path: root },
      })],
    })
    const [row] = await listSkillViews(ctxWith(skills), {})
    assert.equal(row.root, undefined,
      '扫盘无法证实这个文件在根下时，必须不填根（拿 path 末段顶替会让操作打到根外的真实文件上）')
    assert.equal(row.kind, undefined, '形态同样不填')
    assert.equal(row.modelInvocable, null, '定位不到就读不出权限——说「不知道」，不编一个值')
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('omits the root rather than guessing when the host gives no resourceBase', async () => {
  // 推不出根就**不填**，留给上层报错。猜一个根会让启停/删除作用在错误的目录上——
  // 那正是本层最危险的失败模式（误删用户的技能）。
  const skills = fakeSkills({ '': [skill({ resourceBase: undefined })] })
  const [row] = await listSkillViews(ctxWith(skills), {})
  assert.equal(row.root, undefined, '无 resourceBase 时不得猜一个根目录')
})

test('omits the root when the path shape matches neither known host locator', async () => {
  // ⚠️ 这条与上一条**必须都在**：上一条走的是「没有 resourceBase」的早退分支，
  // 根本到不了最后的「不猜」兜底。变异测试证明：只留上一条时，把兜底改成
  // `return { root: base }` 也能全绿——也就是「推不出就别猜」这条纪律其实没被测到。
  // 这里给一个**有 resourceBase 但形态不匹配**的输入，专门走到兜底分支。
  const skills = fakeSkills({
    '': [skill({
      name: 'weird',
      path: '/u/.agents/skills/some/deep/nested.md',
      resourceBase: { kind: 'directory', path: '/u/.agents/skills' },
    })],
  })
  const [row] = await listSkillViews(ctxWith(skills), {})
  assert.equal(row.root, undefined, '形态不认识时必须不填根，而不是套用 base')
  assert.equal(row.kind, undefined, '形态不认识时也不得填 kind')
})

test('the invocation policy comes from the skill file, so a host summary alone cannot decide it', async () => {
  // 面板要能区分「模型可调用 / 仅用户可调用」，但**真值不在宿主 summary 里**：那是发现缓存
  // （同一个文件改写后它继续报旧值，见 test/skills-host.test.mjs 的两条用例）。这里刻意给一个
  // 声称「模型不可调用」的 summary，而磁盘上并不存在这个文件（/home/u 是假路径）——行必须说
  // 「不知道」，而不是照抄 summary 的说法。正值方向（真的从文件里读出策略）由宿主用例钉住。
  const skills = fakeSkills({
    '': [skill({ invocation: { modelInvocable: false, userInvocable: true } })],
  })
  const [row] = await listSkillViews(ctxWith(skills), {})
  assert.equal(row.modelInvocable, null, 'summary 不是真值来源：读不到文件就说不知道')
  assert.equal(row.userInvocable, null)
})

test('degrades to an empty list when no skills service is mounted', async () => {
  // 宿主可能没挂 dsh-skill（用户可禁用该内置插件）。读取层不得因此抛错——
  // 抛错会让整个面板打不开，而降级为空列表只影响技能这一块。
  const rows = await listSkillViews({ get: () => undefined }, { workspaces: [] })
  assert.deepEqual(rows, [])
})

test('reads through the default Agent preset scope, so user skills are visible', async () => {
  // ⚠️ 这条抓的是一个**真机缺陷**（装上后技能列表只剩 1 个内置技能）：
  //   宿主 dsh-web-app **有意**把基础行 skill-filesystem 置为 disabled，改由每个 agent
  //   preset 各挂一份，于是文件系统 provider 注册进的是 **preset 的作用域层**；
  //   而 dsh-skill 的注册表按层合并（全局层 + 查看作用域链）。本插件的 RPC 跑在宿主层，
  //   不传 scope 时**只看得到 bundled 那一个**，用户装在 ~/.agents/skills 的全部不可见。
  //
  // 宿主的官方读法（dsh-api-session-controller 的 sessionSkillCatalog）就是借默认 preset
  // 的作用域：`agentPresets.acquireScope()` → `skills.list({ cwd, scope: lease.key })`。
  // 它的文档写着 “Resolve a live or standing preset scope **without creating an Agent**”，
  // 所以这不违反 SPEC 约束 14（面板不得依赖活动会话）。
  const seen = []
  const scopeKey = { preset: 'standard' }
  const skills = {
    async list(options = {}) {
      seen.push(options)
      // 模拟宿主的分层：只有带 scope 的读取才看得到 preset 层注册的用户技能。
      return options.scope === scopeKey ? [skill()] : [skill({ name: 'bundled-only', source: 'bundled' })]
    },
    async get() { return undefined },
  }
  let disposed = 0
  const ctx = {
    get(name) {
      if (name === 'skills') return skills
      if (name === 'agentPresets') {
        return {
          async acquireScope(id) {
            assert.equal(id, undefined, '不传 id 时宿主用 defaultId（当前默认 preset）')
            return {
              key: scopeKey,
              async [Symbol.asyncDispose]() { disposed += 1 },
            }
          },
        }
      }
      return undefined
    },
  }

  const rows = await listSkillViews(ctx, { workspaces: [] })

  assert.deepEqual(rows.map((row) => row.name), ['zhanggui'],
    '不带 preset 作用域时只能读到 bundled；带上才读得到用户技能')
  assert.ok(seen.length > 0 && seen.every((options) => options.scope === scopeKey),
    '每次 skills.list 都必须带上 preset 作用域，否则用户技能不可见')
  assert.equal(disposed, 1, '租约必须释放（宿主内部有 users 计数，不释放会留住那一代）')
})

test('releases the preset lease even when the catalog read throws', async () => {
  // 租约不释放会留住 preset 的那一代注册；读取失败时更不能漏。
  let disposed = 0
  const scopeKey = { preset: 'standard' }
  const ctx = {
    get(name) {
      if (name === 'skills') return { async list() { throw new Error('host exploded') } }
      if (name === 'agentPresets') {
        return { async acquireScope() { return { key: scopeKey, async [Symbol.asyncDispose]() { disposed += 1 } } } }
      }
      return undefined
    },
  }
  await assert.rejects(() => listSkillViews(ctx, { workspaces: [] }), /host exploded/)
  assert.equal(disposed, 1, '读取抛错时也必须释放租约')
})

test('falls back to the global read when no preset registry is present', async () => {
  // 旧宿主 / 没装 preset 注册表的部署：拿不到作用域不是错误，退回原来的全局读取。
  const seen = []
  const skills = {
    async list(options = {}) { seen.push(options); return [skill({ source: 'bundled' })] },
    async get() { return undefined },
  }
  const rows = await listSkillViews(ctxWith(skills), { workspaces: [] })
  assert.equal(rows.length, 1)
  assert.ok(seen.every((options) => options.scope === undefined), '拿不到就退化为不带 scope 的读取')
})

test('a broken preset registry does not break the skills pane', async () => {
  // preset 未注册/损坏时宿主会抛（agent-preset/not-found / invalid）。技能面必须仍然可用，
  // 只是少了 preset 层的技能——不能让整个面板因此打不开。
  const skills = { async list() { return [skill({ source: 'bundled' })] }, async get() { return undefined } }
  const ctx = {
    get(name) {
      if (name === 'skills') return skills
      if (name === 'agentPresets') return { async acquireScope() { throw new Error('agent-preset/not-found') } }
      return undefined
    },
  }
  const rows = await listSkillViews(ctx, { workspaces: [] })
  assert.equal(rows.length, 1, 'preset 取不到时退回全局读取，而不是抛错')
})
