import assert from 'node:assert/strict'
import test from 'node:test'
import { TYPERT } from '../lib/typert.js'

const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement() {},
  useCallback() {},
  useEffect() {},
  useState() {},
}

function createFakeDocument(options = {}) {
  const styles = []
  const head = {
    appendChild(node) {
      if (options.appendError) throw options.appendError
      styles.push(node)
      node.remove = () => {
        if (options.removeError) throw options.removeError
        styles.splice(styles.indexOf(node), 1)
      }
    },
  }

  return {
    head,
    styles,
    createElement(name) {
      assert.equal(name, 'style')
      return { dataset: {}, textContent: '' }
    },
    querySelector(selector) {
      const id = /data-plugin-css="([^"]+)"/.exec(selector)?.[1]
      return styles.find((style) => style.dataset.pluginCss === id) ?? null
    },
  }
}

async function loadClient(document) {
  let client
  globalThis.document = document
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        client = definition.factory((name) => {
          assert.equal(name, 'react')
          return fakeReact
        })
      },
    },
  }

  await import(`../lib/client.js?test=${Date.now()}-${Math.random()}`)
  return {
    client,
    cleanup() {
      delete globalThis.document
      delete globalThis.window
    },
  }
}

test('client Remote contribution matches the generated Typert contract', async () => {
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  let contribution
  const ctx = {
    remote: {
      async $mount(value) {
        contribution = value
        return async () => {}
      },
    },
    slots: { inject() {} },
  }

  try {
    const dispose = await client.apply(ctx)
    const actual = contribution.descriptors.map((descriptor) => ({
      id: descriptor.id,
      parameters: descriptor.parameters.map((parameter) => ({ mode: parameter.codec.mode, typeSymbol: parameter.codec.typeSymbol })),
      result: { mode: descriptor.result.mode, typeSymbol: descriptor.result.typeSymbol },
      sourceLocation: descriptor.sourceLocation,
    }))
    const expected = TYPERT.invocations.map((invocation) => ({
      id: invocation.id,
      parameters: invocation.parameters.map((parameter) => ({ mode: parameter.codec.mode, typeSymbol: parameter.codec.typeSymbol })),
      result: { mode: invocation.result.mode, typeSymbol: invocation.result.typeSymbol },
      sourceLocation: invocation.sourceLocation,
    }))
    assert.deepEqual(actual, expected)
    const nameCodec = contribution.descriptors.find((descriptor) => descriptor.method === 'status').parameters[0].codec
    // 两条路径都要能拒非法值：`schema` 是 0.1.5-rc.x registry 走的那条，`create()` 是
    // 0.1.6-alpha.2 起走的那条（registry 用 `record.value ??= record.create()` 物化）。
    assert.throws(() => nameCodec.schema.parse(42), /string/i)
    assert.throws(() => nameCodec.create().parse(42), /string/i)
    await dispose()
  } finally {
    cleanup()
  }
})

test('the toolbox overlay receives the public connection generation source', { timeout: 60000 }, async () => {
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  const generation = { getSnapshot: () => undefined, subscribe: () => () => {} }
  let overlay
  const ctx = {
    get: (key) => key === 'connection' ? { generation } : undefined,
    remote: { $mount: async () => async () => {} },
    slots: {
      inject(_name, mount) { return mount() },
      register(options) { if (options.id === 'mcp-fab') overlay = options; return () => {} },
    },
  }
  try {
    const dispose = await client.apply(ctx)
    try {
      assert.equal(overlay.inject().connectionGeneration, generation, '只用宿主真实代次，不用 remote proxy 代替')
    } finally {
      await dispose()
    }
  } finally {
    cleanup()
  }
})

