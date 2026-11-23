import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULTS,
  apply,
  isCapacityFailure,
  name,
  normalizeConfig,
  reclassify,
  retryHintMs,
  rewriteChunk,
} from '../index.js'

const CODEX_CAPACITY = 'Temporary capacity limit. Please try again in 2s.'
const SERVER_ERROR =
  'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.'

/** Build one terminal error finish chunk. */
function failureChunk(message, code = 'PI_AI_ERROR', extra = {}) {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message, code, ...extra } },
  }
}

/** A stream of the given chunks. */
async function* streamOf(...chunks) {
  for (const chunk of chunks) yield chunk
}

/** Collect a chunk stream. */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** A ctx stub that records the registration. */
function fakeCtx() {
  const registrations = []
  const warnings = []
  const ctx = {
    on(event, listener, options) {
      registrations.push({ event, listener, options })
      return () => {}
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, registrations, warnings }
}

test('recognises the Codex capacity sentence', () => {
  assert.equal(isCapacityFailure(CODEX_CAPACITY), true)
  assert.equal(isCapacityFailure('Upstream is at capacity, please retry'), true)
  assert.equal(isCapacityFailure('capacity limit reached for this channel'), true)
})

test('accepts overload wording only with a concrete pause', () => {
  assert.equal(isCapacityFailure('Server is busy, try again in 1s.'), true)
  assert.equal(isCapacityFailure('Server is busy.'), false)
  assert.equal(isCapacityFailure('service unavailable'), false)
})

test('never reclassifies quota, key or policy wording', () => {
  assert.equal(isCapacityFailure('insufficient quota, capacity limit reached'), false)
  assert.equal(isCapacityFailure('余额不足，请充值'), false)
  assert.equal(isCapacityFailure('HTTP 401 invalid key'), false)
  assert.equal(isCapacityFailure('This API endpoint is only accessible via the official Claude CLI'), false)
})

test('ignores non-transient and empty messages', () => {
  assert.equal(isCapacityFailure(''), false)
  assert.equal(isCapacityFailure(undefined), false)
  assert.equal(isCapacityFailure(SERVER_ERROR), false)
})

test('reads and caps the pause a message names', () => {
  assert.equal(retryHintMs(CODEX_CAPACITY), 2000)
  assert.equal(retryHintMs('retry in 500 ms'), 500)
  assert.equal(retryHintMs('try again in 30 seconds', 10000), 10000)
  assert.equal(retryHintMs('try again in 0s'), undefined)
  assert.equal(retryHintMs('no pause named here'), undefined)
})

test('rewrites only the failure code and keeps the upstream sentence', () => {
  const chunk = failureChunk(CODEX_CAPACITY, 'PI_AI_ERROR', {
    status: 503,
    requestId: 'req-1',
  })
  chunk.replayState = { response: { id: 'r' } }
  const rewritten = rewriteChunk(chunk, normalizeConfig({}))
  assert.equal(rewritten.reason.kind, 'error')
  assert.equal(rewritten.reason.failure.code, 'RATE_LIMIT')
  assert.equal(rewritten.reason.failure.message, CODEX_CAPACITY)
  assert.equal(rewritten.reason.failure.status, 503)
  assert.equal(rewritten.reason.failure.requestId, 'req-1')
  assert.equal(rewritten.reason.failure.providerRetryAfterMs, 2000)
  assert.deepEqual(rewritten.replayState, { response: { id: 'r' } })
  // The original chunk is untouched.
  assert.equal(chunk.reason.failure.code, 'PI_AI_ERROR')
})

test('omits the pause when the message names none', () => {
  const rewritten = rewriteChunk(failureChunk('Temporary capacity limit.'), normalizeConfig({}))
  assert.equal(rewritten.reason.failure.code, 'RATE_LIMIT')
  assert.equal('providerRetryAfterMs' in rewritten.reason.failure, false)
})

test('leaves every chunk it does not own exactly as it was', () => {
  const config = normalizeConfig({})
  assert.equal(rewriteChunk({ type: 'text-delta', index: 0, text: 'x' }, config), undefined)
  assert.equal(rewriteChunk({ type: 'finish', reason: { kind: 'stop' } }, config), undefined)
  assert.equal(rewriteChunk({ type: 'finish', reason: { kind: 'aborted', failure: { message: CODEX_CAPACITY, code: 'ABORTED' } } }, config), undefined)
  assert.equal(rewriteChunk(failureChunk(SERVER_ERROR), config), undefined)
  assert.equal(rewriteChunk(failureChunk(CODEX_CAPACITY, 'QUOTA'), config), undefined)
})

test('honours an extended code list', () => {
  const config = normalizeConfig({ codes: ['UNKNOWN'] })
  assert.equal(rewriteChunk(failureChunk('capacity limit reached', 'UNKNOWN'), config).reason.failure.code, 'RATE_LIMIT')
  assert.equal(rewriteChunk(failureChunk('capacity limit reached', 'PI_AI_ERROR'), config), undefined)
})

test('fills defaults for a missing or malformed config', () => {
  for (const raw of [undefined, null, 'nope', []]) {
    const settings = normalizeConfig(raw)
    assert.equal(settings.enabled, DEFAULTS.enabled)
    assert.deepEqual(settings.providers, [])
    assert.deepEqual(settings.codes, ['PI_AI_ERROR'])
    assert.equal(settings.code, 'RATE_LIMIT')
    assert.equal(settings.honorRetryHint, true)
    assert.equal(settings.maxHintMs, 10000)
  }
})

test('rejects invalid fields with a warning instead of failing the plugin', () => {
  const warnings = []
  const settings = normalizeConfig(
    { enabled: 'yes', providers: ['packycode', 7], codes: [], code: '', honorRetryHint: 'no', maxHintMs: -1 },
    (warning) => warnings.push(warning),
  )
  assert.equal(warnings.length, 6)
  assert.equal(settings.enabled, true)
  assert.deepEqual(settings.providers, [])
  assert.deepEqual(settings.codes, ['PI_AI_ERROR'])
  assert.equal(settings.code, 'RATE_LIMIT')
  assert.equal(settings.honorRetryHint, true)
  assert.equal(settings.maxHintMs, 10000)
})

test('keeps its own copy of every default array', () => {
  const first = normalizeConfig({})
  first.codes.push('SERVER')
  first.providers.push('x')
  const second = normalizeConfig({})
  assert.deepEqual(second.codes, ['PI_AI_ERROR'])
  assert.deepEqual(second.providers, [])
})

test('registers one global llm/stream listener', () => {
  const { ctx, registrations } = fakeCtx()
  apply(ctx, {})
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].event, 'llm/stream')
  assert.deepEqual(registrations[0].options, { global: true })
})

