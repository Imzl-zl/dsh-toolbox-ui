import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// R8：客户端面板的职责边界。
//
// McpTab 原来是一个 973 行、34 个 useState 的函数，其中一整套**隐式协议**（loadSeq 决定
// "响应还算不算数"、revisionRef 决定"内容没变就别重渲染"、manualRefreshSeq 决定"转圈何时停"）
// 分散在相隔几百行的位置，任何一处单独改动都表现为"界面停在旧数据"或"转圈不停"。
//
// 这组断言钉的是**归属**，不是行为（行为由 panel-chrome / client-behavior 守）：
// 状态与协议必须在 hook 里，组件只负责接线。
//
// ⚠️ 为什么必须是结构断言：本仓库的客户端测试跑不了真 hook（假 React 的 useEffect 是 noop），
// 所以"抽出来的 hook 没被用回去"这件事只能这样抓。等价性另有产物级证据——
// `.tmp-review/render-snapshot.mjs` 把 McpTab 渲染成 HTML，改动前后逐字节相同。

const shell = await readFile(new URL('../lib/client/70-shell.js', import.meta.url), 'utf8')
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 取 McpTab 组件体（从声明到深度归零的 `};`）。深度按花括号数，注释里的花括号不构成问题。 */
function componentBody(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith('const McpTab = (props) => {'))
  assert.notEqual(start, -1, '找不到 McpTab 的声明')
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i]) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
    if (i > start && depth === 0 && lines[i].trim() === '};') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error('找不到 McpTab 的结尾')
}

test('面板的数据面与明文状态住在 hook 里，组件不再各自持有', () => {
  const body = componentBody(shell)
  // ① 数据面的 11 份状态（列表 / 诊断 / 工作区 / 刷新中）必须来自 useMcpServers。
  for (const name of ['servers', 'error', 'refreshing', 'workspaces', 'globalServers', 'exclude', 'mountErrors', 'scopeErrors', 'restrictError', 'liveAgents']) {
    assert.equal(body.includes(`const [${name}, set`), false,
      `${name} 不得再由组件自己 useState：数据面归 useMcpServers（否则"谁在改它"又会散开）`)
  }
  // ② 三个协议 ref 同理。它们是**协议**而不是缓存：拆开改就会同时坏掉两个症状。
  for (const name of ['loadSeq', 'manualRefreshSeq', 'revisionRef']) {
    assert.equal(body.includes(`const ${name} = useRef`), false, `${name} 归 useMcpServers`)
  }
  // ③ 明文的整套状态机归 useReveal。
  assert.equal(body.includes('const [revealed, setRevealed]'), false, 'revealed 归 useReveal')
  assert.equal(body.includes('const [revealGeneration'), false, 'revealGeneration 归 useReveal')

  // ④ 反向：hook 必须真的被用起来。少了这一半，"把状态全删掉"也能让上面几条变绿。
  // 诊断的**数据面**在 hook 里（R10），组件只持有展开态——所以入参里必须有 diagEnabled。
  assert.ok(body.includes('useMcpServers({ call, scope, timer, flash, revealRevisionRef, clearRevealed, diagEnabled: diagOpen })'),
    'McpTab 必须调用 useMcpServers，并把 reveal 的两个接缝与诊断展开态传进去')
  assert.equal(body.includes('const [diagRows, set'), false, 'diagRows 是数据面，归 useMcpServers')
  assert.ok(body.includes('useReveal({ call, scope, resetOn: selected, flash })'), 'McpTab 必须调用 useReveal')
})

test('乐观更新后的作废只能走 invalidate()，不得裸改 revisionRef', () => {
  const body = componentBody(shell)
  // 这条钉的是 R8 真正修掉的耦合：原来组件里有 5 处 `revisionRef.current = ''`，每一处都在
  // 声明"我改了本地数据，下次 load 必须写回"，但它们相隔几百行、各自为政。包装成 invalidate()
  // 之后，这条协议有了名字，也不会再有人在组件里绕过它。
  assert.equal((body.match(/revisionRef/g) || []).length, 0,
    '组件里不得再出现 revisionRef：作废 revision 的唯一入口是 invalidate()（由 useMcpServers 提供）')
  assert.ok((body.match(/invalidate\(\)/g) || []).length >= 4, '乐观更新的每个出口都必须调用 invalidate()')
  // 作用域切换的"作废在途 + 清空数据"整块归 resetScope()。
  assert.ok(body.includes('resetScope();'), 'switchScope 必须走 resetScope()')
  assert.equal(body.includes('loadSeq.current += 1'), false, '作废在途请求只在 resetScope() 里做')
})

