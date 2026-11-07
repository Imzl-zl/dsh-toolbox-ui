import assert from 'node:assert/strict'

const sameDeps = (previous, next) => previous !== undefined && next !== undefined
  && previous.length === next.length && next.every((value, index) => Object.is(value, previous[index]))

/** 单层组件的 Hook renderer；子组件仍保留为元素节点，effect 由测试显式提交。 */
export function createHookRenderer() {
  const roots = new Map()
  let current = null

  const hook = (kind, initialize) => {
    assert.ok(current, `${kind} must run inside a rendered component`)
    const index = current.cursor++
    if (index === current.hooks.length) current.hooks.push({ kind, ...initialize() })
    const slot = current.hooks[index]
    assert.equal(slot.kind, kind, `hook order changed at slot ${index}`)
    return slot
  }

  const memo = (kind, factory, deps) => {
    const slot = hook(kind, () => ({ initialized: false }))
    if (!slot.initialized || !sameDeps(slot.deps, deps)) {
      slot.value = factory()
      slot.deps = deps?.slice()
      slot.initialized = true
    }
    return slot.value
  }

  const render = (root) => {
    const previous = current
    current = root
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        root.dirty = false
        root.cursor = 0
        root.tree = root.Component(root.props)
        assert.equal(root.cursor, root.hooks.length, 'render called fewer hooks than before')
        if (!root.dirty) return root.tree
      }
      assert.fail('hook renderer exceeded 50 render-phase updates')
    } finally {
      current = previous
    }
  }

  const pendingEffects = () => [...roots.values()].flatMap((root) => root.hooks
    .filter((slot) => slot.kind === 'effect' && slot.pending))

  const flushEffects = () => {
    const effects = pendingEffects().map((slot) => ({ slot, pending: slot.pending }))
    // React commits all changed-effect cleanups before starting their replacements.
    for (const { slot } of effects) {
      slot.pending = null
      slot.cleanup?.()
      slot.cleanup = undefined
    }
    for (const { slot, pending } of effects) {
      slot.deps = pending.deps
      slot.initialized = true
      const cleanup = pending.effect()
      assert.ok(cleanup === undefined || typeof cleanup === 'function', 'effect must return a cleanup or undefined')
      slot.cleanup = cleanup
    }
  }

  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const rest = props ?? {}
      return {
        type,
        props: children.length === 0 ? rest : { ...rest, children: children.length === 1 ? children[0] : children },
        children,
      }
    },
    useState(initial) {
      const root = current
      const slot = hook('state', () => {
        const state = { value: typeof initial === 'function' ? initial() : initial }
        state.set = (next) => {
          const value = typeof next === 'function' ? next(state.value) : next
          if (!Object.is(value, state.value)) { state.value = value; root.dirty = true }
        }
        return { state }
      })
      return [slot.state.value, slot.state.set]
    },
    useRef(initial) { return hook('ref', () => ({ value: { current: initial } })).value },
    useMemo(factory, deps) { return memo('memo', factory, deps) },
    useCallback(callback, deps) { return memo('callback', () => callback, deps) },
    useEffect(effect, deps) {
      const slot = hook('effect', () => ({ initialized: false }))
      slot.pending = !slot.initialized || !sameDeps(slot.deps, deps)
        ? { effect, deps: deps?.slice() }
        : null
    },
    __render(Component, props) {
      let root = roots.get(Component)
      if (!root) {
        root = { Component, props, hooks: [], cursor: 0, dirty: false }
        roots.set(Component, root)
      }
      root.props = props
      return render(root)
    },
    __flushEffects: flushEffects,
    async __settle({ effects = true } = {}) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        for (const root of roots.values()) if (root.dirty) render(root)
        if (effects) flushEffects()
        // Flush resolved RPC promise chains without awaiting intentionally deferred responses.
        await new Promise((resolve) => setImmediate(resolve))
        if (![...roots.values()].some((root) => root.dirty) && (!effects || pendingEffects().length === 0)) return
      }
      assert.fail('hook renderer exceeded 50 effect/state flushes')
    },
    __unmount(Component) {
      const root = roots.get(Component)
      assert.ok(root, 'cannot unmount a component that was never rendered')
      roots.delete(Component)
      for (const slot of root.hooks) if (slot.kind === 'effect') slot.cleanup?.()
    },
  }
}
