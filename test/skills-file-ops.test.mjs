// 宿主侧 skills 文件动作：启停、删除、导入、迁移扫描。
//
// 这一层**真的动用户的文件**，所以纪律比其它层严：
//   - 按 (根, 磁盘条目) 精确定位；找不到就报错，**绝不回退**到别的作用域
//     （否则同名技能会被误删/误停用）。
//   - bundled 根只读，拒绝写入。
//   - 启停写的是 frontmatter 的**两个调用面字段**（宿主原生），不搬文件。
//
// ⚠️ 定位**不按技能名**：宿主允许磁盘条目名与 frontmatter 的 name 不一致
// （实测 `dir-name/SKILL.md` 里写 `name: dir-alias` 照收），按名字拼路径会让这类技能
// 在面板里所有操作都失败。`resolveSkillTarget` 因此收 `entry`（磁盘条目名）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, truncate } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  hubSourcePath,
  importSkill,
  readHubSource,
  readSkillDocument,
  scanDisabledSkills,
  setSkillInvocationFace,
  setSkillModelInvocable,
  setSkillUserInvocable,
  writeHubSource,
  SkillNotFoundError,
  removeSkill,
  resolveSkillTarget,
  setSkillEnabled,
} from '../lib/skills-file-ops.js'
import { diagnoseSkill } from '../lib/skills-frontmatter.js'
import { MAX_ARCHIVE_BYTES, MAX_FILE_BYTES } from '../lib/skills-archive.js'
import { makeTar, makeZip } from '../scripts/archive-fixtures.mjs'

/**
 * 建一个临时技能根，含目录捆绑与扁平两种形态。
 *
 * ⚠️ 特意让其中一条技能的**磁盘条目名与 frontmatter 的 name 不一致**
 * （目录 `disk-dir/` 里写 `name: dir-alias`）：那正是真机上整行不可操作的形状
 * （宿主照收，而按名字拼路径的实现定位不到）。定位层的用例都从这里取目标。
 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
  const bundle = join(root, 'zhanggui')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), '---\nname: zhanggui\ndescription: demo\n---\n\nbody\n')
  await writeFile(join(root, 'flat-one.md'), '---\nname: flat-one\ndescription: flat demo\n---\n\nflat body\n')
  const aliased = join(root, 'disk-dir')
  await mkdir(aliased, { recursive: true })
  await writeFile(join(aliased, 'SKILL.md'), '---\nname: dir-alias\ndescription: 磁盘名与技能名不同\n---\n\nalias body\n')
  return root
}

/** 读一个技能文件里的两个调用面字段（断言「盘上真的改成了停用/启用」用）。 */
async function invocationOnDisk(path) {
  const { invocation } = await readSkillDocument({ path })
  return invocation
}

