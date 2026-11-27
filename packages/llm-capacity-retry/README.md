# @local/llm-capacity-retry

PackyCode's Codex channel reports a saturated upstream **inside the stream it has
already answered 200 for**: before any output it sends an SSE `error` event with
`rate_limit_exceeded` / `Temporary capacity limit. Please try again in 2s.`, then
`response.failed`. The OpenAI SDK raises that without an HTTP status, so DSH's
pi-ai adapter cannot classify it and files it as `PI_AI_ERROR` — a code the
PackyCode route's retry policy does not include. The turn ends immediately, while
the official Codex client would resend the request.

This bundle fixes the classification without touching the installed plugin's
built files.

## How it works

One listener on `llm/stream`, the documented waterfall around every streaming
model call:

1. read the request's `provider` (`providers` scoping) and pass anything
   unrelated to the next listener unchanged;
2. walk the chunks; for a terminal `finish` with `reason.kind === 'error'`, check
   whether the failure code is listed in `codes` (default `PI_AI_ERROR`) **and**
   the message is transient capacity wording;
3. decide whether the failure is transient; in the default wording mode that
   means capacity or concurrency wording (see below), and with `fallback: true`
   it means anything not provably permanent;
4. rewrite only that failure's `code` to `RATE_LIMIT` and, when the message
   names a pause ("try again in 2s"), set `providerRetryAfterMs` so the retry
   waits that long instead of the policy's base backoff.

Nothing else changes: the upstream sentence is preserved (it is what the user
sees if every retry fails), no key is disabled or rotated, and every other
failure — quota, auth, client policy, protocol errors — stays terminal.

`RATE_LIMIT` is already in the PackyCode route's retryable codes, and
`@deepseek-ai/dsh-llm-retry` re-runs the failed step in the same open turn, so
the retry needs no extra wiring: 20 attempts, 500 ms base backoff, 10 s cap on
that route.

## What counts as transient

Two gates, both ending in the same rewrite:

**Capacity and concurrency wording** (always on)

- `capacity limit`, `at capacity`, `over capacity`, `capacity is exhausted`,
  including the Codex channel's own `Temporary capacity limit …`
- the gateway's account-level pool: `gateway_concurrency_limit`,
  `concurrency limit exceeded`, `too many concurrent requests`, `并发已满`
- `overloaded`, `too many requests`, `rate limit`, `server is busy`,
  `service unavailable`, `服务繁忙` — **only** when the message also names a
  pause ("… try again in 2s")

**Fallback** (`fallback: true`, off by default)

Any `PI_AI_ERROR` whose text is not recognisably permanent. This exists because
a gateway can invent a code the adapter has no pattern for: PackyCode answers
`gateway_concurrency_limit: Concurrency limit exceeded for account, please retry
later`, DSH's pi-ai adapter only recognises "rate limit" (not "concurrency
limit"), so it files the failure as `PI_AI_ERROR`, and no retry policy runs it.

These stay terminal in both modes: quota/balance, invalid or unauthorised keys,
4xx status codes, context-window overflow, content refusals, unsupported input,
unknown models, plan/subscription refusals, and the gateway's
`无可用渠道` / `未覆盖供应商`.

The cost of `fallback` is that a permanent failure the denylist misses is resent
until the route's `maxRetries` runs out (PackyCode: 20 attempts, about three
minutes with the default backoff). Set `providers` to limit it to the routes you
trust, and turn it off to return to wording-only matching.

## Scope

- Applies to every provider by default: any adapter that leaves a transient
  capacity refusal unclassified benefits. A permanent error is never rewritten
  because the wording gate requires capacity/overload phrasing and excludes
  quota, key and client-policy wording.
- Only agent-loop steps retry. Title generation, auto-review and other direct
  `ctx.llm.stream()` callers still get a single attempt: the rewrite only changes
  the reported code there, no retry follows.
- The web-search path of `dsh-packycode-api` already resends capacity refusals
  on its own, so it is unaffected.

## Configuration

Optional, on the row in the profile patch layer (`cordis.patch.yml`):

```yaml
- id: llm-capacity-retry
  name: '@local/llm-capacity-retry'
  config:
    providers: [packycode]   # default: [] = every provider
    codes: [PI_AI_ERROR]     # default: [PI_AI_ERROR]
    code: RATE_LIMIT         # default: RATE_LIMIT
    honorRetryHint: true     # default: true
    maxHintMs: 10000         # default: 10000
    enabled: true            # default: true
```

Keep `maxHintMs` at or below the route's `maxDelayMs` (PackyCode: 10 s): a
named pause longer than that makes a normal-mode policy give up instead of
retrying. Invalid values are ignored with a warning in the host log and the
default is used.

## Tests

```sh
node --test test/*.test.js   # 21 unit tests, no DSH process needed
node scripts/integration.mjs  # real llm/stream waterfall in the installed DSH
```

The unit suite covers wording classification (capacity, gateway concurrency,
overload, quota/key and generic server errors), the fallback denylist, pause
parsing and capping, chunk rewriting (code, message, status, request id and
replay state preserved), config defaults and rejection, listener registration
(`global`, `enabled`), provider scoping, asynchronous downstream listeners,
thrown errors and early consumer exit.

`scripts/integration.mjs` boots `@deepseek-ai/dsh-llm` in a bare Cordis context,
mounts this plugin, and feeds a fake adapter's capacity refusal through the real
`llm/stream` waterfall: it proves the service dispatch actually reaches the
listener and that the rewritten finish chunk carries `RATE_LIMIT` plus the named
pause. Point `DSH_ROOT` elsewhere to check another installation.

## Verification

- `node --test test/*.test.js`: 26 unit tests pass.
- `node scripts/integration.mjs`: the real `@deepseek-ai/dsh-llm` service, mounted
  in a bare Cordis context with this plugin, reclassifies a fake adapter's
  capacity refusal through the real `llm/stream` waterfall (code, message and
  pause asserted).
- Not yet observed live: the PackyCode upstream has not produced its capacity
  sentence since the plugin was installed, so the end-to-end resend is still
  unverified; the retry executor was checked by reading
  `@deepseek-ai/dsh-llm-retry` (it retries exactly when `failure.code` is in the
  route's `retryableCodes`).

## Limits

- Wording-based: an upstream that reports capacity with different wording slips
  through. Extend `CAPACITY` or `OVERLOAD` in `index.js` when that happens.
- It depends on the internal `llm/stream` waterfall contract. A DSH release that
  changes that event needs this plugin rechecked; installation checks
  `engines.dsh`.
- Each retry is another billed request. Disabling the row restores the previous
  fail-fast behavior.
