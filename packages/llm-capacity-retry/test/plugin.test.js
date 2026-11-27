import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULTS,
  apply,
  isMandatoryTerminal,
  name,
  normalizeConfig,
  reclassify,
  retryHintMs,
  rewriteChunk,
  shouldReclassify,
} from '../index.js'

const GATEWAY_CONCURRENCY =
  'gateway_concurrency_limit: Concurrency limit exceeded for account, please retry later'
const CODEX_CAPACITY = 'Temporary capacity limit. Please try again in 2s.'
const UNKNOWN = 'some brand new gateway sentence with no status word at all'

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

test('PI_AI_ERROR is retryable whatever the wording', () => {
  const config = normalizeConfig({})
  for (const message of [GATEWAY_CONCURRENCY, CODEX_CAPACITY, UNKNOWN, 'pending', 'deferred']) {
    const rewritten = rewriteChunk(failureChunk(message), config)
    assert.equal(rewritten?.reason.failure.code, 'RATE_LIMIT', message)
    assert.equal(rewritten.reason.failure.message, message)
  }
})

test('leaves a code no policy retries alone', () => {
  const config = normalizeConfig({})
  for (const code of ['AUTH', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED']) {
    assert.equal(rewriteChunk(failureChunk('anything', code), config), undefined, code)
  }
})

test('keeps the gateway refusals a resend cannot clear terminal', () => {
  const config = normalizeConfig({})
  const permanent = [
    'This API endpoint is only accessible via the official Claude CLI',
    '请使用标准 Codex 客户端',
    '分组 image-sale 下模型 MiniMax-H3-Image 无可用渠道（distributor）',
    '当前令牌未覆盖供应商',
    'model_not_found: unknown model zz-9',
    '无效的令牌',
    '客户端存在异常，疑似二次分发',
  ]
  for (const message of permanent) {
    assert.equal(isMandatoryTerminal(message), true, message)
    assert.equal(shouldReclassify({ message, code: 'PI_AI_ERROR' }, config), false, message)
    assert.equal(rewriteChunk(failureChunk(message), config), undefined, message)
  }
})

test('guard: false reclassifies those too', () => {
  const config = normalizeConfig({ guard: false })
  const rewritten = rewriteChunk(
    failureChunk('This API endpoint is only accessible via the official Claude CLI'),
    config,
  )
  assert.equal(rewritten.reason.failure.code, 'RATE_LIMIT')
})

test('recognises ordinary quota and auth wording as not a policy refusal', () => {
  // A refusal of this kind arrives with its own code (QUOTA / AUTH), so the
  // guard does not need to match it; if it ever did, the code filter still
  // keeps it terminal.
  const config = normalizeConfig({ codes: ['QUOTA', 'AUTH'] })
  assert.equal(rewriteChunk(failureChunk('insufficient quota', 'QUOTA'), config).reason.failure.code, 'RATE_LIMIT')
})

test('reads and caps the pause a message names', () => {
  assert.equal(retryHintMs(CODEX_CAPACITY), 2000)
  assert.equal(retryHintMs('retry in 500 ms'), 500)
  assert.equal(retryHintMs('try again in 30 seconds', 10000), 10000)
  assert.equal(retryHintMs('try again in 0s'), undefined)
  assert.equal(retryHintMs('no pause named here'), undefined)
})

test('rewrites only the failure code and keeps everything else', () => {
  const chunk = failureChunk(GATEWAY_CONCURRENCY, 'PI_AI_ERROR', {
    status: 503,
    requestId: 'req-1',
  })
  chunk.replayState = { response: { id: 'r' } }
  const rewritten = rewriteChunk(chunk, normalizeConfig({}))
  assert.equal(rewritten.reason.kind, 'error')
  assert.equal(rewritten.reason.failure.code, 'RATE_LIMIT')
  assert.equal(rewritten.reason.failure.message, GATEWAY_CONCURRENCY)
  assert.equal(rewritten.reason.failure.status, 503)
  assert.equal(rewritten.reason.failure.requestId, 'req-1')
  assert.deepEqual(rewritten.replayState, { response: { id: 'r' } })
  // The original chunk is untouched.
  assert.equal(chunk.reason.failure.code, 'PI_AI_ERROR')
})

test('adds the named pause and omits it when none is named', () => {
  const withHint = rewriteChunk(failureChunk(CODEX_CAPACITY), normalizeConfig({}))
  assert.equal(withHint.reason.failure.providerRetryAfterMs, 2000)
  const withoutHint = rewriteChunk(failureChunk(UNKNOWN), normalizeConfig({}))
  assert.equal('providerRetryAfterMs' in withoutHint.reason.failure, false)
  const disabledHint = rewriteChunk(failureChunk(CODEX_CAPACITY), normalizeConfig({ honorRetryHint: false }))
  assert.equal('providerRetryAfterMs' in disabledHint.reason.failure, false)
})

test('leaves every chunk it does not own exactly as it was', () => {
  const config = normalizeConfig({})
  assert.equal(rewriteChunk({ type: 'text-delta', index: 0, text: 'x' }, config), undefined)
  assert.equal(rewriteChunk({ type: 'finish', reason: { kind: 'stop' } }, config), undefined)
  assert.equal(
    rewriteChunk({ type: 'finish', reason: { kind: 'aborted', failure: { message: UNKNOWN, code: 'ABORTED' } } }, config),
    undefined,
  )
  assert.equal(rewriteChunk({ type: 'finish', reason: { kind: 'error' } }, config), undefined)
})

test('honours an extended code list and a custom target code', () => {
  assert.equal(rewriteChunk(failureChunk(UNKNOWN, 'UNKNOWN'), normalizeConfig({ codes: ['UNKNOWN'] })).reason.failure.code, 'RATE_LIMIT')
  assert.equal(rewriteChunk(failureChunk(UNKNOWN, 'UNKNOWN'), normalizeConfig({})), undefined)
  assert.equal(
    rewriteChunk(failureChunk(UNKNOWN), normalizeConfig({ code: 'SERVER' })).reason.failure.code,
    'SERVER',
  )
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
    assert.equal(settings.guard, true)
  }
})

