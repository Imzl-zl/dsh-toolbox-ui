// ContextFace 的提交契约：同一选择内结果单调推进，loading 由最近发出的请求收尾。
// 使用生产 renderClient 内存组装实际源片，不写 lib/client.js、不重实现组件业务。
// React/RPC/时钟只在环境边界替身化；断言实际 ContextFace 的元素、数值和状态提交。
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { renderClient } from '../scripts/build-client.mjs'
import { createHookRenderer } from '../test-support/hook-renderer.mjs'

const source = renderClient()
const marker = 'exports.inject = inject;'
assert.equal(source.split(marker).length, 2, '实际模块的测试导出边界必须唯一')
const instrumented = source.replace(marker, `${marker}\nexports.__contextRace = { ContextFace, formatTokens };`)

const collect = (tree, predicate, out = []) => {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const child of tree) collect(child, predicate, out); return out }
  if (predicate(tree)) out.push(tree)
  for (const child of tree.children ?? []) collect(child, predicate, out)
  return out
}
const byClass = (tree, name) => collect(tree, (node) => String(node.props?.className ?? '').split(' ').includes(name))
const textOf = (tree) => {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  return (tree.children ?? []).map(textOf).join(' ')
}

// 字段对应 context-report 的公开返回形状；期望标题、用量取自实际送入 RPC 的响应。
const reportFor = (id, used) => ({
  ok: true,
  at: 1,
  session: { id, title: `TITLE_${id}`, cwd: `/ws/${id}`, requests: 1, steps: 1, lastAt: 1, running: false },
  route: { provider: null, model: null, contextWindow: 1000 },
  budget: { window: 1000, used, projected: null, remaining: 1000 - used, ratio: used / 1000 },
  cache: { prompt: null, cacheRead: null, hitRate: null, sessionHitRate: null, fresh: null },
  tools: { total: 0, tokens: null, chars: 0, search: { calls: 0, byName: 0, byKeyword: 0, withResult: 0, resultChars: 0, recent: [] } },
  turns: [],
  turnTotal: 0,
  billed: { prompt: 0, cacheRead: 0, output: 0, requests: 0 },
  totals: { itemTokens: 0, measured: false, surfaceChars: 0 },
  kinds: [],
  items: [],
  notes: [],
  sessions: ['A', 'B'].map((sessionId, index) => ({
    id: sessionId, title: `TITLE_${sessionId}`, cwd: `/ws/${sessionId}`, workspace: sessionId,
    used: sessionId === id ? used : (index + 1) * 100, window: 1000, ratio: (sessionId === id ? used : (index + 1) * 100) / 1000,
    requests: 1, lastAt: 1, running: false, active: sessionId === id,
  })),
})

