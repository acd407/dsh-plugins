/**
 * @local/gpt-apply-patch — the built-in `apply_patch` tool, offered only to
 * codex-trained `gpt-*` models.
 *
 * DSH already ships a complete, Codex-parity `apply_patch` inside
 * `@deepseek-ai/dsh-tool-fs` (item `applyPatch`). That registration is
 * unconditional, so this plugin reuses the built-in definition instead of
 * reimplementing the parser/applier:
 *
 *  1. Load `dsh-tool-fs` with every tool disabled except `applyPatch`.
 *  2. Point it at a thin `ctx` proxy whose `tools.register` captures the
 *     definition and whose `systemPrompt.section` is a no-op (the guidance is
 *     folded into the tool description, so it is only visible together with
 *     the tool itself).
 *  3. Register the captured definition under `apply_patch` with a per-step
 *     `when` condition that admits only model ids starting with `gpt-`.
 *
 * `@deepseek-ai/dsh-tool-fs` is supplied by the DSH installation scope; the
 * profile loader routes that bare import to the running host copy. The capture
 * logic lives in `./lib/gate.js`, which is dependency-free and unit-tested.
 */
import { apply as applyFilesystemTools } from '@deepseek-ai/dsh-tool-fs'

import { registerGptApplyPatch } from './lib/gate.js'

/** Cordis plugin id used by loader diagnostics. */
export const name = '@local/gpt-apply-patch'

/** Services the captured built-in definition executes against. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

export { isGptModel } from './lib/gate.js'

/**
 * Register the built-in patch definition behind a `gpt-*` model gate.
 * @param {object} ctx Cordis plugin context.
 */
export function apply(ctx) {
  registerGptApplyPatch(ctx, applyFilesystemTools)
}
