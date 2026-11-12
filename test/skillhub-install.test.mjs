// 外部源（skillhub.cn）的**安装链路**：从「上游给的 zip」一路到「技能落在选定的根里」。
//
// 这条链路跨了三层（下载 → 归档导入 → 落盘），任何一层接错都会表现为「装完列表里没有」，
// 而单层的用例各自都是绿的。所以这里用**真的 HTTP**（本机起一个假上游）把整条链跑通：
//   · 上游只提供两个端点：/api/v1/download?slug=…（302）与 zip 本体；
//   · `DSH_SKILLHUB_BASE` 指向它 —— 这是 lib/skillhub.js 留出的唯一注入点，不必 stub 全局 fetch；
//   · 断言：技能真的出现在目标根、临时目录被清掉、失败路径如实报错且不留残骸。
//
// ⚠️ 落点自 2026-10-10 起**只认引用**：wire 送 `{source, root, projectPath}`，服务端拿自己
// 算出来的目标集合核对（resolveTargetReference），`writable` 一律以服务端那份为准。
// 所以这里的 ctx 必须能算出目标（loader 替身 + 指向临时目录的 config），
// 而且「裸 root」与「只读根」都必须被拒 —— 下面最后一条用例钉的就是这个。
//
// 不联网：假上游只监听 127.0.0.1，端口由系统分配。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { makeZip } from '../scripts/archive-fixtures.mjs'
import { SkillsManagerGateway } from '../lib/index.js'

const SKILL_MD = [
  '---',
  'name: hub-demo',
  'description: 来自 skillhub 的演示技能',
  '---',
  '',
  '# hub-demo',
  '',
  '正文。',
  '',
].join('\n')

const PROVIDER = '@deepseek-ai/dsh-skill-filesystem'

/** 假上游：一个 302 下载端点 + 一份真的 zip。 */
async function fakeHub() {
  const zip = makeZip([{ name: 'hub-demo/SKILL.md', data: SKILL_MD }])
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    if (req.url.startsWith('/api/v1/download')) {
      // 只认这一个 slug：让「上游 404」成为可测的路径（否则任何下载请求都成功，
      // 失败分支就成了永远跑不到的死代码）。
      const slug = new URL(req.url, 'http://127.0.0.1').searchParams.get('slug')
      if (slug !== 'hub-demo') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(302, { location: '/archive/hub-demo.zip' })
      res.end()
      return
    }
    if (req.url === '/archive/hub-demo.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.length) })
      res.end(zip)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: 'http://127.0.0.1:' + port,
    zip,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 一个舞台：临时目录里长出六个根，并给出能算出它们的 ctx。
 * 返回的 `target` 是面板会送的那种**引用**（source + root），不是裸路径。
 */
async function stage() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-hub-stage-'))
  const dshHome = join(base, 'dsh-home')
  const agentsHome = join(base, 'agents-home')
  const bundled = join(base, 'bundled')
  await mkdir(join(agentsHome, 'skills'), { recursive: true })
  await mkdir(bundled, { recursive: true })
  return {
    base,
    root: join(agentsHome, 'skills'),
    bundledRoot: bundled,
    ctx: {
      get: () => undefined,
      loader: {
        entries: () => [{
          options: {
            name: PROVIDER,
            config: { dshHome, agentsHome, bundledSkillDir: bundled },
          },
        }],
      },
    },
  }
}

/** 系统临时目录里的暂存目录集合。断言用它做**前后对比**：
 *  临时目录是全局共享的，直接断言「一个都没有」会被别的进程/别的用例干扰
 *  （全量并发跑时就撞上过）。要保证的是「本次没留下新的」。 */
const stagingDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('dsh-skillhub-')).sort()

/** 把假上游挂上，跑一段，再无论成败把环境与临时目录收干净。 */
async function withHub(fn) {
  const hub = await fakeHub()
  const previous = process.env.DSH_SKILLHUB_BASE
  process.env.DSH_SKILLHUB_BASE = hub.base
  try {
    return await fn(hub)
  } finally {
    if (previous === undefined) delete process.env.DSH_SKILLHUB_BASE
    else process.env.DSH_SKILLHUB_BASE = previous
    await hub.close()
  }
}

