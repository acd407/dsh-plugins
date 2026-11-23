import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_CONFIG,
  captureBuiltinApplyPatch,
  isGptModel,
  registerGptApplyPatch,
} from '../lib/gate.js'

/** A ctx stub whose tools.register records the mounted definitions. */
function mockContext({ toolsRegister } = {}) {
  const registered = []
  const effects = []
  const disposers = []
  const ctx = {
    fs: { sandboxMode: undefined, resolve() {}, stat() {}, readText() {}, writeText() {} },
    get() { return undefined },
    emit() {},
    waterfall() {},
    inject() {},
    systemPrompt: {
      section() { throw new Error('the built-in guidance section must be suppressed') },
      getSectionOrder() { return 0 },
    },
    tools: {
      register(definition, options) {
        registered.push({ definition, options })
        return toolsRegister ?? (() => {})
      },
      get() { return undefined },
    },
    effect(fn, label) {
      effects.push(label)
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, registered, effects, disposers }
}

/** A stand-in for the host `dsh-tool-fs` plugin's apply. */
function fakeToolFs(definition = defaultDefinition()) {
  return (shadow, config) => {
    assert.deepEqual(config, BUILTIN_CONFIG)
    shadow.systemPrompt.section({ name: 'apply_patch', order: 0, content: 'guidance' })
    shadow.tools.register(definition)
  }
}

function defaultDefinition() {
  return {
    name: 'apply_patch',
    description: 'Edits files with a Codex-style patch.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'the patch' } },
      required: ['input'],
    },
    execute: async () => ({ ok: true }),
    presentCall: () => ({ title: 'apply_patch' }),
  }
}

test('gpt-* model detection', () => {
  assert.equal(isGptModel('gpt-6.1-sol'), true)
  assert.equal(isGptModel('gpt-6-sol'), true)
  assert.equal(isGptModel('gpt-6.2-astra'), true)
  assert.equal(isGptModel('deepseek-v4.1-flash'), false)
  assert.equal(isGptModel('gemini-4-argon'), false)
  assert.equal(isGptModel(undefined), false)
})

test('captures the built-in definition through the suppression proxy', () => {
  const { ctx } = mockContext()
  const definition = captureBuiltinApplyPatch(ctx, fakeToolFs())
  assert.equal(definition.name, 'apply_patch')
  assert.equal(typeof definition.execute, 'function')
  assert.ok(definition.parameters.properties.input)
})

test('registers the captured definition once with the Codex input argument', () => {
  const { ctx, registered, effects } = mockContext()
  registerGptApplyPatch(ctx, fakeToolFs())
  assert.deepEqual(effects, ['gpt-apply-patch: apply_patch'])
  assert.equal(registered.length, 1)
  const { definition } = registered[0]
  assert.equal(definition.name, 'apply_patch')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.presentCall, 'function')
  assert.ok(definition.parameters.properties.input)
  assert.equal(definition.parameters.properties.patch, undefined)
  assert.match(definition.description, /Prefer apply_patch/)
  assert.match(definition.description, /not rolled back/)
})

test('admits only gpt-* model selections per step', () => {
  const { ctx, registered } = mockContext()
  registerGptApplyPatch(ctx, fakeToolFs())
  const { when } = registered[0].options
  assert.equal(when({ modelSelection: { model: 'gpt-6.1-sol' } }), true)
  assert.equal(when({ modelSelection: { model: 'deepseek-v4.1-flash' } }), false)
  assert.equal(when({}), false)
})

test('refuses a host plugin that registers no apply_patch', () => {
  const { ctx } = mockContext()
  assert.throws(
    () => registerGptApplyPatch(ctx, (shadow) => shadow.tools.register({ name: 'read', description: 'x', parameters: {} })),
    /did not register an apply_patch definition/,
  )
})

test('refuses a missing host plugin', () => {
  const { ctx } = mockContext()
  assert.throws(() => registerGptApplyPatch(ctx, undefined), /did not provide an apply function/)
})

test('disposes the registration through ctx.effect', () => {
  let disposed = false
  const { ctx, effects, disposers } = mockContext({
    toolsRegister: () => {
      disposed = true
    },
  })
  registerGptApplyPatch(ctx, fakeToolFs())
  assert.deepEqual(effects, ['gpt-apply-patch: apply_patch'])
  assert.equal(disposed, false)
  disposers[0]()
  assert.equal(disposed, true)
})
