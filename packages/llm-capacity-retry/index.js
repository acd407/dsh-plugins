/**
 * @local/llm-capacity-retry — make the harness's unclassified model failures
 * retryable.
 *
 * DSH's pi-ai adapter (`classifyPiAiError`) gives every failure it recognises a
 * specific code: `AUTH`, `QUOTA`, `RATE_LIMIT`, `INVALID_REQUEST`, `SERVER`,
 * `TIMEOUT`, `TRANSPORT`, `CONTEXT_WINDOW_EXCEEDED`. What is left — a gateway
 * error nobody has a pattern for — becomes `PI_AI_ERROR`, and **no route lists
 * `PI_AI_ERROR` among its retryable codes**, so the step dies on its first
 * attempt even though the code means "unknown", not "permanent".
 *
 * Examples seen in practice: PackyCode answering
 * `gateway_concurrency_limit: Concurrency limit exceeded for account, please
 * retry later` inside an already-200 stream (the adapter looks for "rate limit",
 * not "concurrency limit"), and pi-ai's own `pending` / `deferred` terminal
 * states.
 *
 * So this plugin treats `PI_AI_ERROR` as retryable by default: one listener on
 * `llm/stream` rewrites the failure `code` to `RATE_LIMIT`, which every route's
 * policy already retries (PackyCode: 20 attempts, 500 ms base backoff, 10 s cap),
 * and the serial retry executor resends the step. The message, status, request
 * id and replay state are untouched, so the user still reads the upstream's own
 * words when the budget runs out.
 *
 * `guard: true` (default) keeps the handful of gateway refusals that can never
 * succeed on a resend terminal: an official-client-only channel, a key whose
 * groups do not cover the model, and a test-message refusal. Those are the cases
 * PackyCode deliberately reports as `PI_AI_ERROR` precisely so that nothing
 * retries them. Set `guard: false` to reclassify those too.
 */

/** Cordis plugin id used by loader diagnostics. */
export const name = '@local/llm-capacity-retry'

/**
 * Defaults for the row's optional `config`. No schema is exported: this plugin
 * has no settings surface, and the values are plain data a patch layer or a
 * test can override.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** Provider ids to inspect; empty means every provider. */
  providers: Object.freeze([]),
  /** Failure codes treated as "unknown, therefore worth resending". */
  codes: Object.freeze(['PI_AI_ERROR']),
  /** Code written so the route's retry policy picks the failure up. */
  code: 'RATE_LIMIT',
  /** Use the pause the message names as the retry delay. */
  honorRetryHint: true,
  /** Upper bound for a parsed pause; above a policy's maxDelayMs it would stop normal-mode retries. */
  maxHintMs: 10000,
  /** Keep refusals that a resend can never clear terminal; see {@link isMandatoryTerminal}. */
  guard: true,
})

/**
 * Refusals a resend cannot change. Each one is a decision about *this* request,
 * *this* key or *this* channel, not a transient fault:
 *
 * - a group that serves only the vendor's official client
 *   (`only accessible via the official Claude CLI`, `请使用标准 Codex 客户端`);
 * - a key whose groups do not cover the model (`当前令牌未覆盖供应商`,
 *   `无可用渠道`), which PackyCode reports as `model_not_found`;
 * - a connectivity-probe refusal, which PackyCode files under its own code but
 *   which arrives here as text when that code is unavailable;
 * - a rejected or missing credential.
 *
 * Retrying these costs the full budget (about three minutes on a 20-attempt
 * policy) and always ends in the same sentence.
 */
const MANDATORY_TERMINAL =
  /only accessible via the official|only accepts requests from the official|official\s+claude(?:\s*code)?\s*cli|官方\s*claude(?:\s*code)?\s*cli|请使用标准\s*codex\s*客户端|客户端存在异常|二次分发|API\s*转接|already connected and authorized|no need to send test messages|无可用渠道|未覆盖供应商|model[\s_-]*not[\s_-]*found|无效的令牌|令牌无效|invalid[\s_-]*(?:api[\s_-]*)?key|unauthori[sz]ed/i

/** The pause a message names: "try again in 2s", "retry in 500 ms". */
const RETRY_HINT = /\b(?:try|retry)(?:\s+again)?\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i

/**
 * Whether one refusal is one a resend can never clear.
 *
 * @param message - provider failure text, as the adapter carried it.
 * @returns true for the known permanent gateway and credential refusals.
 */
export function isMandatoryTerminal(message) {
  return typeof message === 'string' && message.length > 0 && MANDATORY_TERMINAL.test(message)
}

/**
 * Read the pause a capacity message names, capped for the retry executor.
 *
 * @param message - provider failure text.
 * @param capMs - largest pause to report.
 * @returns the pause in milliseconds, or undefined when the message names none.
 */
