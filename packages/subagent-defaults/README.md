# dsh-subagent-defaults

A DeepSeek Harness bundle that routes delegated subagents onto the models the
**Subagent** settings page authorizes, instead of letting every child inherit the
parent session's route.

The delegation tool accepts a static `agentOptions` route, but that is frozen
into the preset and drifts as soon as the settings change. This plugin reads the
live setting instead (`subagentModelSelection.allowedRoutes()`) when each child is
created, so changing the checkboxes applies to the next delegation without
editing any preset.

## Behavior

On every `agent/created` event, the plugin records a `model/selection` on the
child when all of these hold:

- the session header's `origin` is `subagent`;
- the header does **not** mark a seeded (fork) child — forks exist to reuse the
  parent's prefix, so their route is left alone;
- the child inherited its parent's route (an explicit provider/model in the
  delegation call wins over the setting);
- the settings page is enabled and lists at least one model;
- the inherited route is not in the allowed list.

The first allowed route wins when several are enabled. A setting that is enabled
without a valid route throws inside the settings service; the plugin logs a
warning and applies no default rather than aborting child creation.

With the setting disabled or empty, nothing changes: children keep inheriting.

## Install

From GitHub, pinned to a commit (see the [repository README](../../README.md) for
the exact spec form):

```sh
# in the DeepSeek Harness GUI: Plugins → Add plugin, or
# plugin_manager install_bundle with
#   github:acd407/dsh-plugins#<40-char-commit>&path:/packages/subagent-defaults
```

Or from a local clone: point `plugin_manager` at this directory
(`packages/subagent-defaults`). Installing from a directory records a `link:`
dependency, so later edits need a profile recomposition (enable the row again) or
a restart.

## Requirements

- `engines.dsh`: `^0.2.3-alpha.2` (`allowedRoutes()` on the settings service).
- Services: `agents`; reads `subagentModelSelection` when present.

## Tests

```sh
node --test test/
```

The eight tests cover the inheritance checks, seeded and non-subagent sessions,
disabled and absent settings, a throwing setting, and an unknown parent route.
