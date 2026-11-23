# @local/gpt-apply-patch

DSH ships a complete, Codex-parity `apply_patch` inside
`@deepseek-ai/dsh-tool-fs`, but every shipped agent preset sets
`applyPatch: false`, and the registration has no per-model condition. This
plugin reuses that built-in implementation and offers it only to models whose
id starts with `gpt-`.

## How it works

`index.js` hands the host's `dsh-tool-fs` plugin to `lib/gate.js`, which at
plugin apply time:

1. calls it with `applyPatch: true` and every other tool switch off;
2. points it at a thin `ctx` proxy whose `tools.register` captures the
   `apply_patch` definition instead of mounting it, and whose
   `systemPrompt.section` is suppressed (the same guidance is appended to the
   tool description, so it only appears together with the tool);
3. registers the captured definition on the real context with
   `{ when: ({ modelSelection }) => modelSelection?.model?.startsWith('gpt-') }`.

No patch parser, applier, or filesystem path logic is copied. Execution goes
through the host's real `executePatch`: whole-patch preflight, structured
`FS_PATCH_MISMATCH`, atomic `ctx.fs.patchText` with version guards, sandbox
escalation fields, and diff presentation metadata. The model-facing argument
is the Codex `input` string, not a JSON `patch` field.

The bare import `@deepseek-ai/dsh-tool-fs` is supplied by the DSH installation
scope; the profile module loader routes it to the running host copy. The capture
logic in `lib/gate.js` has no imports, so the unit tests run without a DSH
installation by injecting a stand-in for the host plugin.

## Behavior

- `gpt-*` models (including `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6.1-sol`) see
  `apply_patch` on every step where they are the selected model.
- Every other model does not see the tool, and switching the model mid-session
  changes availability on the next step.
- The plugin has no settings and no package dependencies (it imports the host's
  `dsh-tool-fs`). It never registers `read`, `write`, `edit`, or `read_image`;
  the preset's own `tool-fs` row keeps serving those.

## Install

Install the package directory from a clone of
[`acd407/dsh-plugins`](https://github.com/acd407/dsh-plugins), or use a
commit-pinned Git spec (see the [repository README](../../README.md)):

```text
github:acd407/dsh-plugins#<40-char-commit>&path:/packages/gpt-apply-patch
```

The bundle patch inserts one Host row (`id: gpt-apply-patch`). A fresh install
needs no restart; a package replacement needs a profile recomposition (enable
the row again) or a restart.

## Uninstall

```text
plugin_manager { action: "remove_bundle", target: "@local/gpt-apply-patch" }
```

## Verify

```bash
node --test test/
```

The seven tests exercise model detection, the capture proxy (including the
suppressed system-prompt section), the registered definition and its `when`
gate, a host plugin that registers nothing, a missing host plugin, and disposal.

Live check: select a `gpt-*` model and confirm the tool list contains
`apply_patch`; switch to a non-GPT model and confirm it disappears on the next
step.