export function retryHintMs(message, capMs = DEFAULTS.maxHintMs) {
  if (typeof message !== 'string' || message.length === 0) return undefined
  const match = RETRY_HINT.exec(message)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match[2].toLowerCase()
  const ms = Math.round(value * (unit.startsWith('ms') || unit.startsWith('milli') ? 1 : 1000))
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, capMs)
}

/**
 * Whether one failure should be turned into the configured retryable code.
 *
 * @param failure - the finish chunk's failure.
 * @param config - normalised plugin config.
 * @returns true when the code is listed and no guard blocks it.
 */
export function shouldReclassify(failure, config) {
  if (failure === null || typeof failure !== 'object') return false
  if (!config.codes.includes(failure.code)) return false
  if (config.guard && isMandatoryTerminal(failure.message)) return false
  return true
}

/**
 * Rewrite one stream chunk when its failure is an unclassified one.
 *
 * Only the failure `code` and (optionally) `providerRetryAfterMs` change; the
 * message, status, request id, replay envelope and every other chunk pass
 * through untouched, so the user still reads the upstream's own words.
 *
 * @param chunk - one StreamChunk.
 * @param config - normalised plugin config.
 * @returns the replacement chunk, or undefined when the chunk stays as-is.
 */
export function rewriteChunk(chunk, config) {
  if (chunk === null || typeof chunk !== 'object') return undefined
  if (chunk.type !== 'finish' || chunk.reason?.kind !== 'error') return undefined
  const failure = chunk.reason.failure
  if (!shouldReclassify(failure, config)) return undefined
  const hint = config.honorRetryHint ? retryHintMs(failure.message, config.maxHintMs) : undefined
  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: {
        ...failure,
        code: config.code,
        ...(hint === undefined ? {} : { providerRetryAfterMs: hint }),
      },
    },
  }
}

/**
 * Wrap a chunk stream, rewriting unclassified failures on the way.
 *
 * @param open - thunk returning the downstream stream (awaited, so an inner
 *   asynchronous waterfall listener is supported).
 * @param config - normalised plugin config.
 * @returns the wrapped chunk stream.
 */
export async function* reclassify(open, config) {
  const stream = await open()
  for await (const chunk of stream) {
    yield rewriteChunk(chunk, config) ?? chunk
  }
}

/**
 * Validate the row's optional config, filling defaults.
 *
 * @param raw - the loader row's `config` value.
 * @param warn - sink for a rejected field, so a typo is not silent.
 * @returns the normalised config.
 */
export function normalizeConfig(raw, warn = () => {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULTS, providers: [], codes: [...DEFAULTS.codes] }
  }
  const source = raw
  const take = (field, accept, fallback) => {
    if (source[field] === undefined) return fallback
    const value = source[field]
    if (!accept(value)) {
      warn(`${name}: ignoring config.${field}; expected ${describe(field)}`)
      return fallback
    }
    return value
  }
  const enabled = take('enabled', (value) => typeof value === 'boolean', DEFAULTS.enabled)
  const providers = take(
    'providers',
    (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0),
    [...DEFAULTS.providers],
  )
  const codes = take(
    'codes',
    (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0),
    [...DEFAULTS.codes],
  )
  const code = take('code', (value) => typeof value === 'string' && value.length > 0, DEFAULTS.code)
  const honorRetryHint = take('honorRetryHint', (value) => typeof value === 'boolean', DEFAULTS.honorRetryHint)
  const maxHintMs = take(
    'maxHintMs',
    (value) => Number.isFinite(value) && value > 0,
    DEFAULTS.maxHintMs,
  )
  const guard = take('guard', (value) => typeof value === 'boolean', DEFAULTS.guard)
  return { enabled, providers: [...providers], codes: [...codes], code, honorRetryHint, maxHintMs, guard }
}

/** Describe one config field for a rejected-value warning. */
function describe(field) {
  switch (field) {
    case 'enabled':
    case 'honorRetryHint':
    case 'guard':
      return 'a boolean'
    case 'providers':
    case 'codes':
      return 'an array of non-empty strings'
    case 'maxHintMs':
      return 'a positive finite number'
    default:
      return 'a non-empty string'
  }
}

/**
 * Install the `llm/stream` listener.
 *
 * The listener is global: the LLM runtime dispatches through a scope filter,
 * so a plugin scoped below it would not see the call. It stays transparent
 * (returns `next()` untouched) for every request it does not rewrite.
 *
 * @param ctx - plugin context.
 * @param config - optional row config (validated above).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config, (warning) => ctx.logger?.warn?.(warning))
  if (!settings.enabled) return
  ctx.on(
    'llm/stream',
    (options, next) => {
      const provider = options?.provider
      if (settings.providers.length > 0 && !settings.providers.includes(provider)) return next()
      return reclassify(next, settings)
    },
    { global: true },
  )
}