test('useReveal 必须在 flash 之后调用（TDZ 回归闸）', () => {
  // 实测踩过：hook 内部用 flash 报「读取配置失败」，把调用点放在 flash 的 const 之前，
  // 渲染时直接抛 `Cannot access 'flash' before initialization` —— 整页空白，而所有
  // 非渲染类断言仍然全绿。这类错误只有真的把组件渲染一次才会暴露。
  const body = componentBody(shell)
  const flashAt = body.indexOf('const flash = useCallback(')
  const revealAt = body.indexOf('useReveal({ call, scope, resetOn: selected, flash })')
  const serversAt = body.indexOf('useMcpServers({ call, scope, timer, flash')
  assert.ok(flashAt > 0 && revealAt > 0 && serversAt > 0, '三个调用点都必须存在')
  assert.ok(flashAt < revealAt, 'useReveal 必须在 flash 之后（它内部会调用 flash）')
  assert.ok(flashAt < serversAt, 'useMcpServers 必须在 flash 之后（load 用 flash 报刷新结果）')
  assert.ok(revealAt < serversAt, 'useMcpServers 要拿 useReveal 的 revealRevisionRef / clearRevealed')
})

test('组件规模不回退（这是 R8 的唯一量化指标，不是风格要求）', () => {
  const body = componentBody(shell)
  const lines = body.split('\n').length
  const states = (body.match(/useState\(/g) || []).length
  // R8 之前：973 行 / 34 useState / 6 useRef。
  // 本轮（useReveal + useMcpServers）：864 行 / 23 useState / 1 useRef。
  // 阈值取"比当前略宽松、比回退明显收紧"，用来抓"又往组件里塞状态"这一种形态。
  assert.ok(lines < 900, `McpTab 现在 ${lines} 行：新的加载/明文状态应当进 hook，而不是回到组件里`)
  assert.ok(states <= 24, `McpTab 现在 ${states} 个 useState：新增的数据面状态应当进 hook`)
  assert.equal((body.match(/useRef\(/g) || []).length <= 1, true, 'McpTab 只剩 panelRef 一个 ref')
})

test('hook 与组件在同一个分片里，client.js 仍由分片逐字节拼出', () => {
  // 为什么钉这个：hook 若被拆成独立分片，`test/client-parts-deps.test.mjs` 的分片依赖方向
  // 规则（PART_FORWARD_REFS）就要多登记一条；而本仓库的规矩是"只在真有前向依赖时登记"。
  // useReveal/useMcpServers 与 McpTab 在同一文件、同一作用域，不需要新的分片。
  assert.ok(shell.includes('function useReveal('), 'useReveal 必须定义在 70-shell 分片里')
  assert.ok(shell.includes('function useMcpServers('), 'useMcpServers 必须定义在 70-shell 分片里')
  assert.ok(client.includes('function useReveal(') && client.includes('function useMcpServers('),
    'lib/client.js 必须由分片拼接得到这两个 hook（跑 npm run client:write）')
})


// ── R8 第二批：SkillsPanel 的两个面 ──────────────────────────────────────
//
// 与 McpTab 同一套手法，但这一块的测试形态更好：`test/skills-client.test.mjs` 的 37 条用例
// 几乎全是**渲染树断言**（假 React 带 useState 槽位与重渲染循环），所以抽 hook 的接线错误
// 会被它当场抓住（实测抓到 4 次：`setHubDetail is not defined` / `selected is not defined` /
// `flash is not defined` / `installTarget is not defined`）。这一组只补"归属"那一半。

const skills = await readFile(new URL('../lib/client/80-skills-face.js', import.meta.url), 'utf8')

/** 取 SkillsPanel 组件体（从声明到深度归零的 `};`）。 */
function skillsPanelBody(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith('const SkillsPanel = ({'))
  assert.notEqual(start, -1, '找不到 SkillsPanel 的声明')
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    for (const char of lines[i]) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
    if (i > start && depth === 0 && lines[i].trim() === '};') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error('找不到 SkillsPanel 的结尾')
}

test('技能面板的两个面各自成 hook，组件只留纯视图状态', () => {
  const body = skillsPanelBody(skills)
  // 市场面的七个状态（含两个在途闸 ref）属于"翻页状态机"，不属于视图。
  for (const name of ['hub', 'hubCategory', 'hubCategoryLabels', 'hubDetail', 'marketDraft', 'hubKeyword']) {
    assert.equal(body.includes(`const [${name}, set`), false, `${name} 归 useSkillsHub`)
  }
  for (const name of ['hubRef', 'hubInFlight']) {
    assert.equal(body.includes(`const ${name} = useRef`), false, `${name} 归 useSkillsHub（两条在途闸的规则见 hook 注释）`)
  }
  // 管理面的数据与写动作属于"本地技能 + 磁盘"，同样不属于视图。
  for (const name of ['rows', 'selectedKey', 'body', 'busy', 'entry', 'scope', 'targets']) {
    assert.equal(body.includes(`const [${name}, set`), false, `${name} 归 useSkillsManage`)
  }
  // 反向：两个 hook 都必须真的被调用。
  assert.ok(body.includes('useSkillsHub({ call, localeV })'), 'SkillsPanel 必须调用 useSkillsHub')
  assert.ok(body.includes('useSkillsManage({ call, workspaces, onSummary, flash })'), 'SkillsPanel 必须调用 useSkillsManage')
  // 剩下的 useState 只允许是**纯视图筛选/折叠**状态：它们没有 owner 问题，也不该被搬走
  //（搬进 hook 会让 hook 认识筛选语义，那是视图的事）。
  const states = [...body.matchAll(/const \[([A-Za-z]+), set[A-Za-z]+\] = useState\(/g)].map((match) => match[1])
  assert.deepEqual(states.sort(), ['collapsedGroups', 'query', 'statusFilter'],
    'SkillsPanel 只该剩三个纯视图状态（筛选词 / 状态筛选 / 折叠集合）')
})

test('安装动作留在组件：它是两个面的唯一交汇点', () => {
  const body = skillsPanelBody(skills)
  // 为什么钉这条：confirmInstall 同时要读管理面的 installTarget（渲染派生）与市场面的
  // setHubDetail（披露弹窗）。放回任一 hook 都要么把另一面的 state 拖进来，要么把渲染派生值
  // 塞进 hook 的依赖 —— 这是**拆分的边界**，不是"还没拆干净"。
  assert.ok(body.includes('const confirmInstall = useCallback('), 'confirmInstall 留组件')
  assert.equal(skills.includes('confirmInstall: useCallback'), false, 'hook 里不该有 confirmInstall')
  assert.ok(body.includes('setEntry(null); setHubDetail(null);'), '装成功要同时收起管理面弹窗与市场面披露')
})

test('技能面板规模不回退', () => {
  const body = skillsPanelBody(skills)
  const lines = body.split('\n').length
  const stateCount = (body.match(/useState\(/g) || []).length
  // R8 第二批之前：493 行 / 16 useState / 3 useRef / 12 useCallback。
  // 现在：308 行 / 3 useState / 0 useRef / 2 useCallback。
  assert.ok(lines < 340, `SkillsPanel 现在 ${lines} 行：新的数据/市场状态应当进 hook`)
  assert.ok(stateCount <= 4, `SkillsPanel 现在 ${stateCount} 个 useState`)
  assert.ok(skills.includes('function useSkillsHub(') && skills.includes('function useSkillsManage('),
    '两个 hook 必须在 80-skills-face 分片里（不新增分片，避免动 PART_FORWARD_REFS）')
})