test('rejects invalid fields with a warning instead of failing the plugin', () => {
  const warnings = []
  const settings = normalizeConfig(
    {
      enabled: 'yes',
      providers: ['packycode', 7],
      codes: [],
      code: '',
      honorRetryHint: 'no',
      maxHintMs: -1,
      guard: 'yes',
    },
    (warning) => warnings.push(warning),
  )
  assert.equal(warnings.length, 7)
  assert.equal(settings.enabled, true)
  assert.deepEqual(settings.providers, [])
  assert.deepEqual(settings.codes, ['PI_AI_ERROR'])
  assert.equal(settings.code, 'RATE_LIMIT')
  assert.equal(settings.honorRetryHint, true)
  assert.equal(settings.maxHintMs, 10000)
  assert.equal(settings.guard, true)
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

test('rewrites an unclassified failure inside the stream and passes the rest through', async () => {
  const pieces = [{ type: 'block-start', index: 0, blockType: 'text' }, failureChunk(GATEWAY_CONCURRENCY)]
  const out = await runListener({}, { provider: 'packycode', model: 'gpt-6.2-sol' }, ...pieces)
  assert.equal(out.length, 2)
  assert.equal(out[0], pieces[0])
  assert.equal(out[1].reason.failure.code, 'RATE_LIMIT')
})

test('stays transparent when scoped to other providers', async () => {
  const pieces = [failureChunk(GATEWAY_CONCURRENCY)]
  const out = await runListener({ providers: ['packycode'] }, { provider: 'r4coder' }, ...pieces)
  assert.equal(out[0], pieces[0])
})

test('wraps the matching provider only', async () => {
  const pieces = [failureChunk(GATEWAY_CONCURRENCY)]
  const out = await runListener({ providers: ['packycode'] }, { provider: 'packycode' }, ...pieces)
  assert.equal(out[0].reason.failure.code, 'RATE_LIMIT')
})

test('supports an asynchronous next() from another waterfall listener', async () => {
  const { ctx, registrations } = fakeCtx()
  apply(ctx, {})
  const listener = registrations[0].listener
  const stream = listener({ provider: 'packycode' }, async () => streamOf(failureChunk(GATEWAY_CONCURRENCY)))
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