test('从上游 zip 安装：落到选定的根，且临时目录被清掉', async () => {
  const { base, root, ctx } = await stage()
  const stagingBefore = await stagingDirs()
  try {
    await withHub(async (hub) => {
      const result = await SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, {
        slug: 'hub-demo',
        source: 'user-agents',
        root,
        acknowledged: true,
      })
      // 落点就是引用的那个根（面板的「安装到」→ 全局/项目 × .dsh/.agents）
      assert.equal(result.root, root)
      assert.equal(result.name, 'hub-demo')
      assert.equal(result.kind, 'bundle')
      const body = await readFile(join(root, 'hub-demo', 'SKILL.md'), 'utf8')
      assert.match(body, /来自 skillhub 的演示技能/, '内容必须是上游那份 zip 里的')
      // R14：来源记录必须落盘（bundle 在技能目录里，删目录时连带清）。
      const hubRecord = await readFile(join(root, 'hub-demo', '.hub.json'), 'utf8')
      const parsed = JSON.parse(hubRecord)
      assert.equal(parsed.slug, 'hub-demo', 'slug 是追溯来源的唯一键')
      assert.equal(typeof parsed.version, 'string', '版本要记下来（哪怕是空串，也不能没有这个字段）')
      assert.match(parsed.installedAt, /^\d{4}-\d{2}-\d{2}T/, '装的时间要记')
      assert.equal(result.hub.slug, 'hub-demo', '结果里也要带来源：面板据此在装完的提示里说出处')
      // 302 被跟随了
      assert.deepEqual(hub.hits.filter((u) => u.startsWith('/api/v1/download')), ['/api/v1/download?slug=hub-demo'])
      assert.ok(hub.hits.includes('/archive/hub-demo.zip'), '要跟随 302 取到 zip 本体')
    })
    // 临时目录是 mkdtemp 出来的，装完不该留（留一份 zip 在 tmp 里是泄漏）
    assert.deepEqual(await stagingDirs(), stagingBefore, '临时目录必须在 finally 里清掉（不留新的）')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('参数与失败：缺 slug / 缺目标 / 上游 404，都要如实报错且不留临时目录', async () => {
  const { base, root, ctx } = await stage()
  const stagingBefore = await stagingDirs()
  try {
    await withHub(async () => {
      // 目标引用缺 source/root：不再接受「一个裸 root」，所以报的是缺引用
      await assert.rejects(
        () => SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, { slug: 'hub-demo', acknowledged: true }),
        /缺少技能目标引用/,
      )
      await assert.rejects(
        () => SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, { source: 'user-agents', root, acknowledged: true }),
        /缺少 slug/,
      )
      await assert.rejects(
        () => SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, { slug: 'missing-skill', source: 'user-agents', root, acknowledged: true }),
        /HTTP 404/,
      )
    })
    assert.deepEqual(await stagingDirs(), stagingBefore, '失败路径同样不留临时目录')
    // 失败时目标根里不能留下半成品
    await assert.rejects(() => stat(join(root, 'missing-skill')))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('信任边界：裸路径、只读根、缺确认，都在服务端被拒', async () => {
  // 这三条取代了「root / writable 直接取自载荷」的旧契约。旧版本下一个
  // `{root:'<任意目录>'}` 就能让宿主往那里落盘，`{writable:true}` 还能写进 bundled。
  const { base, root, bundledRoot, ctx } = await stage()
  const evil = await mkdtemp(join(tmpdir(), 'dsh-hub-evil-'))
  try {
    await withHub(async (hub) => {
      // ① 缺显式确认：UI 的勾选框只是它的界面，判据必须在服务端
      await assert.rejects(
        () => SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, { slug: 'hub-demo', source: 'user-agents', root }),
        /显式确认/,
        '确认必须上 wire，否则任何调用方都能绕过',
      )
      // ② 调用方自带的裸路径：不是宿主报告过的位置，一律拒
      await assert.rejects(
        () => SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, { slug: 'hub-demo', source: 'user-agents', root: evil, acknowledged: true }),
        /未知的技能目标/,
        '不得凭载荷里的路径落盘——落点必须是宿主自己算出来的目标',
      )
      // ③ bundled 只读：载荷里写 writable:true 也不算数
      await assert.rejects(
        () => SkillsManagerGateway.prototype.skillHubInstall.call({ ctx }, { slug: 'hub-demo', source: 'bundled', root: bundledRoot, writable: true, acknowledged: true }),
        /只读/,
        '只读根由服务端判定，载荷里的 writable 不再读',
      )
      assert.deepEqual(await readdir(bundledRoot), [], '内置根不得被写入')
      assert.deepEqual(hub.hits, [], '被拒的请求不该碰上游（拒在下载之前）')
    })
    assert.deepEqual(await readdir(evil), [], '被拒的目标目录不得出现任何内容')
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(evil, { recursive: true, force: true })
  }
})