function createFixture(t, { observeConnection = false } = {}) {
  const renderer = createHookRenderer()
  let generation = { id: 1 }
  const generationListeners = new Set()
  const connectionGeneration = {
    getSnapshot: () => generation,
    subscribe(listener) {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  const requests = []
  const polls = new Set()
  const unexpectedCalls = []
  const postUnmountCommits = []
  let mounted = true
  let client
  const react = {
    ...renderer,
    useState(initial) {
      const [value, set] = renderer.useState(initial)
      return [value, (next) => {
        // 已卸载时没有可渲染 DOM；在实际组件的 state 写入边界记录提交尝试。
        if (!mounted) postUnmountCommits.push(next)
        set(next)
      }]
    },
  }
  vm.runInNewContext(instrumented, {
    console,
    document: { visibilityState: 'visible', querySelector: () => null, createElement: () => ({ dataset: {} }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval(run, ms) {
      assert.equal(ms, 3000, '修请求归属不能改变 3s 轮询')
      const poll = { run }
      polls.add(poll)
      return poll
    },
    clearInterval(poll) { assert.ok(polls.delete(poll), '轮询 cleanup 必须执行且只能执行一次') },
    setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => react) } }, addEventListener() {}, removeEventListener() {} },
  })
  const props = {
    connectionGeneration: observeConnection ? connectionGeneration : undefined,
    call(method, payload) {
      if (method !== 'contextReport') {
        unexpectedCalls.push({ method, payload })
        return Promise.reject(new Error(`unexpected RPC: ${method}`))
      }
      let resolve, reject
      const promise = new Promise((done, fail) => { resolve = done; reject = fail })
      const request = {
        payload,
        settled: false,
        reply(value) { assert.equal(request.settled, false, '请求只完成一次'); request.settled = true; resolve(value) },
        fail(error) { assert.equal(request.settled, false, '请求只完成一次'); request.settled = true; reject(error) },
      }
      requests.push(request)
      return promise
    },
  }
  const Component = client.__contextRace.ContextFace
  const render = () => renderer.__render(Component, props)
  const settle = async (options) => { await renderer.__settle(options); return render() }
  const unmount = () => { renderer.__unmount(Component); mounted = false }
  t.after(() => {
    if (mounted) unmount()
    assert.equal(polls.size, 0, '卸载必须清掉当前轮询')
    assert.equal(generationListeners.size, 0, '卸载必须收回连接代次订阅')
    assert.deepEqual(unexpectedCalls, [], '不能让组件 catch 吞掉测试环境中的错误 RPC')
  })
  const latest = (before) => {
    assert.equal(requests.length, before + 1, '一次触发必须发出一个实际请求')
    return requests.at(-1)
  }
  const initialReport = reportFor('A', 100)
  return {
    render, settle, unmount, requests, postUnmountCommits, initialReport,
    async mountOverview() {
      render()
      await settle()
      assert.equal(requests.length, 1)
      assert.equal(requests[0].payload?.sessionId, undefined)
      requests[0].reply(initialReport)
      await settle()
      assert.equal(byClass(render(), 'dsh-mcp-ctx-allrow').length, initialReport.sessions.length)
    },
    async select(id, { effects = true } = {}) {
      const row = byClass(render(), 'dsh-mcp-ctx-allrow').find((node) => node.props.key === `all:${id}`)
      assert.ok(row, '必须从实际总览行点击选择会话')
      const before = requests.length
      row.props.onClick()
      await settle({ effects })
      if (!effects) { assert.equal(requests.length, before, '新选择的请求只能由 effect 发起'); return }
      const request = latest(before)
      assert.equal(request.payload?.sessionId, id)
      return request
    },
    async backToOverview() {
      const back = byClass(render(), 'dsh-mcp-ctx-back')[0]
      assert.ok(back, '必须从实际详情按钮返回总览')
      const before = requests.length
      back.props.onClick()
      await settle()
      const request = latest(before)
      assert.equal(request.payload?.sessionId, undefined)
      request.reply(initialReport)
      await settle()
    },
    capturePoll() {
      assert.equal(polls.size, 1, '必须捕获组件实际注册的当前轮询回调')
      return [...polls][0].run
    },
    changeCallIdentity() {
      const previous = props.call
      props.call = (method, payload) => previous(method, payload)
    },
    changeConnectionGeneration(value) {
      generation = value
      for (const listener of generationListeners) listener()
    },
    removeConnectionGeneration() { props.connectionGeneration = undefined },
    async poll() {
      assert.equal(polls.size, 1, '重渲染不得积累轮询 effect')
      const before = requests.length
      ;[...polls][0].run()
      await settle()
      return latest(before)
    },
    assertShown(response) {
      const tree = render()
      const title = byClass(tree, 'dsh-mcp-ctx-session-title')
      assert.equal(title.length, 1, '当前选择的详情必须保持，不能被旧响应退回总览')
      assert.equal(textOf(title[0]), response.session.title, '报告标题必须来自有效请求')
      const values = byClass(tree, 'dsh-mcp-ctx-card-value')
      const used = collect(values[0], (node) => node.type === 'b')[0]
      assert.ok(used, '必须断言真实详情卡片中的用量，而非空树或总览行')
      assert.equal(textOf(used), client.__contextRace.formatTokens(response.budget.used), '旧响应不得覆盖有效报告的用量')
    },
    assertNoError() { assert.equal(byClass(render(), 'dsh-mcp-ctx-foot-err').length, 0, '旧错误不得覆盖有效报告状态') },
    assertLoading(expected) {
      const tree = render()
      const loading = byClass(tree, 'dsh-mcp-ctx-foot-live').length > 0
        || byClass(tree, 'dsh-mcp-ctx-empty').some((node) => textOf(node) === '正在读取上下文…')
      assert.equal(loading, expected, 'loading 只能由当前请求收尾')
    },
    assertWaiting() {
      const tree = render()
      assert.equal(byClass(tree, 'dsh-mcp-ctx-card-value').length, 0, '新选择没有报告时不能显示旧会话的用量')
      assert.equal(byClass(tree, 'dsh-mcp-ctx-back').length, 1, '详情还在加载也必须可返回总览')
      assert.equal(byClass(tree, 'dsh-mcp-ctx-empty').length, 1, '新选择必须显示真实加载态')
    },
  }
}

