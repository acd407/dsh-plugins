// Integration check: boots the real @deepseek-ai/dsh-llm service, mounts this
// plugin the way the loader does, and pushes one capacity refusal through the
// real `llm/stream` waterfall with a fake adapter. This verifies the wiring the
// unit tests stub out: service dispatch, the scope filter, and the chunk shape
// that `@deepseek-ai/dsh-llm-retry` later reads.
//
//   node scripts/integration.mjs
//   DSH_ROOT=/path/to/dsh node scripts/integration.mjs
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = process.env.DSH_ROOT ?? '/usr/lib/node_modules/@deepseek-ai/dsh'
const load = (relative) => import(pathToFileURL(join(dshRoot, 'node_modules', '@deepseek-ai', relative)).href)

const { Context } = await load('cordis/lib/index.js')
const { default: LlmRuntime, LlmAdapter } = await load('dsh-llm/lib/index.js')
const plugin = await import(new URL('../index.js', import.meta.url))

const CAPACITY = 'Temporary capacity limit. Please try again in 2s.'

class FakeAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'Fake' }
  }
  async listModels() {
    return [{ provider: 'fake', id: 'fake-model', name: 'Fake model', inputModalities: ['text'] }]
  }
  async resolveModel() {
    return {
      provider: 'fake',
      id: 'fake-model',
      name: 'Fake model',
      inputModalities: ['text'],
      context: { contextWindow: 100_000 },
    }
  }
  async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: CAPACITY, code: 'PI_AI_ERROR' } } }
  }
}

const root = new Context()
await root.plugin(LlmRuntime)
await root.plugin(plugin)
root.llm.registerAdapter(['fake'], new FakeAdapter())

const chunks = []
for await (const chunk of root.llm.stream({
  provider: 'fake',
  model: 'fake-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})) chunks.push(chunk)

const finish = chunks.at(-1)
assert.deepEqual(finish.reason.failure, {
  message: CAPACITY,
  code: 'RATE_LIMIT',
  providerRetryAfterMs: 2000,
})
assert.ok(root.llm.providerRetryPolicy('fake').retryableCodes.includes('RATE_LIMIT'))

await root.fiber.dispose()
console.log('PASS: capacity refusal reclassified through the real llm/stream waterfall')
