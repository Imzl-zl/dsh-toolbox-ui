import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { rootContextOf } from '../lib/host-context.js'

test('a symbol-backed root takes precedence without touching the legacy property', () => {
  const root = {}
  const ctx = {
    [Symbol.for('cordis.root')]: root,
    get root() { throw new Error('legacy root is not accessible') },
  }
  assert.equal(rootContextOf(ctx), root)
})

test('legacy contexts and plain objects retain their root identity', () => {
  const root = {}
  assert.equal(rootContextOf({ root }), root)
  assert.equal(rootContextOf(root), root)
})

test('derived contexts share only their own Cordis application root', async () => {
  const a = new Context()
  const b = new Context()
  try {
    assert.equal(rootContextOf(a.extend()), a)
    assert.equal(rootContextOf(b.extend()), b)
  } finally {
    await a.fiber.dispose()
    await b.fiber.dispose()
  }
})