test('enable RESTORES a migration leftover by renaming it back, not by writing its fields', async () => {
  // ⚠️ 真机缺陷（本版修，审查 C2）：迁移残留的「停用」状态在**文件名**里（`.disabled`），
  // 不在 frontmatter 里。而 setSkillEnabled 现在只写字段、**从不 rename**——于是点「启用」
  // 改的是那个 `.disabled` 文件的内容，宿主永远看不见：**UI 报成功，SKILL.md 却没出现**。
  // 那是本仓库反复列为最贵的一类失败（点了没反应 + 假成功）。
  const root = await mkdtemp(join(tmpdir(), 'dsh-migrate-restore-'))
  await mkdir(join(root, 'parked'), { recursive: true })
  const body = '---\nname: parked\ndescription: 旧机制停用\ndisable-model-invocation: true\n---\n\n正文\n'
  await writeFile(join(root, 'parked', 'SKILL.md.disabled'), body)
  try {
    const target = await resolveSkillTarget({ entry: 'parked', kind: 'bundle', scope: 'global', root })
    assert.equal(target.migratedDisabled, true, '前提：定位到的是旧机制残留')
    assert.equal(target.path, join(root, 'parked', 'SKILL.md.disabled'))

    const result = await setSkillEnabled(target, true)
    assert.equal(result.changed, true)
    // ⚠️ 断言落在**盘上**：真正的 `SKILL.md` 必须出现、`.disabled` 必须消失。
    // 只断言返回值会漏掉「报成功却什么都没发生」——那正是这个缺陷的形状。
    assert.equal(existsSync(join(root, 'parked', 'SKILL.md')), true, '启用必须把文件名改回来（宿主才看得见）')
    assert.equal(existsSync(join(root, 'parked', 'SKILL.md.disabled')), false, '残留名必须消失')
    assert.equal(await readFile(join(root, 'parked', 'SKILL.md'), 'utf8'), body, '内容不得被改动')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restoring a leftover refuses to overwrite an existing SKILL.md', async () => {
  // 两份都在（用户手工改回来过、或并发恢复）：**不得覆盖**——那是用户的文件。
  const root = await mkdtemp(join(tmpdir(), 'dsh-migrate-conflict-'))
  await mkdir(join(root, 'parked'), { recursive: true })
  const live = '---\nname: parked\ndescription: 现行那份\n---\n\n现行正文\n'
  await writeFile(join(root, 'parked', 'SKILL.md.disabled'), '---\nname: parked\ndescription: 残留\n---\n\n残留正文\n')
  try {
    // 先造出「只有 .disabled」的状态，再手工放一份 SKILL.md（模拟冲突）
    await writeFile(join(root, 'parked', 'SKILL.md'), live)
    // 定位会优先命中 SKILL.md（启用态），所以直接构造残留目标来测冲突分支
    await assert.rejects(
      () => setSkillEnabled({
        entry: 'parked', kind: 'bundle', scope: 'global', root, writable: true,
        path: join(root, 'parked', 'SKILL.md.disabled'), migratedDisabled: true,
      }, true),
      /已存在/,
      '目标名被占用时必须拒绝，而不是覆盖用户的文件',
    )
    assert.equal(await readFile(join(root, 'parked', 'SKILL.md'), 'utf8'), live, '现行那份必须原封不动')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disabling a restored skill then re-enabling round-trips byte-for-byte', async () => {
  // 恢复之后它就与普通技能无异：停用走字段、启用走字段，往返逐字节还原。
  const root = await mkdtemp(join(tmpdir(), 'dsh-migrate-roundtrip-'))
  await mkdir(join(root, 'parked'), { recursive: true })
  const body = '---\nname: parked\ndescription: x\n---\n\n正文\n'
  await writeFile(join(root, 'parked', 'SKILL.md.disabled'), body)
  try {
    const leftover = await resolveSkillTarget({ entry: 'parked', kind: 'bundle', scope: 'global', root })
    await setSkillEnabled(leftover, true)                     // 先恢复
    const restored = await resolveSkillTarget({ entry: 'parked', kind: 'bundle', scope: 'global', root })
    assert.equal(restored.migratedDisabled, undefined, '恢复之后不再是残留')
    await setSkillEnabled(restored, false)                    // 新机制停用
    assert.deepEqual(await invocationOnDisk(join(root, 'parked', 'SKILL.md')),
      { modelInvocable: false, userInvocable: false })
    await setSkillEnabled(restored, true)
    assert.equal(await readFile(join(root, 'parked', 'SKILL.md'), 'utf8'), body, '往返必须逐字节还原')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('disables a directory bundle by writing both invocation fields, and re-enables it back', async () => {
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    assert.equal(target.kind, 'bundle')

    const off = await setSkillEnabled(target, false)
    assert.equal(off.changed, true, '首次停用应真的改了文件')
    // ⚠️ 断言落在**盘上的真相**：宿主的两个调用面字段都被写成了「不可调用」。
    // 只看返回值会漏掉「写错字段 / 写错方向」这类错误——那正是本层最贵的一类。
    const disabled = await invocationOnDisk(join(root, 'zhanggui', 'SKILL.md'))
    assert.deepEqual(disabled, { modelInvocable: false, userInvocable: false },
      '停用 = 宿主原生的两个调用面字段都关掉（VS Code 官方定义的 Disabled skills）')
    // 文件本身还在原地：停用**不搬文件**（旧机制改名成 .disabled 会让技能在别的工具里坏掉）。
    assert.equal(existsSync(join(root, 'zhanggui', 'SKILL.md')), true, '停用不得改名，文件必须留在原地')
    assert.equal(existsSync(join(root, 'zhanggui', 'SKILL.md.disabled')), false, '不得再产生 .disabled')

    const on = await setSkillEnabled(target, true)
    assert.equal(on.changed, true, '再次启用应真的改了文件')
    assert.deepEqual(await invocationOnDisk(join(root, 'zhanggui', 'SKILL.md')),
      { modelInvocable: true, userInvocable: true }, '启用 = 两个调用面都回到可调用')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enable/disable is idempotent in both directions and never leaves a key behind', async () => {
  // 陈旧列表 / 两个标签页 / RPC 重试都会重复点同一个开关。
  // ⚠️ 幂等还有一层更细的要求：**不要写与缺省同向的字面量**。
  // 启用态就是两个字段都缺席（宿主的默认值），留一个 `user-invocable: true` 在文件里
  // 会让「开→关→开」不再逐字节还原原文——用户的文件被我们的开关弄脏了。
  const root = await makeRoot()
  const original = await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8')
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    assert.equal((await setSkillEnabled(target, false)).changed, true, '首次停用应真的改文件')

    // 对陈旧行再点一次「停用」：必须是 no-op。
    assert.equal((await setSkillEnabled(target, false)).changed, false, '重复停用应是 no-op')

    assert.equal((await setSkillEnabled(target, true)).changed, true, '启用应改回来')
    assert.equal((await setSkillEnabled(target, true)).changed, false, '重复启用应是 no-op')
    // 往返之后逐字节还原：开关不留痕迹。
    assert.equal(await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8'), original,
      '停用再启用必须逐字节还原原文（缺省方向的值不该被写成字面量）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disables a flat skill by writing the two fields, keeping the file in place', async () => {
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'flat-one.md', kind: 'flat', scope: 'global', root })
    assert.equal(target.kind, 'flat')

    await setSkillEnabled(target, false)
    // 扁平技能同样不搬文件：宿主按 `*.md` 发现它，改名会把它从**所有**工具里抹掉。
    assert.equal((await readdir(root)).includes('flat-one.md'), true, '扁平技能也不得改名')
    assert.deepEqual(await invocationOnDisk(join(root, 'flat-one.md')),
      { modelInvocable: false, userInvocable: false })

    await setSkillEnabled(target, true)
    assert.deepEqual(await invocationOnDisk(join(root, 'flat-one.md')),
      { modelInvocable: true, userInvocable: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('operates on a skill whose disk entry name differs from its frontmatter name', async () => {
  // ⚠️ 真机缺陷（本轮审计的核心）：宿主允许磁盘条目名 != frontmatter 的 name，
  // 而按名字拼路径的实现对这类技能**所有操作都失败**（真机实测 6 种形态里 4 种不可操作）。
  // 这里对同一条技能走完「读正文 → 停用 → 启用 → 删除」全流程，每一步都断言盘上的结果。
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'disk-dir', kind: 'bundle', scope: 'global', root })

    // ① 读正文与权限：名字不一致不影响（按条目读）
    const document = await readSkillDocument(target)
    assert.match(document.text, /alias body/)
    assert.equal(diagnoseSkill(document.text).name, 'dir-alias', '前提：文件里的技能名是 dir-alias')

    // ② 停用：写到那个真实文件上
    assert.equal((await setSkillEnabled(target, false)).changed, true)
    assert.deepEqual(await invocationOnDisk(join(root, 'disk-dir', 'SKILL.md')),
      { modelInvocable: false, userInvocable: false })

    // ③ 启用
    assert.equal((await setSkillEnabled(target, true)).changed, true)
    assert.deepEqual(await invocationOnDisk(join(root, 'disk-dir', 'SKILL.md')),
      { modelInvocable: true, userInvocable: true })

    // ④ 删除：删的是那个真实目录
    await removeSkill(target)
    assert.equal(existsSync(join(root, 'disk-dir')), false, '删除必须作用在真实条目上')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses to operate when the entry is absent from the given scope', async () => {
  // 这是本层最重要的一条：找不到就报错，绝不「回退」到别的作用域或别的形态。
  const root = await makeRoot()
  try {
    await assert.rejects(
      () => resolveSkillTarget({ entry: 'does-not-exist', kind: 'bundle', scope: 'global', root }),
      /does-not-exist/,
      '不存在的条目必须抛错，而不是返回一个猜测的目标',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports absence with a distinguishable error code, not a bare message', async () => {
  // 面板要按 code 判定「不存在」（→ 提示用户）还是真失败（→ 报警）。
  // 若只能靠 message 猜，调用方就只能 catch 全部错误，把权限/IO 失败也当成「不存在」。
  const root = await makeRoot()
  try {
    await assert.rejects(
      () => resolveSkillTarget({ entry: 'ghost', kind: 'bundle', scope: 'global', root }),
      (error) => {
        assert.equal(error.code, 'SKILL_NOT_FOUND')
        assert.equal(error instanceof SkillNotFoundError, true, '必须是可 instanceof 的专用类型')
        return true
      },
    )
    // 非法条目是**另一类**错误：它是坏输入，不是「不存在」，不得混为一谈。
    // ⚠️ 判据是「单个路径段」而不是 kebab-case：磁盘条目名不归宿主管
    // （宿主只要求目录里有 SKILL.md、文件以 .md 结尾），收窄会重新制造「合法的技能操作不了」。
    for (const entry of ['../escape', 'a/b', 'a\\b', '']) {
      await assert.rejects(
        () => resolveSkillTarget({ entry, kind: 'bundle', scope: 'global', root }),
        /非法/,
        `条目 ${JSON.stringify(entry)} 必须被拒绝`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the shape comes from DISK, so an .md-named directory is a valid bundle and kind is only a hint', async () => {
  // ⚠️ 真机缺陷（本版修）：曾经这里拒绝「kind=bundle 且 entry 以 .md 结尾」，理由是
  // 「宿主会把 .md 结尾的目录当扁平技能」——**那个理由是反的**。宿主的 discoverRoot 是
  // **目录分支优先**（`entry.type === 'directory' ? <目录>/SKILL.md : entry.type === 'file'
  // && name.endsWith('.md') ? …`，skill-filesystem 的 :735-739），所以名叫 `odd.md` 的
  // **目录**是完全合法的技能，宿主照收。
  // 后果极重：那条误拒让 `list()` 整个 reject → **面板技能页整块打不开**，连健康的技能都管不了。
  const root = await mkdtemp(join(tmpdir(), 'dsh-shape-'))
  await mkdir(join(root, 'odd.md'), { recursive: true })
  await writeFile(join(root, 'odd.md', 'SKILL.md'), '---\nname: odd\ndescription: x\n---\n\n正文\n')
  await writeFile(join(root, 'plain.md'), '---\nname: plain\ndescription: x\n---\n\n正文\n')
  try {
    // ① 名叫 `odd.md` 的**目录**：形态必须由磁盘决定为 bundle
    const odd = await resolveSkillTarget({ entry: 'odd.md', kind: 'bundle', scope: 'global', root })
    assert.equal(odd.kind, 'bundle', '磁盘上是目录 → 目录捆绑（名字以 .md 结尾不影响）')
    assert.equal(odd.path, join(root, 'odd.md', 'SKILL.md'))

    // ② **声明与磁盘不符时以磁盘为准**：同一个条目报 kind=flat，也必须解析成 bundle。
    // （wire 上的 kind 只是提示；判据不能退回到「信调用方声明」。）
    const oddMislabelled = await resolveSkillTarget({ entry: 'odd.md', kind: 'flat', scope: 'global', root })
    assert.equal(oddMislabelled.kind, 'bundle', '声明说 flat、磁盘上是目录 → 听磁盘的')

    // ③ 反向：真正的扁平文件报 kind=bundle 也以磁盘为准
    const plain = await resolveSkillTarget({ entry: 'plain.md', kind: 'flat', scope: 'global', root })
    assert.equal(plain.kind, 'flat')
    const plainMislabelled = await resolveSkillTarget({ entry: 'plain.md', kind: 'bundle', scope: 'global', root })
    assert.equal(plainMislabelled.kind, 'flat', '声明说 bundle、磁盘上是文件 → 听磁盘的')

    // ④ 读正文要真的读得到（kind 对了才拼得出路径）
    const document = await readSkillDocument(odd)
    assert.match(document.text, /正文/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses to write into a bundled root', async () => {
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    await assert.rejects(
      () => setSkillEnabled({ ...target, writable: false }, false),
      /只读|read-only/,
      'bundled 根只读：部署内置的技能不可启停',
    )
    assert.deepEqual(await invocationOnDisk(join(root, 'zhanggui', 'SKILL.md')),
      { modelInvocable: true, userInvocable: true }, '拒绝后不得改动文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanDisabledSkills reads the OLD rename convention, for migration only', async () => {
  // ⚠️ 这个函数已经不是「已停用技能」的来源了：新机制把状态写在 frontmatter 里，
  // 宿主照样报得出那些技能，面板不需要扫盘（扫盘正是上一版的第二真值来源）。
  // 它现在只负责一件事：把 1.6.x 用户磁盘上**我们自己写进去的** .disabled 文件找出来，
  // 否则那些技能永远回不来。用户恢复之后就走新机制。
  const root = await makeRoot()
  try {
    // 手工造出旧机制的两种残留（不是通过 setSkillEnabled —— 它已经不产生这种文件了）。
    await writeFile(join(root, 'zhanggui', 'SKILL.md.disabled'),
      await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8'))
    await rm(join(root, 'zhanggui', 'SKILL.md'))
    await writeFile(join(root, 'flat-one.md.disabled'),
      await readFile(join(root, 'flat-one.md'), 'utf8'))
    await rm(join(root, 'flat-one.md'))

    const disabled = await scanDisabledSkills({ root, scope: 'global' })
    assert.deepEqual(disabled.map((row) => row.entry).sort(), ['flat-one.md', 'zhanggui'],
      '两种旧形态都要扫得到（否则用户再也启用不回来）')
    assert.equal(disabled.every((row) => row.migrated === true), true, '必须标成迁移读取，好让面板区别对待')
    // 条目与形态必须自洽到「能直接拿去 resolve」——否则扫出来也没法恢复。
    for (const row of disabled) {
      const target = await resolveSkillTarget({ entry: row.entry, kind: row.kind, scope: 'global', root })
      assert.equal(existsSync(target.path), true, `${row.entry} 扫出来的目标必须真的存在`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scans a disabled skill whose directory is a link (the host would never see it again)', async () => {
  // ⚠️ 真机缺陷（与 issue #5 同一根因的第三个实例，2026-10-11 复现）：
  // 技能目录是指向外部同步库的符号链接/junction 时，`readdir` 的 `Dirent.isDirectory()`
  // 报 **false**（而是 isSymbolicLink=true）。原先的扫描用这个判据挑「目录捆绑」，
  // 于是链接技能一旦停用就掉进扁平分支、两边都不匹配 → **扫不到 → 从面板彻底消失**。
  // 用户那边看到的是：「点一下停用，这条技能没了，也没法再启用」——而磁盘上其实改名成功了。
  //
  // 旧机制下这类残留仍然可能存在（1.6.x 写下的），所以迁移读取必须照样覆盖它。
  const root = await mkdtemp(join(tmpdir(), 'dsh-scan-link-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-scan-link-ext-'))
  try {
    // 本体在外部库，根下只放 junction
    await mkdir(join(external, 'linked-skill'), { recursive: true })
    await writeFile(join(external, 'linked-skill', 'SKILL.md.disabled'),
      '---\nname: linked-skill\ndescription: 链接技能\n---\n\n正文\n')
    try {
      await symlink(join(external, 'linked-skill'), join(root, 'linked-skill'), 'junction')
    } catch (error) {
      throw new Error(`本环境无法创建链接（${error.code}），该用例未能执行`)
    }

    const disabled = await scanDisabledSkills({ root, scope: 'global' })
    const linked = disabled.find((row) => row.entry === 'linked-skill')
    assert.notEqual(linked, undefined,
      '链接目录里的旧态残留必须扫得到——否则用户再也看不见、也启用不回来')
    assert.equal(linked.kind, 'bundle', '形态按跟随链接后的真相判定（它是个目录捆绑）')
    assert.equal(existsSync(linked.path), true, '给出的路径必须真的存在，否则「启用」会失败')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('reads a skill body and its on-disk invocation in the same read', async () => {
  // 正文与调用权限**必须同源**：分两次读会读到两个不同的版本（改动正好落在两次读之间），
  // 面板于是显示一份正文、配一个不属于它的权限。所以读技能只有这一个入口。
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    const document = await readSkillDocument(target)
    assert.match(document.text, /body/)
    assert.deepEqual(document.invocation, { modelInvocable: true, userInvocable: true },
      '没写这两个字段时就是宿主默认值（都能调用）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports an unknown invocation instead of inventing one when the frontmatter is unreadable', async () => {
  // 非法 frontmatter 的技能会被宿主整条跳过，此刻「能不能被模型调用」**没有答案**。
  // 编一个 true/false 出来就是让面板撒谎（已停用技能此前正是这么显示的）。
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-broken-'))
  await writeFile(join(root, 'broken.md'), '---\nname: [unclosed\ndescription: y\n---\n\n正文\n')
  try {
    const target = await resolveSkillTarget({ entry: 'broken.md', kind: 'flat', scope: 'global', root })
    const document = await readSkillDocument(target)
    assert.equal(document.invocation, null)
    assert.match(document.text, /正文/, '正文还是要给出去：面板要能让用户看到那份坏在哪')
    assert.equal(diagnoseSkill(document.text).ok, false, '前提：这份 frontmatter 确实是坏的')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the two invocation faces are independently writable, so no bracket is unreachable', async () => {
  // ⚠️ 这条钉的是「面板与文件 1:1」：宿主支持**两个**调用面，而「停用」只是「两个都关」这一种组合。
  // 如果面板只暴露一个面（以前就是这样：模型面可拨、用户面只读），用户把一条技能从
  // 「仅手动可调用」拨到「停用」再拨回「启用」之后，会落到「两个都能用」，而**面板上没有开关
  // 能拨回「仅手动」**——只能去编辑文件。这条用例证明三个档位都能从代码路径到达。
  const root = await mkdtemp(join(tmpdir(), 'dsh-faces-'))
  await mkdir(join(root, 'zhanggui'), { recursive: true })
  const file = join(root, 'zhanggui', 'SKILL.md')
  await writeFile(file, '---\nname: zhanggui\ndescription: demo\n---\n\nbody\n')
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })

    // ① 仅手动可调用：只关模型面（= 规范里 disable-model-invocation 那一档）
    await setSkillModelInvocable(target, false)
    assert.deepEqual(await invocationOnDisk(file), { modelInvocable: false, userInvocable: true },
      '只关模型面 → 模型不自动发现，但用户仍能手动调用')

    // ② 仅模型可调用：只关用户面（这是以前**够不到**的那一档）
    await setSkillUserInvocable(target, false)
    await setSkillModelInvocable(target, true)
    assert.deepEqual(await invocationOnDisk(file), { modelInvocable: true, userInvocable: false },
      '只关用户面 → 模型可自动调用，但用户不能手动调用')

    // ③ 停用：两个面都关（= 面板的「停用」按钮做的事）
    await setSkillUserInvocable(target, false)
    assert.deepEqual(await invocationOnDisk(file), { modelInvocable: true, userInvocable: false })
    await setSkillEnabled(target, false)
    assert.deepEqual(await invocationOnDisk(file), { modelInvocable: false, userInvocable: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('toggling one face leaves the other byte-for-byte untouched', async () => {
  // ⚠️ 两个开关必须互不干扰：只改一行、另一行逐字节不动（技能文件是用户手写的资产）。
  // 这条也守住「两个字段的方向各自正确」——把 user-invocable 的缺省方向写反的话，
  // 关它就会变成删掉那一行（而它缺省是 true，删掉等于**打开**），这里会红。
  const root = await mkdtemp(join(tmpdir(), 'dsh-face-isolation-'))
  await mkdir(join(root, 'zhanggui'), { recursive: true })
  const file = join(root, 'zhanggui', 'SKILL.md')
  const original = '---\nname: zhanggui\ndescription: demo\n---\n\nbody\n'
  await writeFile(file, original)
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })

    // 只关用户面：应当**新增**一行 `user-invocable: false`（它缺省是 true，所以必须写字面量）
    await setSkillUserInvocable(target, false)
    const afterUserOff = await readFile(file, 'utf8')
    assert.match(afterUserOff, /^user-invocable: false$/m, '关掉一个缺省为 true 的字段必须写字面量 false')
    assert.doesNotMatch(afterUserOff, /disable-model-invocation/, '不得顺手动另一个面')

    // 再关模型面：现在两行都在
    await setSkillModelInvocable(target, false)
    const both = await readFile(file, 'utf8')
    assert.match(both, /^disable-model-invocation: true$/m)
    assert.match(both, /^user-invocable: false$/m)

    // 只打开用户面：删掉 user-invocable 那一行（缺省即 true），模型面那行**必须原样留着**
    await setSkillUserInvocable(target, true)
    const afterUserOn = await readFile(file, 'utf8')
    assert.doesNotMatch(afterUserOn, /user-invocable/, '打开缺省为 true 的字段 = 删掉那一行')
    assert.match(afterUserOn, /^disable-model-invocation: true$/m, '另一个面必须原样留着')

    // 全部打开 → 逐字节还原原文（开关不留痕迹）
    await setSkillModelInvocable(target, true)
    assert.equal(await readFile(file, 'utf8'), original, '两个面都打开后必须逐字节还原原文')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unknown invocation face is refused rather than writing a made-up field', async () => {
  // 面名来自 wire：拼错时必须拒绝，不能按名字拼一个宿主不认的键写进用户的 frontmatter。
  const root = await mkdtemp(join(tmpdir(), 'dsh-face-unknown-'))
  await mkdir(join(root, 'zhanggui'), { recursive: true })
  const file = join(root, 'zhanggui', 'SKILL.md')
  const original = '---\nname: zhanggui\ndescription: demo\n---\n\nbody\n'
  await writeFile(file, original)
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    await assert.rejects(
      () => setSkillInvocationFace(target, 'modelInvocableTypo', false),
      /未知的调用面/,
      '未知面名必须被拒绝',
    )
    await assert.rejects(() => setSkillInvocationFace(target, 'constructor', false), /未知的调用面/,
      '原型链上的名字也不算合法面名')
    assert.equal(await readFile(file, 'utf8'), original, '被拒后文件必须逐字节不变')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removes a skill bundle and a flat file, and reports what it removed', async () => {
  const root = await makeRoot()
  try {
    const bundle = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    const removedBundle = await removeSkill(bundle)
    assert.equal(existsSync(join(root, 'zhanggui')), false, '目录捆绑应整个删掉')
    assert.equal(removedBundle.removed, join(root, 'zhanggui'), '要报告删掉了什么（面板据此提示用户）')

    const flat = await resolveSkillTarget({ entry: 'flat-one.md', kind: 'flat', scope: 'global', root })
    await removeSkill(flat)
    assert.equal(existsSync(join(root, 'flat-one.md')), false)

    // 只该少掉这两条：夹具里还有第三条（disk-dir），删错范围会连它一起带走。
    assert.deepEqual((await readdir(root)).sort(), ['disk-dir'], '只删点名的那一条，别人不许动')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an entry that looks like a path is refused at resolve time, so nothing outside the root is touched', async () => {
  // 外部输入在系统边界必须校验：条目名来自面板（原本来自宿主报告的路径，但 wire 上仍可被伪造），
  // 不能让它跳出根目录。
  //
  // 注意这条只覆盖**本层**的解析（`resolveSkillTarget` 拒绝越界条目）。「调用方能不能凭空
  // 指定一个根」是另一层的事——那是 RPC 层的 `resolveTargetReference`（载荷里的 root 必须
  // 能对上宿主自己算出来的目标），由 test/skillhub-install.test.mjs 的信任边界用例覆盖。
  const root = await makeRoot()
  const outside = join(root, '..', 'must-survive.txt')
  await writeFile(outside, 'keep me')
  try {
    for (const entry of ['../must-survive', '..\\must-survive', '/etc/passwd', 'a/b', 'a\\b', '..']) {
      await assert.rejects(
        () => resolveSkillTarget({ entry, kind: 'bundle', scope: 'global', root }),
        /非法/,
        `条目 ${entry} 必须被拒绝`,
      )
    }
    assert.equal(existsSync(outside), true, '越界目标必须原封不动')
  } finally {
    await rm(outside, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 导入（.md / 目录 / 压缩包）
//
// 关键约束：宿主的技能**身份来自 frontmatter 的 name**，不是文件/目录名
// （dsh-skill-filesystem/lib/index.js:696-704）。所以导入必须按 frontmatter 的名字落盘，
// 否则本层自己的 resolveSkillTarget(name) 会找不到刚导入的技能——面板导入完就点不动。
// ---------------------------------------------------------------------------

/** 建一个空的作用域根（模拟用户选中的项目/全局作用域）。 */
async function makeDestRoot() {
  return await mkdtemp(join(tmpdir(), 'dsh-import-'))
}

/** 造一个源技能目录。 */
async function makeSourceBundle({ directory = 'source-dir', name = 'imported-bundle' } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const dir = join(parent, directory)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 导入演示\n---\n\n正文\n`)
  await writeFile(join(dir, 'references', 'note.md'), 'note')
  return dir
}

test('imports a single .md file as a flat skill named by its frontmatter', async () => {
  const root = await makeDestRoot()
  const sourceParent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const source = join(sourceParent, 'whatever-name.md')
  await writeFile(source, '---\nname: flat-import\ndescription: 扁平导入\n---\n\n正文\n')
  try {
    const result = await importSkill({
      root, scope: 'global', source: { type: 'file', path: source },
    })
    assert.equal(result.name, 'flat-import')
    // 落盘名取自 frontmatter，而不是源文件名 whatever-name.md。
    assert.equal(existsSync(join(root, 'flat-import.md')), true, '应按 frontmatter 名落成扁平文件')
    assert.equal(existsSync(join(root, 'whatever-name.md')), false)
    // 本层自己的定位必须能立刻找到它——否则导入完面板就点不动了。
    const target = await resolveSkillTarget({ entry: 'flat-import.md', kind: 'flat', scope: 'global', root })
    assert.equal(target.kind, 'flat')
    assert.match((await readSkillDocument(target)).text, /扁平导入/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceParent, { recursive: true, force: true })
  }
})

test('imports a directory bundle with its resources', async () => {
  const root = await makeDestRoot()
  const source = await makeSourceBundle({ directory: 'renamed-on-disk', name: 'imported-bundle' })
  try {
    const result = await importSkill({
      root, scope: 'global', source: { type: 'directory', path: source },
    })
    assert.equal(result.name, 'imported-bundle')
    assert.equal(result.kind, 'bundle')
    assert.equal(existsSync(join(root, 'imported-bundle', 'SKILL.md')), true)
    // resources 必须一起带过去，否则技能正文里引用的脚本/文档会缺。
    assert.equal(await readFile(join(root, 'imported-bundle', 'references', 'note.md'), 'utf8'), 'note')

    const target = await resolveSkillTarget({ entry: 'imported-bundle', kind: 'bundle', scope: 'global', root })
    assert.equal(target.kind, 'bundle')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(join(source, '..'), { recursive: true, force: true })
  }
})

test('imports a zip that wraps the skill in a directory', async () => {
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const archive = join(parent, 'skill.zip')
  await writeFile(archive, makeZip([
    { name: 'wrapped-skill/SKILL.md', data: '---\nname: from-zip\ndescription: 来自压缩包\n---\n\n正文\n' },
    { name: 'wrapped-skill/scripts/run.sh', data: 'echo hi' },
  ]))
  try {
    const result = await importSkill({
      root, scope: 'global', source: { type: 'archive', path: archive },
    })
    assert.equal(result.name, 'from-zip')
    assert.equal(result.kind, 'bundle')
    assert.equal(await readFile(join(root, 'from-zip', 'scripts', 'run.sh'), 'utf8'), 'echo hi')
    // 压缩包的外层目录名不该成为落盘名。
    assert.equal(existsSync(join(root, 'wrapped-skill')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('imports a zip whose SKILL.md sits at the archive root', async () => {
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const archive = join(parent, 'flat-skill.zip')
  await writeFile(archive, makeZip([
    { name: 'SKILL.md', data: '---\nname: root-level\ndescription: 根层\n---\n\n正文\n' },
    { name: 'assets/logo.txt', data: 'logo' },
  ]))
  try {
    const result = await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
    assert.equal(result.name, 'root-level')
    assert.equal(existsSync(join(root, 'root-level', 'SKILL.md')), true, '仍应装成目录捆绑')
    assert.equal(await readFile(join(root, 'root-level', 'assets', 'logo.txt'), 'utf8'), 'logo')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('imports a tar.gz archive too', async () => {
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const archive = join(parent, 'skill.tgz')
  await writeFile(archive, gzipSync(makeTar([
    { name: 'g/SKILL.md', data: '---\nname: from-targz\ndescription: 来自 tgz\n---\n\n正文\n' },
  ])))
  try {
    const result = await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
    assert.equal(result.name, 'from-targz')
    assert.equal(existsSync(join(root, 'from-targz', 'SKILL.md')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('refuses to import a skill whose frontmatter the host would reject', async () => {
  const root = await makeDestRoot()
  const sourceParent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const source = join(sourceParent, 'broken.md')
  // 宿主会静默跳过它：导入进来只会得到一条「看不见的技能」，故必须在导入时挡住。
  await writeFile(source, '---\nname: Bad_Name\ndescription: 演示\n---\n\n正文\n')
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'file', path: source } }),
      /Bad_Name/,
      '非法 frontmatter 必须被拒绝，且诊断要指出具体是哪个名字不合格',
    )
    assert.deepEqual(await readdir(root), [], '被拒绝的导入不得留下任何文件')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceParent, { recursive: true, force: true })
  }
})

test('refuses to import frontmatter that is broken in ways the name alone would not reveal', async () => {
  // 这一组专门守住「导入前跑完整 frontmatter 诊断」这件事：下面每条都有**合法**的名字，
  // 只有真正读懂 frontmatter 才能发现它们会让宿主静默跳过整条技能。
  const broken = [
    ['缺少 description', '---\nname: looks-fine\n---\n\n正文\n', /description/],
    ['完全没有 frontmatter', '# 只是正文\n', /frontmatter/],
    ['YAML 不合法', '---\nname: [unclosed\ndescription: y\n---\n\n正文\n', /YAML/],
    ['用了驼峰 invocation 键', '---\nname: looks-fine\ndescription: 演示\ndisableModelInvocation: true\n---\n\n正文\n', /disable-model-invocation/],
    ['invocation 值不是布尔', '---\nname: looks-fine\ndescription: 演示\nuser-invocable: maybe\n---\n\n正文\n', /user-invocable/],
  ]
  for (const [label, text, expected] of broken) {
    const root = await makeDestRoot()
    const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
    const source = join(parent, 'looks-fine.md')
    await writeFile(source, text)
    try {
      await assert.rejects(
        () => importSkill({ root, scope: 'global', source: { type: 'file', path: source } }),
        expected,
        `${label}：必须被拒绝（否则会装进一条宿主永远看不见的技能）`,
      )
      assert.deepEqual(await readdir(root), [], `${label}：失败不得留下残骸`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  }
})

test('refuses to overwrite an existing skill instead of silently replacing it', async () => {
  const root = await makeRoot() // 已含 zhanggui 目录捆绑与 flat-one.md
  const sourceParent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const source = join(sourceParent, 'zhanggui.md')
  await writeFile(source, '---\nname: zhanggui\ndescription: 冒充\n---\n\n恶意替换\n')
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'file', path: source } }),
      /已存在|exists/,
      '同名技能已存在时必须拒绝，不能静默覆盖用户的技能',
    )
    // 原技能必须原封不动。
    assert.match(await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8'), /demo/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceParent, { recursive: true, force: true })
  }
})

test('refuses to import into a read-only bundled root', async () => {
  const root = await makeDestRoot()
  const source = await makeSourceBundle({ name: 'into-bundled' })
  try {
    await assert.rejects(
      () => importSkill({
        root, scope: 'global', writable: false, source: { type: 'directory', path: source },
      }),
      /只读|read-only/,
    )
    assert.deepEqual(await readdir(root), [], '只读根不得被写入')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(join(source, '..'), { recursive: true, force: true })
  }
})

test('refuses an archive with no SKILL.md', async () => {
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const archive = join(parent, 'no-skill.zip')
  await writeFile(archive, makeZip([{ name: 'readme.md', data: '只是一个 readme' }]))
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } }),
      /SKILL\.md/,
    )
    assert.deepEqual(await readdir(root), [], '失败不得留下残骸')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('refuses an archive holding several skills rather than picking one', async () => {
  // 一个包多个技能时静默挑一个等于猜；导入的目标必须是确定的。
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const archive = join(parent, 'two.zip')
  await writeFile(archive, makeZip([
    { name: 'a/SKILL.md', data: '---\nname: skill-a\ndescription: A\n---\n' },
    { name: 'b/SKILL.md', data: '---\nname: skill-b\ndescription: B\n---\n' },
  ]))
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } }),
      /多个|多个技能|无法确定/,
    )
    assert.deepEqual(await readdir(root), [], '失败不得留下残骸')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('refuses a directory import that has no SKILL.md', async () => {
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const directory = join(parent, 'not-a-skill')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'notes.md'), 'x')
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'directory', path: directory } }),
      /SKILL\.md/,
    )
    assert.deepEqual(await readdir(root), [], '失败不得留下残骸')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('refuses a directory import whose references point outside the skill tree', async () => {
  // 与压缩包同一条纪律（skills-archive 拒绝符号链接）：克隆下来的技能仓库可以带链接，
  // 而 fs.cp 默认保留链接，于是技能里的 references/... 可能指向技能根之外的文件——
  // 技能正文会把读者引向不该读的内容。宁可整包拒绝，也不静默解引用（那等于把外部
  // 文件的内容复制进用户的技能目录）。
  //
  // 用 junction 造链接：Windows 上真正的 file symlink 需要 SeCreateSymbolicLinkPrivilege
  // （实测本机 EPERM），而目录 junction 不需要；POSIX 上 type 参数被忽略，建的是普通符号链接。
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const secrets = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
  const directory = join(parent, 'linked-skill')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: linked\ndescription: 带链接\n---\n\n正文\n')
  await writeFile(join(secrets, 'credentials.txt'), 'top secret')
  try {
    await symlink(secrets, join(directory, 'references'), 'junction')
  } catch (error) {
    // 环境连 junction 都不给建：这条用例无法表达它的意图，明说而不是静默放过。
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
    await rm(secrets, { recursive: true, force: true })
    throw new Error(`本环境无法创建链接（${error.code}），该安全用例未能执行`)
  }
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'directory', path: directory } }),
      /符号链接/,
      '带链接的目录必须整包拒绝，而不是把链接复制过去',
    )
    assert.deepEqual(await readdir(root), [], '失败不得留下残骸')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
    await rm(secrets, { recursive: true, force: true })
  }
})

test('refuses a frontmatter name that would escape the destination root', async () => {
  // frontmatter 是外部输入：恶意的技能名不能借导入写到根目录之外。
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const source = join(parent, 'evil.md')
  await writeFile(source, '---\nname: "../escaped"\ndescription: 越界\n---\n\n正文\n')
  const outside = join(root, '..', 'escaped.md')
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'file', path: source } }),
      /escaped/,
      '越界的 frontmatter 名必须被拒绝，并指出是哪个名字',
    )
    assert.equal(existsSync(outside), false, '越界文件不得被写出')
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(outside, { force: true })
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('leaves no staging directory behind in the destination root', async () => {
  // 解包需要暂存目录。若把暂存放进技能根，宿主的目录扫描会把它当成一条技能
  // （宿主只跳过 .system，其余目录都按 <dir>/SKILL.md 解析）。
  const root = await makeDestRoot()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const archive = join(parent, 'skill.zip')
  await writeFile(archive, makeZip([
    { name: 's/SKILL.md', data: '---\nname: clean-import\ndescription: 干净导入\n---\n' },
  ]))
  try {
    await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
    assert.deepEqual(await readdir(root), ['clean-import'], '根目录里只该有装好的那一个技能')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

test('creates the destination root when importing into a scope that does not exist yet', async () => {
  // 用户选中的作用域根（如 <project>/.agents/skills）可能还不存在——首次导入要能建出来。
  // 这条同时守住「暂存目录不得放在技能根内」：若暂存先于建根，这里会直接失败。
  const parent = await mkdtemp(join(tmpdir(), 'dsh-src-'))
  const root = join(parent, 'not-created-yet', 'skills')
  const archive = join(parent, 'skill.zip')
  await writeFile(archive, makeZip([
    { name: 's/SKILL.md', data: '---\nname: fresh-scope\ndescription: 新作用域\n---\n' },
  ]))
  try {
    const result = await importSkill({ root, scope: 'project', source: { type: 'archive', path: archive } })
    assert.equal(result.name, 'fresh-scope')
    assert.equal(existsSync(join(root, 'fresh-scope', 'SKILL.md')), true)
    assert.deepEqual(await readdir(root), ['fresh-scope'])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('refuses an oversized archive before reading it into memory', async () => {
  // 限额判定发生在解压之后，而调用方是先把整包读进内存的——没有这道闸，几十 MiB 的包
  // 在读进来时就已经占满内存。用**稀疏文件**造出超限大小，不必真的写 32 MiB 数据。
  const parent = await mkdtemp(join(tmpdir(), 'dsh-big-archive-'))
  const root = join(parent, 'skills')
  const archive = join(parent, 'huge.zip')
  await writeFile(archive, '')
  await truncate(archive, MAX_ARCHIVE_BYTES + 1)
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } }),
      /压缩包过大/,
    )
    assert.equal(existsSync(root), false, '被拒的导入不该在用户根里留下任何东西')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('two concurrent imports of the same name: exactly one wins and the winner stays intact', async () => {
  // 旧实现没有锁：两次导入都会通过「目标空闲」检查，随后互相踩——实测一条的失败清理
  // 会删掉另一条正在写的目录，最终根里空空如也、两个调用都失败；交错顺序稍不同就变成
  // 「两个来源的文件混进同一个技能目录」（cp 是合并语义），恰好推翻「拒绝而不覆盖」。
  const parent = await mkdtemp(join(tmpdir(), 'dsh-race-'))
  const root = join(parent, 'skills')
  const first = join(parent, 'first')
  const second = join(parent, 'second')
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  const header = '---\nname: same-name\ndescription: 同名\n---\n'
  await writeFile(join(first, 'SKILL.md'), `${header}\nA\n`)
  await writeFile(join(first, 'a-only.txt'), 'a')
  await writeFile(join(second, 'SKILL.md'), `${header}\nB\n`)
  await writeFile(join(second, 'b-only.txt'), 'b')
  try {
    const results = await Promise.allSettled([
      importSkill({ root, scope: 'global', source: { type: 'directory', path: first } }),
      importSkill({ root, scope: 'global', source: { type: 'directory', path: second } }),
    ])
    const ok = results.filter((entry) => entry.status === 'fulfilled')
    const failed = results.filter((entry) => entry.status === 'rejected')
    assert.equal(ok.length, 1, '同名并发导入只能有一个成功')
    assert.equal(failed.length, 1, '另一个必须被明确拒绝')
    assert.match(String(failed[0].reason?.message), /已存在/, '被拒的原因要说清是「已存在」而不是随机 IO 错')
    // 赢家必须完好：两个来源的文件**不得**混进同一个目录
    const body = await readFile(join(root, 'same-name', 'SKILL.md'), 'utf8')
    const files = (await readdir(join(root, 'same-name'))).sort()
    const winnerIsA = body.includes('A')
    assert.deepEqual(files, winnerIsA ? ['SKILL.md', 'a-only.txt'] : ['SKILL.md', 'b-only.txt'],
      '赢家的目录里只能有它自己的文件（合并语义会让两个来源混在一起）')
    // 不留暂存残骸
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.dsh-import-')), [])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('leaves no staging residue in the skill root after a bundle import', async () => {
  // 原子提交的暂存放在技能根里（`<root>/.dsh-import-<随机>/skill`），所以必须证明它清干净了，
  // 而且根里只剩目标那一项——否则暂存目录会被宿主当成一条技能（它只看 <dir>/SKILL.md）。
  const parent = await mkdtemp(join(tmpdir(), 'dsh-atomic-'))
  const root = join(parent, 'skills')
  const archive = join(parent, 'skill.zip')
  await writeFile(archive, makeZip([
    { name: 'pkg/SKILL.md', data: '---\nname: atomic-demo\ndescription: 原子提交\n---\n' },
    { name: 'pkg/references/notes.md', data: 'notes' },
  ]))
  try {
    const result = await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
    assert.equal(result.name, 'atomic-demo')
    assert.deepEqual(await readdir(root), ['atomic-demo'], '根里只该有目标项，暂存必须清掉')
    assert.deepEqual((await readdir(join(root, 'atomic-demo'))).sort(), ['SKILL.md', 'references'])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('refuses a bundle whose root is itself a link/junction', async () => {
  // 只从树内部查链接会漏掉「调用方给的路径本身就是一个 junction」这种情形：
  // Windows 上 cp 会 EPERM（报错难懂），POSIX 上会把链接原样复制进用户的技能根。
  const parent = await mkdtemp(join(tmpdir(), 'dsh-link-'))
  const root = join(parent, 'skills')
  const real = join(parent, 'real-skill')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'SKILL.md'), '---\nname: linked\ndescription: 链接\n---\n')
  const link = join(parent, 'linked-skill')
  await symlink(real, link, 'junction')
  try {
    await assert.rejects(
      () => importSkill({ root, scope: 'global', source: { type: 'directory', path: link } }),
      /拒绝导入符号链接/,
    )
    assert.equal(existsSync(root) && (await readdir(root)).length > 0, false, '根里不得留下任何东西')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

// ── 「模型自动调用」开关：把 frontmatter 里那一行改掉 ────────────────────────
//
// 为什么归这一层：它真的动用户的技能文件，所以要跟启停/删除/导入同一套纪律——同一个锁键
// （root + name）、同样的只读根拒绝、同样的原子提交。改写本身的规则（哪一行、能不能改）
// 归 lib/skills-frontmatter.js，本层只负责「找到哪个文件、怎么安全地写回去」。

test('writes the model-invocation switch into the file the caller pointed at', async () => {
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    const result = await setSkillModelInvocable(target, false)
    assert.equal(result.changed, true)
    assert.equal(result.modelInvocable, false)

    const file = join(root, 'zhanggui', 'SKILL.md')
    const text = await readFile(file, 'utf8')
    // 语义用宿主规则的那份解析确认，而不是比对字符串常量。
    assert.equal(diagnoseSkill(text).invocation.modelInvocable, false, '宿主必须读到「模型不可调用」')
    // 只动 frontmatter：既有字段与正文逐字还在。
    assert.match(text, /name: zhanggui/)
    assert.match(text, /body/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the switch is idempotent and leaves no temporary file behind', async () => {
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    assert.equal((await setSkillModelInvocable(target, false)).changed, true)
    assert.equal((await setSkillModelInvocable(target, false)).changed, false, '已经是目标态就该是 no-op')
    assert.deepEqual(await readdir(join(root, 'zhanggui')), ['SKILL.md'], '原子写不得留下临时文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent identical switches write once, because read-modify-write is serialized', async () => {
  // 与启停/删除/导入共用同一把锁键（root + name）：并发的两个请求里，后到的那个必须看到
  // 先到者的结果（否则两次都会声称「我改了」——那就是读-改-写没有串行起来）。
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    const results = await Promise.all([
      setSkillModelInvocable(target, false),
      setSkillModelInvocable(target, false),
    ])
    assert.equal(results.filter((row) => row.changed).length, 1, '只应有一次真的写盘')
    const text = await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8')
    assert.equal(diagnoseSkill(text).invocation.modelInvocable, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses to write the switch into a bundled root', async () => {
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    const before = await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8')
    await assert.rejects(
      () => setSkillModelInvocable({ ...target, writable: false }, false),
      /只读|read-only/,
      'bundled 根只读：部署内置的技能不可改调用权限',
    )
    assert.equal(await readFile(join(root, 'zhanggui', 'SKILL.md'), 'utf8'), before, '拒绝后不得改动文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the model switch works on a disabled skill, because it is the same file', async () => {
  // 停用后技能**还在原路径**（停用写的是两个 frontmatter 字段，不搬文件），
  // 所以「模型自动调用」这个开关照样作用在同一个文件上；但它绝不能顺手把技能启用回来——
  // 两个字段各管一件事，把 user-invocable 悄悄改回 true 就等于用户没点过「启用」却启用了。
  const root = await makeRoot()
  try {
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    await setSkillEnabled(target, false)
    assert.deepEqual(await invocationOnDisk(join(root, 'zhanggui', 'SKILL.md')),
      { modelInvocable: false, userInvocable: false }, '前提：技能确实处于停用态')

    // 目标态本来就是「模型不可调用」→ 幂等，不该再写一次。
    assert.equal((await setSkillModelInvocable(target, false)).changed, false, '已是目标态就该 no-op')

    // 反向：单独把模型面打开，用户面必须**保持关着**（停用态不被顺手解除）。
    assert.equal((await setSkillModelInvocable(target, true)).changed, true)
    assert.deepEqual(await invocationOnDisk(join(root, 'zhanggui', 'SKILL.md')),
      { modelInvocable: true, userInvocable: false },
      '只动模型面：用户面必须原样保持不可调用')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a refused rewrite leaves the file byte-identical, because half a write is the worst outcome', async () => {
  // 改写规则拒绝时（这里：值跨了行），本层必须原样放行那个错误、**一个字节都不写**。
  // 半写是最坏的结局：用户既没拿到想要的状态，文件也被改坏了——而这是**用户手写的资产**。
  const root = await makeRoot()
  try {
    const file = join(root, 'zhanggui', 'SKILL.md')
    await writeFile(file, '---\nname: zhanggui\ndescription: demo\ndisable-model-invocation: >-\n  true\n---\n\nbody\n')
    const before = await readFile(file)
    const target = await resolveSkillTarget({ entry: 'zhanggui', kind: 'bundle', scope: 'global', root })
    await assert.rejects(
      () => setSkillModelInvocable(target, true),
      /disable-model-invocation/,
      '形状读不准时要拒绝，而且错误里要点名那个字段',
    )
    assert.deepEqual(await readFile(file), before, '拒绝后文件必须逐字节不变')
    assert.deepEqual(await readdir(join(root, 'zhanggui')), ['SKILL.md'], '原子写不得留下临时文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


// ── 浏览器上传的来源（R11）：浏览器拿不到宿主路径，只能给内容 ──────────────
//
// 现状与约束（写清楚，免得下轮又去试"传个路径就行"）：
//   · `importSkill` 原本只接受 `{ type, path }` 且**从宿主磁盘读**——浏览器给不了路径，
//     所以"加个 <input type=file> 就完事"这条路走不通；
//   · 技能名来自 **frontmatter**（`requireImportableName` 只看 text），所以传内容不影响命名；
//   · 唯一既安全又不新增 wire 方法的做法：payload 里传**内容**，宿主落到 system tmp 后
//     走**同一条**导入路径（zip-slip / 符号链接检查 / 文件锁 / 原子提交全部复用）。
//   · 这比"让客户端传路径"**更窄**：客户端拿不到"读宿主任意文件"的能力。
const uploadStaging = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('dsh-skill-upload-')).sort()

test('imports a flat skill from uploaded text (browser cannot supply a host path)', async () => {
  const root = await makeDestRoot()
  const stagingBefore = await uploadStaging()
  try {
    const result = await importSkill({
      root,
      scope: 'global',
      source: { type: 'file', content: '---\nname: uploaded-flat\ndescription: 上传来的\n---\n\n正文\n' },
    })
    assert.equal(result.name, 'uploaded-flat', '名字取自 frontmatter，不来自任何文件名')
    assert.equal(existsSync(join(root, 'uploaded-flat.md')), true)
    assert.match((await readFile(join(root, 'uploaded-flat.md'), 'utf8')), /上传来的/)
    // 临时目录必须清掉：里面是用户的技能原文，不该留在 tmp。
    assert.deepEqual(await uploadStaging(), stagingBefore, '上传暂存目录必须在 finally 里清掉')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('imports a bundle from an uploaded zip (base64), reusing the same archive checks', async () => {
  const root = await makeDestRoot()
  const stagingBefore = await uploadStaging()
  try {
    // makeZip 收的是**数组**（{ name, data }），不是对象映射。
    const zip = makeZip([
      { name: 'uploaded-bundle/SKILL.md', data: '---\nname: uploaded-bundle\ndescription: 上传的压缩包\n---\n\n正文\n' },
      { name: 'uploaded-bundle/scripts/run.sh', data: 'echo hi\n' },
    ])
    const result = await importSkill({
      root,
      scope: 'global',
      source: { type: 'archive', archiveBase64: zip.toString('base64') },
    })
    assert.equal(result.name, 'uploaded-bundle')
    assert.equal(existsSync(join(root, 'uploaded-bundle', 'SKILL.md')), true)
    assert.equal(existsSync(join(root, 'uploaded-bundle', 'scripts', 'run.sh')), true)
    assert.deepEqual(await uploadStaging(), stagingBefore, '上传暂存目录必须清掉')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uploaded content is size-capped and bad input is rejected before any write', async () => {
  const root = await makeDestRoot()
  const stagingBefore = await uploadStaging()
  try {
    // 文本没有"输入路径"可查大小，所以必须在写盘前按 MAX_FILE_BYTES 拒。
    await assert.rejects(
      importSkill({
        root,
        scope: 'global',
        source: { type: 'file', content: 'x'.repeat(MAX_FILE_BYTES + 1) },
      }),
      /过大|超过|上限/,
    )
    // 非法 base64 不得写出半个压缩包。
    await assert.rejects(
      importSkill({ root, scope: 'global', source: { type: 'archive', archiveBase64: 'not-base64!!!' } }),
      /压缩包|archive|非法/,
    )
    assert.deepEqual(await readdir(root), [], '被拒的导入不得在技能根留下任何东西')
    assert.deepEqual(await uploadStaging(), stagingBefore, '被拒时暂存目录同样必须清掉')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── R14：外部源技能的来源记录 ────────────────────────────────────────────────
//
// 现状缺陷：`skillHubInstall` 装完**什么都不留**——用户看不到"这个技能从哪个上游、哪个版本装的"，
// 也就无从检查更新。这一组钉三件事：来源真的落了盘 / 它不会被当成技能条目 / 删技能时跟着清。
const HUB_SKILL_MD = (name) => `---\nname: ${name}\ndescription: hub demo\n---\n\n正文\n`

test('R14：外部源技能装完留下来源记录（slug / version / pageUrl / installedAt）', async () => {
  const root = await makeRoot()
  const staging = await mkdtemp(join(tmpdir(), 'dsh-r14-'))
  try {
    // 直接调 importSkill（skillHubInstall 的落盘就是它）+ 写来源：这条钉的是**落盘形态**，
    // 不依赖网络（skillhub 下载在 skillhub-install.test.mjs 里另有真夹具覆盖）。
    const zip = makeZip([{ name: 'hubdemo/SKILL.md', data: HUB_SKILL_MD('hubdemo') }])
    const archive = join(staging, 'hubdemo.zip')
    await writeFile(archive, zip)
    const result = await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
    assert.equal(result.name, 'hubdemo')

    const written = await writeHubSource(result, { slug: 'demo-skill', version: '1.2.3', pageUrl: 'https://skillhub.cn/s/demo-skill' })
    assert.deepEqual([written.slug, written.version], ['demo-skill', '1.2.3'])
    assert.equal(hubSourcePath(result), join(root, 'hubdemo', '.hub.json'), 'bundle 的来源记录在技能目录里（删目录时连带删）')

    const read = await readHubSource(result)
    assert.deepEqual([read.slug, read.version, read.pageUrl], ['demo-skill', '1.2.3', 'https://skillhub.cn/s/demo-skill'])
    assert.match(read.installedAt, /^\d{4}-\d{2}-\d{2}T/, '装的时间要记（判断"多久没更新"用得上）')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
  }
})

test('R14：来源记录不会被当成技能条目（bundle 与 flat 两种形态）', async () => {
  const root = await makeRoot()
  try {
    // ① bundle：.hub.json 在技能目录里 —— 宿主的目录识别只认 SKILL.md，不受影响。
    const bundleZip = makeZip([{ name: 'hubdemo/SKILL.md', data: HUB_SKILL_MD('hubdemo') }])
    const staging = await mkdtemp(join(tmpdir(), 'dsh-r14b-'))
    try {
      const archive = join(staging, 'hubdemo.zip')
      await writeFile(archive, bundleZip)
      const bundle = await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
      await writeHubSource(bundle, { slug: 'demo', version: '1' })
      // ② flat：来源记录挂在 <name>.md 后面 —— 名字不再以 .md 结尾，所以不会被 *.md 匹配。
      const flat = await importSkill({ root, scope: 'global', source: { type: 'file', content: HUB_SKILL_MD('flat-hub') } })
      await writeHubSource(flat, { slug: 'flat-demo', version: '2' })
      assert.equal(hubSourcePath(flat), join(root, 'flat-hub.md.hub.json'))
      assert.equal(existsSync(join(root, 'flat-hub.md.hub.json')), true)
      // 反方向：这个名字**不是**一个技能条目（`.md` 结尾才算扁平技能）。
      assert.equal(existsSync(join(root, 'flat-hub.md.hub.json').replace('.hub.json', '')), true, '技能文件本身还在')
      // scanDisabledSkills 只认 `.disabled` 变体；.hub.json 不该出现在它返回的条目里。
      const disabled = await scanDisabledSkills({ root, scope: 'global' })
      assert.equal(disabled.some((row) => String(row.entry).includes('.hub.json')), false, '来源记录不得被扫成技能')
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('R14：删技能时来源记录跟着清（flat 显式删，bundle 随目录连带）', async () => {
  const root = await makeRoot()
  try {
    const flat = await importSkill({ root, scope: 'global', source: { type: 'file', content: HUB_SKILL_MD('flat-del') } })
    await writeHubSource(flat, { slug: 'flat-del', version: '3' })
    const record = join(root, 'flat-del.md.hub.json')
    assert.equal(existsSync(record), true, '前置：记录已落盘')
    await removeSkill(await resolveSkillTarget({ entry: 'flat-del.md', kind: 'flat', scope: 'global', root }))
    assert.equal(existsSync(record), false, '删除技能必须连带清掉来源记录——否则它会指向一个不存在的技能')

    const zip = makeZip([{ name: 'bundle-del/SKILL.md', data: HUB_SKILL_MD('bundle-del') }])
    const staging = await mkdtemp(join(tmpdir(), 'dsh-r14d-'))
    try {
      const archive = join(staging, 'bundle-del.zip')
      await writeFile(archive, zip)
      const bundle = await importSkill({ root, scope: 'global', source: { type: 'archive', path: archive } })
      await writeHubSource(bundle, { slug: 'bundle-del', version: '4' })
      await removeSkill(await resolveSkillTarget({ entry: 'bundle-del', kind: 'bundle', scope: 'global', root }))
      assert.equal(existsSync(join(root, 'bundle-del')), false, 'bundle 目录整个删掉')
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
