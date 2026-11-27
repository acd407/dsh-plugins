# @local/llm-capacity-retry

DSH's pi-ai adapter gives every failure it recognises a specific code — `AUTH`,
`QUOTA`, `RATE_LIMIT`, `INVALID_REQUEST`, `SERVER`, `TIMEOUT`, `TRANSPORT`,
`CONTEXT_WINDOW_EXCEEDED`. Whatever is left becomes `PI_AI_ERROR`, which means
"unknown", not "permanent" — and **no route lists `PI_AI_ERROR` among its
retryable codes**, so such a step dies on its first attempt.

Two cases that reach it in practice:

- PackyCode reports a saturated upstream **inside a stream it already answered
  200 for**: `rate_limit_exceeded` / `Temporary capacity limit. Please try again
  in 2s.`, or `gateway_concurrency_limit: Concurrency limit exceeded for
  account, please retry later`. The adapter looks for "rate limit" and 429, so
  "concurrency limit" is invisible to it.
- pi-ai's own terminal `pending` / `deferred` states are mapped to
  `PI_AI_ERROR` as well.

This bundle therefore treats `PI_AI_ERROR` as retryable, without touching the
installed plugin's built files.

## How it works

One listener on `llm/stream`, the documented waterfall around every streaming
model call:

1. read the request's `provider` (`providers` scoping) and pass anything
   unrelated to the next listener unchanged;
2. walk the chunks; for a terminal `finish` with `reason.kind === 'error'`, check
   whether the failure code is listed in `codes` (default `PI_AI_ERROR`) **and**
   the message is transient capacity wording;
3. if the code is one this plugin handles (default `PI_AI_ERROR`), rewrite it to
   `RATE_LIMIT` — a code every route's policy already retries — and, when the
   message names a pause ("try again in 2s"), set `providerRetryAfterMs` so the
   retry waits that long instead of the policy's base backoff. The guard below
   can still veto the rewrite.

Nothing else changes: the upstream sentence is preserved (it is what the user
sees if every retry fails), no key is disabled or rotated, and every other
failure — quota, auth, client policy, protocol errors — stays terminal.

`RATE_LIMIT` is already in the PackyCode route's retryable codes, and
`@deepseek-ai/dsh-llm-retry` re-runs the failed step in the same open turn, so
the retry needs no extra wiring: 20 attempts, 500 ms base backoff, 10 s cap on
that route.

## What is retried, and what is not

**Retried:** every `PI_AI_ERROR`, whatever the wording. No wording matching is
involved — by the time a failure reaches this code, the adapter has already
looked for 429s, quota words, 4xx/5xx statuses, timeouts and connection errors
and found none.

**Untouched:** `AUTH`, `QUOTA`, `INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`,
`SERVER`, `TIMEOUT`, `TRANSPORT`, `ABORTED` and every other code. Change `codes`
to add one.

**Still terminal — the `guard` (default on):** gateway refusals a resend cannot
clear, because they are a decision about this key, model or channel rather than a
transient fault:

| Wording | Why it must stay terminal |
|---|---|
| `only accessible via the official Claude CLI`, `请使用标准 Codex 客户端`, `客户端存在异常`, `二次分发`, `API 转接` | the channel serves only the vendor's own client |
| `当前令牌未覆盖供应商`, `model_not_found`, `无可用渠道` | the key's groups do not include the model's supplier |
| `无效的令牌`, `invalid api key`, `unauthorized` | the credential itself was rejected |

PackyCode reports exactly these as `PI_AI_ERROR` on purpose, so that nothing
retries them; without the guard each would burn the full budget (about three
minutes on a 20-attempt policy) and end in the same sentence. `guard: false`
retries them anyway.

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

The unit suite covers unconditional reclassification of the configured code, the
guard for permanent gateway refusals, pause parsing and capping, chunk rewriting
(code, message, status, request id and replay state preserved), config defaults
and rejection, listener registration (`global`, `enabled`), provider scoping,
asynchronous downstream listeners, thrown errors and early consumer exit.

`scripts/integration.mjs` boots `@deepseek-ai/dsh-llm` in a bare Cordis context,
mounts this plugin, and feeds a fake adapter's capacity refusal through the real
`llm/stream` waterfall: it proves the service dispatch actually reaches the
listener and that the rewritten finish chunk carries `RATE_LIMIT` plus the named
pause. Point `DSH_ROOT` elsewhere to check another installation.

## Verification

- `node --test test/*.test.js`: 22 unit tests pass.
- `node scripts/integration.mjs`: the real `@deepseek-ai/dsh-llm` service, mounted
  in a bare Cordis context with this plugin, reclassifies a fake adapter's
  `PI_AI_ERROR` through the real `llm/stream` waterfall (code, message and pause
  asserted).
- Live on the machine where `gateway_concurrency_limit` was first seen: the
  failure arrived as `PI_AI_ERROR` with **zero** `llm/retry` events, which is what
  motivated handling the code itself rather than its wording.
- The retry executor was checked by reading `@deepseek-ai/dsh-llm-retry`: it
  retries exactly when `failure.code` is in the route's `retryableCodes`, and
  honours `providerRetryAfterMs` at or below the policy's `maxDelayMs`.

## Limits

- No wording matching: the plugin trusts that everything recognisable already has
  its own code. A permanent failure the adapter leaves unclassified is therefore
  retried until the budget runs out — the guard covers the gateway refusals known
  today, and `guard: false` removes even that.
- The budget is the route's, not the plugin's. On a route that still defaults to
  five attempts, a `PI_AI_ERROR` gets five; set `retryPolicy.maxRetries` in that
  provider's config for more.
- It depends on the internal `llm/stream` waterfall contract. A DSH release that
  changes that event needs this plugin rechecked; installation checks
  `engines.dsh`.
- Diagnostics show the rewritten `RATE_LIMIT` rather than `PI_AI_ERROR`; the
  message is unchanged.
- Each retry is another billed request. Disabling the row restores the previous
  fail-fast behavior.
