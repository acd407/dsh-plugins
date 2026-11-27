/**
 * @local/llm-capacity-retry — keep transient upstream capacity refusals
 * retryable.
 *
 * PackyCode's Codex channel reports a saturated upstream inside the stream it
 * has already answered 200 for: an SSE `error` event carrying
 * `rate_limit_exceeded` / "Temporary capacity limit. Please try again in 2s."
 * before any output. The OpenAI SDK raises that without an HTTP status, so
 * DSH's pi-ai adapter (`classifyPiAiError`) cannot recognise it and files it as
 * `PI_AI_ERROR` — a code no retry policy re-runs. The turn ends instead of
 * resending a request the official Codex client would resend.
 *
 * This plugin wraps `llm/stream` (the documented waterfall around every
 * streaming model call) and rewrites only the failure `code` of such a
 * refusal to `RATE_LIMIT`, which the route's own policy already retries
 * (PackyCode: 20 attempts, 500 ms base backoff, 10 s cap). The upstream
 * sentence is preserved for the user, no key is blamed, and nothing is
 * reclassified unless the message is explicitly transient.
 *
 * It is provider-agnostic on purpose: any adapter that leaves a capacity
 * refusal unclassified benefits, and the wording gate keeps permanent errors
 * terminal.
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
  /** Failure codes eligible for reclassification. */
  codes: Object.freeze(['PI_AI_ERROR']),
  /** Code written when a transient capacity refusal is recognised. */
  code: 'RATE_LIMIT',
  /** Use the pause the message names as the retry delay. */
  honorRetryHint: true,
  /** Upper bound for a parsed pause; above a policy's maxDelayMs it would stop normal-mode retries. */
  maxHintMs: 10000,
  /**
   * Treat any `PI_AI_ERROR` that is not recognisably permanent as retryable,
   * not just capacity wording. See {@link isFallbackCandidate}.
   */
  fallback: false,
})

/**
 * Wording that means "the key or its balance is the problem". These never
 * get reclassified: quota and auth failures must stay terminal for the step so
 * key rotation and the user-facing message keep working.
 */
const KEY_OR_QUOTA =
  /quota|balance|insufficient|余额|额度|令牌|\b40[13]\b|invalid[\s_-]*key|unauthori[sz]ed|forbidden|only accessible via the official|官方客户端/i

/** Explicit capacity phrasing, including the Codex channel's own sentence. */
const CAPACITY =
  /temporar(?:y|ily)\b[^.]{0,60}capacity|capacity\b[^.]{0,60}(?:limit|exceeded|reached|constraint)|at capacity|over capacity|no (?:free |available )?capacity|capacity is (?:full|exhausted)/i

/**
 * Saturation of a *shared pool* rather than of one model: the gateway's own
 * concurrency cap for the account (`gateway_concurrency_limit`), a full queue,
 * or too many concurrent requests. These clear on their own within seconds and
 * are what the gateway itself tells the caller to resend ("please retry later"),
 * so no separate pause hint is required.
 */
const CONCURRENCY =
  /\bgateway[_-]?concurrency[_-]?limit\b|\bconcurrency[\s_-]+(?:limit|cap|queue)\b[^.]{0,40}?\b(?:exceeded|reached|full|hit)\b|\btoo many concurrent\b|\bconcurrent[\s_-]+(?:requests?|calls?|sessions?)\b[^.]{0,30}?\b(?:exceeded|limit|reached)\b|并发(?:数|请求)?[^。]{0,10}(?:超|满|限制)/i

/** Generic overload phrasing, accepted only together with a concrete retry pause. */
const OVERLOAD =
  /overload|too many requests|rate limit|server is busy|service unavailable|try again later|稍后重试|服务繁忙/i

/** The pause a message names: "try again in 2s", "retry in 500 ms". */
const RETRY_HINT = /\b(?:try|retry)(?:\s+again)?\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i

/**
 * Wording that makes a failure permanent for this step: a resend cannot change
 * an auth decision, an exhausted balance, a malformed request, a missing model,
 * a context overflow or a content refusal. Used only by `fallback` mode, which
 * otherwise reclassifies any `PI_AI_ERROR`.
 *
 * The HTTP status tokens are checked as a whole number so a `15` in a message
 * body is not read as 4xx/5xx; only leading or standalone status codes count.
 */
const PERMANENT =
  /quota|balance|insufficient|余额|额度|令牌|invalid[\s_-]*(?:api[\s_-]*)?key|unauthori[sz]ed|forbidden|only accessible via the official|官方客户端|\b(?:400|401|403|404|405|409|413|415|422)\b|context[\s_-]*window|too long|maximum context|content[\s_-]*(?:policy|filter)|refus|unsupported|not[\s_-]*supported|unknown[\s_-]*model|model[\s_-]*not[\s_-]*found|无可用渠道|未覆盖供应商|套餐|订阅|\bplans?\b|\bsubscription\b/i

/**
 * Whether one failure message is an upstream capacity refusal a resend clears.
 *
 * @param message - provider failure text, as the adapter carried it.
 * @returns true only when the text is transient capacity wording.
 */
export function isCapacityFailure(message) {
  if (typeof message !== 'string' || message.length === 0) return false
  if (KEY_OR_QUOTA.test(message)) return false
  if (CAPACITY.test(message)) return true
  if (CONCURRENCY.test(message)) return true
  return OVERLOAD.test(message) && RETRY_HINT.test(message)
}

/**
 * Whether one unclassified failure may be treated as retryable anyway.
 *
 * `fallback` mode answers the case this plugin cannot enumerate: a gateway
 * invents a code of its own (`gateway_concurrency_limit`), the adapter has no
 * pattern for the sentence, and the harness files it as `PI_AI_ERROR` — a code
 * no retry policy runs. Rather than chase every new wording, everything that is
 * not recognisably permanent is treated as transient. The cost is that a
 * genuinely broken request the denylist misses is resent until the route's
 * budget runs out, so the route's `maxRetries` bounds it.
 *
 * @param message - provider failure text, as the adapter carried it.
 * @returns true when the failure is not provably permanent.
 */
export function isFallbackCandidate(message) {
  if (typeof message !== 'string' || message.length === 0) return false
  return !PERMANENT.test(message)
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
 * Rewrite one stream chunk when it is a terminal capacity refusal.
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
  if (failure === null || typeof failure !== 'object') return undefined
  if (!config.codes.includes(failure.code)) return undefined
  const transient = isCapacityFailure(failure.message) || (config.fallback && isFallbackCandidate(failure.message))
  if (!transient) return undefined
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
 * Wrap a chunk stream, rewriting terminal capacity refusals on the way.
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
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS, providers: [], codes: [...DEFAULTS.codes] }
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
  const fallback = take('fallback', (value) => typeof value === 'boolean', DEFAULTS.fallback)
  return { enabled, providers: [...providers], codes: [...codes], code, honorRetryHint, maxHintMs, fallback }
}

/** Describe one config field for a rejected-value warning. */
function describe(field) {
  switch (field) {
    case 'enabled':
    case 'honorRetryHint':
    case 'fallback':
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
