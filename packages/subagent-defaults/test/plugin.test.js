import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** Build one fake agent whose model selection is recorded. */
function fakeAgent({ origin = 'subagent', isSeeded = false, parentSession, provider, model, parentProvider, parentModel } = {}) {
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
  const parent = parentProvider === undefined
    ? undefined
    : {
        model: {
          current() {
            return { provider: parentProvider, model: parentModel }
          },
        },
      }
  return { agent, selected, parent }
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

/** Run one agent/created event through the installed listener. */
function created(config) {
  const { ctx, listeners, warnings } = fakeCtx(config)
  apply(ctx)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'agent/created')
  const { agent, selected } = config.child ?? fakeAgent()
  listeners[0].listener({ agent })
  return { selected, warnings }
}

test('is named for loader diagnostics and injects the agents service', () => {
  assert.equal(name, 'subagent-defaults')
  assert.deepEqual(inject, ['agents'])
})

test('records the first authorized route on an inheriting child', () => {
  const child = fakeAgent({
    provider: 'parent-provider',
    model: 'parent-model',
    parentSession: 'parent',
    parentProvider: 'parent-provider',
    parentModel: 'parent-model',
  })
  const { selected } = created({
    child,
    parent: child.parent,
    selection: { allowedRoutes: () => [{ provider: 'allowed', model: 'first' }, { provider: 'allowed', model: 'second' }] },
  })
  assert.deepEqual(selected, [{ provider: 'allowed', model: 'first' }])
})

test('leaves a child that already uses an authorized route alone', () => {
  const child = fakeAgent({ provider: 'allowed', model: 'first', parentSession: 'parent' })
  const { selected } = created({
    child,
    parent: child.parent,
    selection: { allowedRoutes: () => [{ provider: 'allowed', model: 'first' }] },
  })
  assert.deepEqual(selected, [])
})

test('leaves an explicit child route alone', () => {
  const child = fakeAgent({
    provider: 'explicit',
    model: 'chosen',
    parentSession: 'parent',
    parentProvider: 'parent',
    parentModel: 'route',
  })
  const { selected } = created({
    child,
    parent: child.parent,
    selection: { allowedRoutes: () => [{ provider: 'allowed', model: 'first' }] },
  })
  assert.deepEqual(selected, [])
})

test('does nothing while the setting is disabled or the service is absent', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  for (const selection of [undefined, { allowedRoutes: () => undefined }]) {
    const { selected } = created({ child, parent: child.parent, selection })
    assert.deepEqual(selected, [])
  }
})

test('ignores seeded, non-subagent and route-less sessions', () => {
  for (const child of [
    fakeAgent({ isSeeded: true, provider: 'parent', model: 'route' }),
    fakeAgent({ origin: 'user', provider: 'parent', model: 'route' }),
    fakeAgent({ provider: undefined }),
  ]) {
    const { selected } = created({
      child,
      parent: child.parent,
      selection: { allowedRoutes: () => [{ provider: 'allowed', model: 'first' }] },
    })
    assert.deepEqual(selected, [])
  }
})

test('treats a throwing setting as no default and logs once', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  const { selected, warnings } = created({
    child,
    parent: child.parent,
    selection: {
      allowedRoutes() {
        throw new Error('enabled subagent model selection requires at least one allowed model')
      },
    },
  })
  assert.deepEqual(selected, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /subagent-defaults: ignoring the Subagent model selection setting/)
})

test('applies the default even when the parent route is unknown', () => {
  const child = fakeAgent({ provider: 'parent', model: 'route' })
  const { selected } = created({
    child,
    parent: undefined,
    selection: { allowedRoutes: () => [{ provider: 'allowed', model: 'first' }] },
  })
  assert.deepEqual(selected, [{ provider: 'allowed', model: 'first' }])
})