test('client descriptors carry both codec channels, including the skills namespace', async () => {
  // ⚠️ 这条补的是一个**真实漏测**（变异测试发现）：上面那条契约用例只比较
  // mode/typeSymbol，看不到 codec 内部；而 typert-manifest 的「双渠道」用例只读
  // **lib/typert.js**。于是「客户端的 codec 丢了 create()」能全绿通过——而它在
  // 0.1.6-alpha.2 起的宿主上会**加载即拒**（registry 用 `record.value ??= record.create()`
  // 物化 schema）。两侧是两份独立产物，必须各自验。
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  let contribution
  const ctx = {
    remote: { async $mount(value) { contribution = value; return async () => {} } },
    slots: { inject() {} },
  }

  try {
    const dispose = await client.apply(ctx)
    const codecs = []
    for (const descriptor of contribution.descriptors) {
      if (descriptor.invocation?.codec !== undefined) codecs.push([descriptor.id + ' receiver', descriptor.invocation.codec])
      for (const parameter of descriptor.parameters) codecs.push([descriptor.id + ' parameter ' + parameter.wire, parameter.codec])
      codecs.push([descriptor.id + ' result', descriptor.result])
    }
    assert.ok(codecs.length > 0)
    for (const [subject, codec] of codecs) {
      assert.equal(codec.mode, 'strict', subject + ' 必须是 strict codec')
      // 0.1.5-rc.x 那条线查 schema；0.1.6-alpha.2 起查 create()。两边都得有。
      assert.equal(typeof codec.schema?.parse, 'function', subject + ' 缺少 schema（0.1.5-rc.x 会加载即拒）')
      assert.equal(typeof codec.create, 'function', subject + ' 缺少 create()（0.1.6-alpha.2 起会加载即拒）')
      assert.equal(typeof codec.create().parse, 'function', subject + ' 的 create() 没有返回可用 schema')
    }
    // 反向下限：skills 的 descriptor 确实在里面，否则上面的循环对它们空转也会「通过」。
    //
    // ⚠️ 这里刻意用**下界**而不是精确数字（跨行教训 12：常驻的计数类断言用下界）。
    // 精确数字曾经用于抓「少登记一条 descriptor」，但那个职责已经由
    // package-contract 的三边同序用例**更精确地**承担了（它把 host 的 @Remote 清单、
    // lib/typert.js 的 invocations 与客户端的 descriptor 三者逐项比对：
    // 少一条就长度不等、错序就位置不等，两种都会红）。这里再用精确数字只会让
    // 「每加一个技能面方法就要改这个数字」——而它比真实契约更容易过期。
    const skills = contribution.descriptors.filter((descriptor) => descriptor.namespace === 'skillsManager')
    assert.ok(skills.length >= 13, `客户端的 skills descriptor 只读到 ${skills.length} 条（至少应有 13 条）`)
    await dispose()
  } finally {
    cleanup()
  }
})