test('registers nothing when disabled', () => {
  const { ctx, registrations } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(registrations.length, 0)
})

/** Run the registered listener over a fake request. */
async function runListener(config, options, ...chunks) {
  const { ctx, registrations } = fakeCtx()
  apply(ctx, config)
  const listener = registrations[0].listener
  const stream = listener(options, () => streamOf(...chunks))
  assert.equal(typeof stream.then, 'undefined', 'the waterfall listener must return an async iterable synchronously')
  return collect(stream)
}

test('rewrites a capacity refusal inside the stream and passes the rest through', async () => {
  const pieces = [
    { type: 'block-start', index: 0, blockType: 'text' },
    failureChunk(CODEX_CAPACITY),
  ]
  const out = await runListener({}, { provider: 'packycode', model: 'gpt-6.2-sol' }, ...pieces)
  assert.equal(out.length, 2)
  assert.equal(out[0], pieces[0])
  assert.equal(out[1].reason.failure.code, 'RATE_LIMIT')
  assert.equal(out[1].reason.failure.providerRetryAfterMs, 2000)
})

test('stays transparent when scoped to other providers', async () => {
  const pieces = [failureChunk(CODEX_CAPACITY)]
  const out = await runListener({ providers: ['packycode'] }, { provider: 'r4coder' }, ...pieces)
  assert.equal(out[0], pieces[0])
})

test('wraps the matching provider only', async () => {
  const pieces = [failureChunk(CODEX_CAPACITY)]
  const out = await runListener({ providers: ['packycode'] }, { provider: 'packycode' }, ...pieces)
  assert.equal(out[0].reason.failure.code, 'RATE_LIMIT')
})

test('supports an asynchronous next() from another waterfall listener', async () => {
  const { ctx, registrations } = fakeCtx()
  apply(ctx, {})
  const listener = registrations[0].listener
  const stream = listener(
    { provider: 'packycode' },
    async () => streamOf(failureChunk(CODEX_CAPACITY)),
  )
  assert.equal(typeof stream.then, 'undefined')
  const out = await collect(stream)
  assert.equal(out[0].reason.failure.code, 'RATE_LIMIT')
})

test('propagates a thrown downstream failure', async () => {
  const config = normalizeConfig({})
  const boom = new Error('adapter exploded')
  async function* failing() {
    throw boom
  }
  await assert.rejects(collect(reclassify(() => failing(), config)), boom)
})

test('closes the downstream iterator when the consumer stops early', async () => {
  let closed = false
  async function* endless() {
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-start', index: 1, blockType: 'text' }
    } finally {
      closed = true
    }
  }
  const stream = reclassify(() => endless(), normalizeConfig({}))
  for await (const _chunk of stream) break
  assert.equal(closed, true)
})

test('is named for loader diagnostics', () => {
  assert.equal(name, '@local/llm-capacity-retry')
})
