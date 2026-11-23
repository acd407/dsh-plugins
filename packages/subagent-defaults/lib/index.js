/**
 * Route delegated subagents onto the model list from the Subagent settings page.
 *
 * The delegation tool also accepts a static `agentOptions` route, but that is
 * frozen into the preset and drifts as soon as the settings change. This plugin
 * reads the live settings service instead and records a model selection on a
 * child session right after it is created — before its first request, so the
 * first request already uses the chosen route.
 *
 * Scope of the override:
 *   - only sessions whose header origin is `subagent`;
 *   - never seeded (fork) children, whose whole point is prefix reuse;
 *   - only when the child inherited its parent's route, so an explicit
 *     provider/model in the delegation call is left alone;
 *   - only when the settings page is enabled and lists at least one model;
 *     the first listed route wins when several are allowed.
 *
 * @module dsh-subagent-defaults
 */
const name = "subagent-defaults";
const inject = ["agents"];
/**
 * Read the live authorized routes from the Subagent settings service.
 *
 * DSH 0.2.3 renamed the read to `allowedRoutes()` and lets it answer
 * `undefined` while selection is off. Up to 0.2.2 the same state came from
 * `current()` as `{ enabled, allowedModels }`. Both forms throw when the
 * setting is enabled without a valid route; a broken setting must not abort
 * child creation, so that throw is logged and treated as "no default".
 *
 * @param ctx - host context carrying the settings service.
 * @returns the allowed routes, or undefined while selection is off or unusable.
 */
function allowedRoutes(ctx) {
	const selection = ctx.get("subagentModelSelection");
	if (selection === void 0) return void 0;
	try {
		if (typeof selection.allowedRoutes === "function") return selection.allowedRoutes();
		if (typeof selection.current === "function") {
			const current = selection.current();
			return current.enabled ? current.allowedModels : void 0;
		}
		return void 0;
	} catch (error) {
		ctx.logger?.warn?.(
			"subagent-defaults: ignoring the Subagent model selection setting: %s",
			error instanceof Error ? error.message : String(error),
		);
		return void 0;
	}
}
/**
 * Record the authorized route on new subagent sessions.
 *
 * The listener is global: DSH dispatches this event through the owning agent's
 * scope, so a plugin-registered listener on the root context would otherwise be
 * filtered out.
 *
 * @param ctx - host context registering the listener.
 */
function apply(ctx) {
	ctx.on(
		"agent/created",
		({ agent }) => {
			const header = agent.session.header;
			if (header.origin !== "subagent") return;
			if (header.isSeeded === true) return;
			const allowed = allowedRoutes(ctx);
			if (allowed === void 0 || allowed.length === 0) return;
			const current = agent.model.current();
			if (current === void 0) return;
			const parentId = header.parentSession;
			const parent = parentId === void 0 ? void 0 : ctx.agents.get(parentId);
			const parentCurrent = parent?.model.current();
			const inherited = parentCurrent === void 0 || parentCurrent.provider === current.provider && parentCurrent.model === current.model;
			if (!inherited) return;
			if (allowed.some((route) => route.provider === current.provider && route.model === current.model)) return;
			const route = allowed[0];
			agent.model.select({
				provider: route.provider,
				model: route.model
			});
		},
		{ global: true },
	);
}
export { apply, inject, name };