async function acrossTargets(fixture) {
  await fixture.mountOverview()
  const old = await fixture.select('A')
  await fixture.backToOverview()
  const current = await fixture.select('B')
  return { old, current }
}
const timeout = { timeout: 60000 }

test('首次读取新选择时不把总览报告画成该会话详情', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const current = await fixture.select('B')
  fixture.assertWaiting()
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

test('新选择首次读取失败时显示当前错误，不继续显示另一会话的数字', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const current = await fixture.select('B')
  current.fail(new Error('B temporarily unavailable'))
  await fixture.settle()
  const tree = fixture.render()
  assert.equal(byClass(tree, 'dsh-mcp-ctx-card-value').length, 0, 'B 读取失败时也不显示 A 的用量')
  assert.equal(byClass(tree, 'dsh-mcp-ctx-back').length, 1)
  assert.match(textOf(tree), /B temporarily unavailable/)
  const retry = retryFrom(fixture)
  retry()
  await fixture.settle()
  assert.equal(fixture.requests.at(-1).payload.sessionId, 'B')
  const response = reportFor('B', 220)
  fixture.requests.at(-1).reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

test('call 已布局提交但还未被动 cleanup：旧回退不得清空选择', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const old = await fixture.select('B')
  const before = fixture.requests.length
  fixture.changeCallIdentity()
  fixture.render()
  await fixture.settle({ effects: false })
  old.reply(reportFor('A', 330))
  await fixture.settle({ effects: false })
  assert.equal(fixture.requests.length, before, '尚未启动换源后的被动轮询')
  await fixture.settle()
  const current = fixture.requests.at(-1)
  assert.equal(current.payload.sessionId, 'B', '旧回退不能让新 call 首次请求总览')
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

test('call 身份不变的连接换代同步拒绝旧回退，并重新读取当前选择', timeout, async (t) => {
  const fixture = createFixture(t, { observeConnection: true })
  await fixture.mountOverview()
  const selected = await fixture.select('B')
  selected.reply(reportFor('B', 220))
  await fixture.settle()
  const old = await fixture.poll()
  const oldPoll = fixture.capturePoll()
  const before = fixture.requests.length
  // 连接来源已换代，故意在任何 React render/layout 或新轮询之前执行旧回调和响应。
  fixture.changeConnectionGeneration({ id: 2 })
  oldPoll()
  assert.equal(fixture.requests.length, before, '旧 poll 不得发新请求认领新代次')
  old.reply(reportFor('A', 330))
  await new Promise((resolve) => setImmediate(resolve))
  await fixture.settle()
  assert.equal(fixture.requests.length, before + 1, '换代应发出新的当前选择请求')
  const current = fixture.requests.at(-1)
  assert.equal(current.payload.sessionId, 'B', '换代前旧回退不得清空 B')
  fixture.assertWaiting()
  const response = reportFor('B', 440)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

test('连接代次提供者撤销，即使快照同为 undefined 也不得复用旧来源', timeout, async (t) => {
  const fixture = createFixture(t, { observeConnection: true })
  fixture.changeConnectionGeneration(undefined)
  await fixture.mountOverview()
  const old = await fixture.select('B')
  const before = fixture.requests.length
  fixture.removeConnectionGeneration()
  fixture.render()
  await fixture.settle({ effects: false })
  old.reply(reportFor('A', 330))
  await fixture.settle()
  assert.equal(fixture.requests.length, before + 1)
  const current = fixture.requests.at(-1)
  assert.equal(current.payload.sessionId, 'B', '无代次能力的兼容来源也必须重新读 B')
  current.reply(reportFor('B', 220))
  await fixture.settle()
  fixture.assertShown(reportFor('B', 220))
})

test('不同 target：旧成功不能覆盖新选择的报告', timeout, async (t) => {
  const fixture = createFixture(t)
  const { old, current } = await acrossTargets(fixture)
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
  old.reply(reportFor('A', 110))
  await fixture.settle()
  fixture.assertShown(response)
})

test('不同 target：旧宿主回退不能清空新选择', timeout, async (t) => {
  const fixture = createFixture(t)
  const { old, current } = await acrossTargets(fixture)
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  old.reply(reportFor('B', 330)) // A 已不存在，宿主回退到 B；该旧请求没有资格重置当前选择。
  await fixture.settle()
  fixture.assertShown(response)
})

for (const kind of ['result-error', 'rpc-error']) {
  test(`不同 target：旧 ${kind} 不能覆盖新成功`, timeout, async (t) => {
    const fixture = createFixture(t)
    const { old, current } = await acrossTargets(fixture)
    const response = reportFor('B', 220)
    current.reply(response)
    await fixture.settle()
    if (kind === 'result-error') old.reply({ ok: false, error: 'old target failed' })
    else old.fail(new Error('old target disconnected'))
    await fixture.settle()
    fixture.assertShown(response)
    fixture.assertNoError()
  })
}

for (const kind of ['success', 'result-error', 'rpc-error']) {
  test(`旧 ${kind} 的 finally 不能结束新 target 的 loading`, timeout, async (t) => {
    const fixture = createFixture(t)
    const { old, current } = await acrossTargets(fixture)
    fixture.assertLoading(true)
    if (kind === 'success') old.reply(reportFor('A', 110))
    else if (kind === 'result-error') old.reply({ ok: false, error: 'old target failed' })
    else old.fail(new Error('old target disconnected'))
    await fixture.settle()
    fixture.assertLoading(true)
    current.reply(reportFor('B', 220))
    await fixture.settle()
    fixture.assertLoading(false)
  })
}

test('选择已变、新 effect 尚未执行：旧成功没有提交窗口', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const old = await fixture.select('A')
  await fixture.backToOverview()
  await fixture.select('B', { effects: false })
  const before = fixture.requests.length
  old.reply(reportFor('A', 330))
  await fixture.settle({ effects: false })
  assert.equal(fixture.requests.length, before, '不得靠提前执行新 effect 掩盖竞态')
  fixture.assertWaiting()
  await fixture.settle()
  const current = fixture.requests.at(-1)
  assert.equal(current.payload?.sessionId, 'B')
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

for (const kind of ['success', 'result-error', 'rpc-error']) {
  test(`同 target 轮询乱序：旧 ${kind} 不能覆盖后发请求`, timeout, async (t) => {
    const fixture = createFixture(t)
    await fixture.mountOverview()
    const selected = await fixture.select('A')
    selected.reply(reportFor('A', 110))
    await fixture.settle()
    const old = await fixture.poll()
    const current = await fixture.poll()
    assert.equal(old.payload?.sessionId, current.payload?.sessionId)
    const response = reportFor('A', 330)
    current.reply(response)
    await fixture.settle()
    if (kind === 'success') old.reply(reportFor('A', 220))
    else if (kind === 'result-error') old.reply({ ok: false, error: 'old poll failed' })
    else old.fail(new Error('old poll disconnected'))
    await fixture.settle()
    fixture.assertShown(response)
    fixture.assertNoError()
  })
}

test('同 target：旧成功不能清除后发请求的错误', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const selected = await fixture.select('A')
  selected.reply(reportFor('A', 110))
  await fixture.settle()
  const old = await fixture.poll()
  const current = await fixture.poll()
  current.fail(new Error('current poll disconnected'))
  await fixture.settle()
  assert.equal(byClass(fixture.render(), 'dsh-mcp-ctx-foot-err').length, 1, '当前错误必须正常展示')
  old.reply(reportFor('A', 220))
  await fixture.settle()
  assert.equal(byClass(fixture.render(), 'dsh-mcp-ctx-foot-err').length, 1, '旧成功不能把当前错误改成健康状态')
})

for (const kind of ['success', 'result-error', 'rpc-error']) {
  test(`卸载后 pending ${kind} 不得提交任何状态`, timeout, async (t) => {
    const fixture = createFixture(t)
    await fixture.mountOverview()
    const pending = await fixture.select('A')
    fixture.unmount()
    if (kind === 'success') pending.reply(reportFor('A', 220))
    else if (kind === 'result-error') pending.reply({ ok: false, error: 'unmounted request failed' })
    else pending.fail(new Error('unmounted request disconnected'))
    // 不重挂组件来检查卸载：实际旧闭包的 setState 调用必须为零。
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fixture.postUnmountCommits.length, 0, '卸载后的旧闭包不得写 report/error/loading/selection')
  })
}

test('首次慢请求：新 poll 尚未完成时，先完成的同 scope 报告必须展示', timeout, async (t) => {
  const fixture = createFixture(t)
  fixture.render()
  await fixture.settle()
  assert.equal(fixture.requests.length, 1)
  const first = fixture.requests[0]
  const pendingPoll = await fixture.poll()
  assert.equal(first.payload?.sessionId, pendingPoll.payload?.sessionId)
  const firstResponse = reportFor('A', 110)
  const response = { ...firstResponse, sessions: firstResponse.sessions.filter((entry) => entry.id === firstResponse.session.id) }
  first.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
  fixture.assertLoading(true)
  const nextResponse = reportFor('A', 220)
  const current = { ...nextResponse, sessions: nextResponse.sessions.filter((entry) => entry.id === nextResponse.session.id) }
  pendingPoll.reply(current)
  await fixture.settle()
  fixture.assertShown(current)
  fixture.assertLoading(false)
})

test('同 target 持续慢轮询：后续 poll 已发出时，按序完成的报告仍须持续推进', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const selected = await fixture.select('A')
  selected.reply(reportFor('A', 110))
  await fixture.settle()
  let earlier = await fixture.poll()
  let later = await fixture.poll()
  // 不跳过、不合并轮询：每个响应完成时，下一次请求仍在途。
  for (const used of [220, 330, 440]) {
    const response = reportFor('A', used)
    earlier.reply(response)
    await fixture.settle()
    fixture.assertShown(response)
    fixture.assertLoading(true)
    earlier = later
    later = await fixture.poll()
  }
  const nextResponse = reportFor('A', 550)
  earlier.reply(nextResponse)
  await fixture.settle()
  fixture.assertShown(nextResponse)
  fixture.assertLoading(true)
  const lastResponse = reportFor('A', 660)
  later.reply(lastResponse)
  await fixture.settle()
  fixture.assertShown(lastResponse)
  fixture.assertLoading(false)
})

const retryFrom = (fixture) => {
  const button = collect(fixture.render(), (node) => node.type === 'button' && textOf(node) === '重试')[0]
  assert.ok(button, '必须捕获实际错误视图中的手动重试来源')
  return button.props.onClick
}
async function failedRetry(fixture) {
  fixture.render()
  await fixture.settle()
  assert.equal(fixture.requests.length, 1)
  fixture.requests[0].reply({ ok: false, error: 'initial request failed' })
  await fixture.settle()
  return retryFrom(fixture)
}

test('选择已变、cleanup 未执行：旧总览 poll 不得认领新来源或发出 RPC', timeout, async (t) => {
  const fixture = createFixture(t)
  await fixture.mountOverview()
  const oldPoll = fixture.capturePoll()
  await fixture.select('B', { effects: false })
  const before = fixture.requests.length
  oldPoll()
  await fixture.settle({ effects: false })
  assert.equal(fixture.requests.length, before, '旧回调不能用当前 epoch 重新认领请求归属')
  fixture.assertWaiting()
  await fixture.settle()
  const current = fixture.requests.at(-1)
  assert.equal(current.payload?.sessionId, 'B', '旧 cleanup 不得作废新选择的初次加载')
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

test('选择已变、cleanup 未执行：旧手动 retry 不得重新发起总览请求', timeout, async (t) => {
  const fixture = createFixture(t)
  const oldRetry = await failedRetry(fixture)
  oldRetry()
  await fixture.settle()
  fixture.requests.at(-1).reply(fixture.initialReport)
  await fixture.settle()
  await fixture.select('B', { effects: false })
  const before = fixture.requests.length
  oldRetry()
  await fixture.settle({ effects: false })
  assert.equal(fixture.requests.length, before, '手动来源同样必须保留创建时的选择身份')
  await fixture.settle()
  const current = fixture.requests.at(-1)
  assert.equal(current.payload?.sessionId, 'B')
  const response = reportFor('B', 220)
  current.reply(response)
  await fixture.settle()
  fixture.assertShown(response)
})

test('call prop 重装：已布局提交即拒绝旧 retry，旧 cleanup 不得使新来源失效', timeout, async (t) => {
  const fixture = createFixture(t)
  const oldRetry = await failedRetry(fixture)
  fixture.changeCallIdentity()
  fixture.render()
  await fixture.settle({ effects: false })
  const beforeSetup = fixture.requests.length
  oldRetry()
  await fixture.settle({ effects: false })
  assert.equal(fixture.requests.length, beforeSetup, '尚未 cleanup 的旧 RPC 来源也不能重新借用新生命周期')
  await fixture.settle()
  assert.equal(fixture.requests.length, beforeSetup + 1, '旧 cleanup 不得作废新来源的初次读取')
  fixture.requests.at(-1).fail(new Error('new source failed'))
  await fixture.settle()
  const newRetry = retryFrom(fixture)
  const older = await fixture.poll()
  const beforeRetry = fixture.requests.length
  newRetry()
  await fixture.settle()
  assert.equal(fixture.requests.length, beforeRetry + 1, '新来源的 retry 必须有效')
  const seed = reportFor('A', 220)
  const response = { ...seed, sessions: seed.sessions.filter((entry) => entry.active) }
  fixture.requests.at(-1).reply(response)
  await fixture.settle()
  fixture.assertShown(response)
  older.reply(reportFor('A', 330))
  await fixture.settle()
  fixture.assertShown(response)
})

test('卸载后旧手动 retry 不得发出 RPC 或提交 loading', timeout, async (t) => {
  const fixture = createFixture(t)
  const oldRetry = await failedRetry(fixture)
  const before = fixture.requests.length
  fixture.unmount()
  oldRetry()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.requests.length, before, '卸载不能让旧手动来源认领一个全新 epoch')
  assert.equal(fixture.postUnmountCommits.length, 0, '失效来源必须在任何状态提交之前被拒绝')
})

test('换源的新渲染不复用旧错误；未 setup 就卸载也不能激活旧 retry', timeout, async (t) => {
  const fixture = createFixture(t)
  const retry = await failedRetry(fixture)
  fixture.changeCallIdentity()
  const tree = fixture.render()
  assert.equal(byClass(tree, 'dsh-mcp-d-err').length, 0, '换源尚无结果时不显示旧错误及重试')
  assert.doesNotMatch(textOf(tree), /重试/)
  const before = fixture.requests.length
  fixture.unmount()
  retry()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.requests.length, before, '未进入实际生命周期的来源不能发出 RPC')
  assert.equal(fixture.postUnmountCommits.length, 0)
})