test('both stylesheets are injected in a single call, not two', async () => {
  // ⚠️ SPEC 已核实的陷阱（client.js 的 __injectCss）：它的 id 与 data-plugin-css 是**写死**的
  // 'dsh-toolbox-ui/mcp.css'。以同一 id 二次调用会复用同一个 <style> 标签并**覆写**
  // textContent——也就是 skills 样式会把 MCP 面板样式**静默冲掉**（没有报错，只是面板变形）。
  // 所以两份样式必须合并成**一次**注入。
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  const ctx = {
    remote: { async $mount() { return async () => {} } },
    slots: { inject() {} },
  }

  try {
    const dispose = await client.apply(ctx)
    // 一次注入 ⇒ 文档里只有一个 style 标签。
    assert.equal(document.styles.length, 1, '两份样式必须一次注入（二次注入会覆写同一标签）')
    const text = document.styles[0].textContent
    // 两份样式的**内容都在**：只留一份就是被冲掉了。
    assert.match(text, /\.dsh-mcp-panel\{/, 'MCP 面板样式必须在注入的样式表里')
    assert.match(text, /\.dsh-skills-/, 'skills 样式必须在同一张样式表里（否则 MCP 样式会被冲掉）')
    await dispose()
  } finally {
    cleanup()
  }
})

test('a conflicting manager makes the plugin yield without registering any entry', async () => {
  // D15：检测到**另一个** MCP 管理插件时主动让位。
  //
  // ⚠️ 注意「让位」的准确含义（SPEC row 13 与 Architecture 段的措辞是「不注册**入口**并渲染提示」）：
  // 不注册的是**入口按钮**（悬浮按钮 / 侧栏入口）——它们才是会与另一个面板互相遮挡、
  // 且都去改写同一份 profile 配置的东西。让位提示本身仍要渲染出来，否则用户只看到
  // 「插件装了但什么都没有」，那比两个按钮并存更糟。所以这条断言的是
  // 「入口不在 + 提示在」，不是「一个 slot 都没有」。
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  const registered = []
  const injected = []
  let mounted = false
  const skillsService = {
    async conflictingManager() { return { ok: true, value: { id: 'other-manager', name: 'dsh-mcp-manager-ui-old' } } },
  }
  const ctx = {
    remote: {
      async $mount() { mounted = true; return async () => {} },
      skillsManager: skillsService,
    },
    get(name) {
      if (name === 'remote.skillsManager') return skillsService
      return undefined
    },
    slots: {
      inject(name, mount) { injected.push(name); mount() },
      register(options) { registered.push(options.id); return () => {} },
    },
  }

  try {
    const dispose = await client.apply(ctx)
    assert.equal(mounted, true, '仍要完成 Remote mount（提示需要它）')
    // 让位的核心：两个会打架的入口都不得注册。
    assert.equal(registered.includes('mcp-fab'), false, '让位时不得注册悬浮按钮入口')
    assert.equal(injected.includes('sidebar.footer.action'), false, '让位时不得注册侧栏入口')
    // 但提示必须渲染出来（否则用户什么都看不到）。
    assert.equal(registered.includes('mcp-handover'), true, '让位时必须渲染提示')
    await dispose()
  } finally {
    cleanup()
  }
})

test('client mount failure aborts plugin activation without UI side effects', async () => {
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  const duplicate = new Error('Remote package "dsh-toolbox-ui" is already registered')
  const ctx = {
    remote: {
      async $mount() {
        throw duplicate
      },
    },
    slots: {
      inject() {
        throw new Error('slots must not register after Remote mount fails')
      },
    },
  }

  try {
    await assert.rejects(client.apply(ctx), duplicate)
    assert.equal(document.styles.length, 0)
  } finally {
    cleanup()
  }
})

test('stylesheet setup failure rolls back Remote registration', async () => {
  const cssError = new Error('stylesheet append failed')
  const document = createFakeDocument({ appendError: cssError })
  const { client, cleanup } = await loadClient(document)
  let remoteDisposed = false
  const ctx = {
    remote: {
      async $mount() {
        return async () => {
          await Promise.resolve()
          remoteDisposed = true
        }
      },
    },
    slots: {
      inject() {
        throw new Error('slots must not register after stylesheet setup fails')
      },
    },
  }

  try {
    await assert.rejects(client.apply(ctx), cssError)
    assert.equal(remoteDisposed, true)
  } finally {
    cleanup()
  }
})

test('client disposer releases Remote registration and stylesheet', async () => {
  const document = createFakeDocument()
  const { client, cleanup } = await loadClient(document)
  let remoteDisposed = false
  let releaseRemote
  const slots = []
  let timer
  const ctx = {
    remote: {
      async $mount() {
        return async () => {
          await new Promise((resolve) => {
            releaseRemote = resolve
          })
          remoteDisposed = true
        }
      },
    },
    slots: {
      inject(name, mount) {
        slots.push(name)
        mount()
      },
      register(options) {
        // 只有需要 call/timer 的入口声明 inject；侧栏入口是无 inject 的纯组件注册。
        if (typeof options.inject === 'function') timer = options.inject().timer
      },
    },
  }

  try {
    const dispose = await client.apply(ctx)
    assert.deepEqual(slots, ['shell.overlay', 'sidebar.footer.action'])
    assert.equal(document.styles.length, 1)
    // 注入的样式必须同时盖两个属性（与官方构建器 styleInjectionModule 一致）：
    //   data-plugin     模块加载器认领/清理的凭据 —— removeOwnedStyles 只删
    //                   data-plugin === 插件 id 的标签；缺它就只能靠"materialize
    //                   期间新出现的未打标 style"兜底认领，窗口外插入的标签会变孤儿。
    //   data-plugin-css 本插件自己的去重键。
    assert.equal(document.styles[0].dataset.plugin, 'dsh-toolbox-ui')
    assert.equal(document.styles[0].dataset.pluginCss, 'dsh-toolbox-ui/mcp.css')

    let timeoutFired = false
    timer.timeout(() => {
      timeoutFired = true
    }, 0)

    const disposing = dispose()
    assert.equal(typeof disposing?.then, 'function')
    assert.equal(remoteDisposed, false)
    assert.equal(document.styles.length, 0)

    releaseRemote()
    await disposing
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(remoteDisposed, true)
    assert.equal(timeoutFired, false)
  } finally {
    cleanup()
  }
})

test('Remote teardown still completes when stylesheet cleanup fails', async () => {
  const cssError = new Error('stylesheet removal failed')
  const document = createFakeDocument({ removeError: cssError })
  const { client, cleanup } = await loadClient(document)
  let remoteDisposed = false
  const ctx = {
    remote: {
      async $mount() {
        return async () => {
          await Promise.resolve()
          remoteDisposed = true
        }
      },
    },
    slots: {
      inject() {},
    },
  }

  try {
    const dispose = await client.apply(ctx)
    await assert.rejects(dispose(), cssError)
    assert.equal(remoteDisposed, true)
  } finally {
    cleanup()
  }
})
