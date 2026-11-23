import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** One fake agent whose model selection is recorded. */
function fakeAgent({ origin = 'subagent', isSeeded = false, parentSession, provider, model } = {}) {
  const selected = []
  const agent = {
    session: { header: { origin, isSeeded, parentSession } },
    model: {
      current() {
        return provider === undefined ? undefined : { provider, model }
      },
      select(route) {
        selected.push(route)
      },
    },
  }
  return { agent, selected }
}

/** A parent route the plugin reads through `ctx.agents`. */
function fakeParent(provider, model) {
  return { model: { current: () => ({ provider, model }) } }
}

/** A ctx stub capturing the agent/created listener and the services it reads. */
function fakeCtx({ selection, parent } = {}) {
  const listeners = []
  const warnings = []
  const ctx = {
    on(event, listener, options) {
      listeners.push({ event, listener, options })
      return () => {}
    },
    get(key) {
      return key === 'subagentModelSelection' ? selection : undefined
    },
    agents: { get: () => parent },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  }
  return { ctx, listeners, warnings }
}

/** Run one agent/created event through a freshly installed plugin. */
function created({ child, parent, selection }) {
  const { ctx, listeners, warnings } = fakeCtx({ selection, parent })
  apply(ctx)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'agent/created')
  assert.deepEqual(listeners[0].options, { global: true })
  listeners[0].listener({ agent: child.agent })
  return { selected: child.selected, warnings }
}

/** DSH 0.2.3+ settings service: `allowedRoutes()`. */
const allowedRoutesApi = (routes) => ({ allowedRoutes: () => routes })
/** DSH ≤ 0.2.2 settings service: `current()`. */
const currentApi = (enabled, routes) => ({ current: () => ({ enabled, allowedModels: routes }) })
const allowed = [{ provider: 'allowed', model: 'first' }, { provider: 'allowed', model: 'second' }]

test('is named for loader diagnostics and injects the agents service', () => {
  assert.equal(name, 'subagent-defaults')
  assert.deepEqual(inject, ['agents'])
})

test('registers one global agent/created listener', () => {
  const { ctx, listeners } = fakeCtx()
  apply(ctx)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'agent/created')
  assert.deepEqual(listeners[0].options, { global: true })
})

test('records the first authorized route on an inheriting child (allowedRoutes)', () => {
  const child = fakeAgent({ provider: 'parent-provider', model: 'parent-model', parentSession: 'parent' })
  const { selected } = created({
    child,
    parent: fakeParent('parent-provider', 'parent-model'),
    selection: allowedRoutesApi(allowed),
  })
  assert.deepEqual(selected, [{ provider: 'allowed', model: 'first' }])
})

test('records the first authorized route on an inheriting child (current)', () => {
  const child = fakeAgent({ provider: 'parent-provider', model: 'parent-model', parentSession: 'parent' })
  const { selected } = created({
    child,
    parent: fakeParent('parent-provider', 'parent-model'),
    selection: currentApi(true, allowed),
  })
  assert.deepEqual(selected, [{ provider: 'allowed', model: 'first' }])
})

test('leaves a child that already uses an authorized route alone', () => {
  const child = fakeAgent({ provider: 'allowed', model: 'first', parentSession: 'parent' })
  const { selected } = created({ child, selection: allowedRoutesApi(allowed) })
  assert.deepEqual(selected, [])
})

test('leaves an explicit child route alone', () => {
  const child = fakeAgent({ provider: 'explicit', model: 'chosen', parentSession: 'parent' })
  const { selected } = created({
    child,
    parent: fakeParent('parent', 'route'),
    selection: allowedRoutesApi(allowed),
  })
  assert.deepEqual(selected, [])
})

test('does nothing while the setting is disabled, absent or unreadable', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  for (const selection of [
    undefined,
    allowedRoutesApi(undefined),
    currentApi(false, allowed),
    {},
  ]) {
    const { selected } = created({ child, selection })
    assert.deepEqual(selected, [])
  }
})

test('ignores seeded, non-subagent and route-less sessions', () => {
  for (const child of [
    fakeAgent({ isSeeded: true, provider: 'parent', model: 'route' }),
    fakeAgent({ origin: 'user', provider: 'parent', model: 'route' }),
    fakeAgent({ provider: undefined }),
  ]) {
    const { selected } = created({ child, selection: allowedRoutesApi(allowed) })
    assert.deepEqual(selected, [])
  }
})

test('treats a throwing setting as no default and logs once', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  const selection = {
    allowedRoutes() {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    },
  }
  const { selected, warnings } = created({ child, selection })
  assert.deepEqual(selected, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /subagent-defaults: ignoring the Subagent model selection setting/)
})

test('treats a throwing current() the same way', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  const selection = {
    current() {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    },
  }
  const { selected, warnings } = created({ child, selection })
  assert.deepEqual(selected, [])
  assert.equal(warnings.length, 1)
})

test('applies the default even when the parent route is unknown', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  const { selected } = created({ child, selection: allowedRoutesApi(allowed) })
  assert.deepEqual(selected, [{ provider: 'allowed', model: 'first' }])
})
