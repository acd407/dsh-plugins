/**
 * The dependency-free half of `@local/gpt-apply-patch`.
 *
 * `index.js` imports the host's `@deepseek-ai/dsh-tool-fs` plugin and hands it to
 * {@link registerGptApplyPatch}. Keeping the capture logic here — with the plugin
 * passed in — lets the unit tests run without a DSH installation, while the real
 * registration still reuses the host's own `apply_patch` definition.
 *
 * Execution therefore runs the host's real `executePatch` path: whole-patch
 * preflight, structured `FS_PATCH_MISMATCH`, atomic `ctx.fs.patchText` with
 * version guards, sandbox escalation fields, and diff presentation metadata.
 *
 * @module gpt-apply-patch/gate
 */

/** Only the patch tool: every other `tool-fs` switch stays off. */
export const BUILTIN_CONFIG = Object.freeze({
  read: false,
  readImage: false,
  write: false,
  edit: false,
  applyPatch: true,
  readLimit: 2000,
  readMaxLineLength: 2000,
  readMaxBytes: 51200,
  readStreamMinSize: 10485760,
})

/** The host's own `apply_patch` system guidance. */
export const GUIDANCE = [
  'Prefer apply_patch over separate edit calls for changes across files or separated regions.',
  'Give every hunk enough surrounding context lines to match one place in the current file.',
  'The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing;',
  'once applying starts, operations run in order, stop at the first failure, and are not rolled back,',
  'so re-read affected files before retrying when needed.',
].join(' ')

/**
 * Whether a model id belongs to the codex-trained GPT family.
 * @param {string|undefined} modelId
 * @returns {boolean}
 */
export function isGptModel(modelId) {
  return typeof modelId === 'string' && modelId.startsWith('gpt-')
}

/**
 * Run the built-in filesystem plugin against a capture-only proxy and return
 * the `apply_patch` definition it would have registered.
 * @param {object} ctx real Cordis context.
 * @param {Function} applyFilesystemTools the host `dsh-tool-fs` plugin's `apply`.
 * @returns {object|undefined}
 */
export function captureBuiltinApplyPatch(ctx, applyFilesystemTools) {
  const captured = { definition: undefined }

  const tools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition) => {
          if (captured.definition === undefined) captured.definition = definition
          return () => {}
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const systemPrompt = new Proxy(ctx.systemPrompt, {
    get(target, property) {
      // The built-in section would be visible for every model; its text goes
      // into the tool description below instead.
      if (property === 'section') return () => () => {}
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const shadow = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return tools
      if (property === 'systemPrompt') return systemPrompt
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  applyFilesystemTools(shadow, BUILTIN_CONFIG)
  return captured.definition
}

/**
 * Register the built-in patch definition behind a `gpt-*` model gate.
 * @param {object} ctx Cordis plugin context.
 * @param {Function} applyFilesystemTools the host `dsh-tool-fs` plugin's `apply`.
 * @throws when the host plugin did not register an `apply_patch` definition.
 */
export function registerGptApplyPatch(ctx, applyFilesystemTools) {
  if (typeof applyFilesystemTools !== 'function') {
    throw new Error('gpt-apply-patch: @deepseek-ai/dsh-tool-fs did not provide an apply function')
  }

  const builtin = captureBuiltinApplyPatch(ctx, applyFilesystemTools)
  if (builtin === undefined || builtin.name !== 'apply_patch') {
    throw new Error('gpt-apply-patch: the host dsh-tool-fs did not register an apply_patch definition')
  }

  const definition = {
    ...builtin,
    description: `${builtin.description} ${GUIDANCE}`,
  }

  ctx.effect(
    () =>
      ctx.tools.register(definition, {
        when: (activation) => isGptModel(activation?.modelSelection?.model),
      }),
    'gpt-apply-patch: apply_patch',
  )
}
