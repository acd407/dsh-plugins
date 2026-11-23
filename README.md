# dsh-plugins

Personal plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), as one pnpm workspace. Every package is a DSH **bundle**: a package whose
`package.json` declares `dsh.bundle.patch`, whose `cordis.patch.yml` inserts the
Host row.

| Package | Version | What it does |
|---|---|---|
| [`subagent-defaults`](packages/subagent-defaults) | 0.2.2 | Routes delegated subagents onto the models the **Subagent** settings page authorizes, instead of inheriting the parent's route. |
| [`gpt-apply-patch`](packages/gpt-apply-patch) | 1.0.1 | Reuses DSH's built-in Codex-style `apply_patch` tool, offered only to `gpt-*` models. |
| [`llm-capacity-retry`](packages/llm-capacity-retry) | 1.0.1 | Rewrites a transient upstream capacity refusal (`PI_AI_ERROR` + "capacity limit … try again in 2s") to `RATE_LIMIT`, so the route's own retry policy resends the step. |

Every package declares `engines.dsh: "^0.2.2-0"`: it loads on the 0.2.2 line
(stable or prerelease, including the current `latest` 0.2.2-rc.5) and on later
0.2.x prereleases such as 0.2.3-alpha.2, but not on 0.2.1 or 0.3. The 0.2.2 and
0.2.3 settings-service APIs differ, so `subagent-defaults` reads both.

## Install

DSH installs bundles from a registry package, a local directory, a Git address or
a tarball; no npm release is needed. From the GUI (**Plugins → Add plugin**) or
`plugin_manager` `install_bundle`, pass one of the specs below.

### By tag (readable)

Tags are named `<package>-v<version>` and mark the version each package's
`package.json` declares:

```text
github:acd407/dsh-plugins#subagent-defaults-v0.2.2&path:/packages/subagent-defaults
github:acd407/dsh-plugins#gpt-apply-patch-v1.0.1&path:/packages/gpt-apply-patch
github:acd407/dsh-plugins#llm-capacity-retry-v1.0.1&path:/packages/llm-capacity-retry
```

A tag spec installs and pins reproducible code through the profile's lockfile,
but DSH offers no **Update** action for it: `listBundles` only marks a Git bundle
updatable when its saved spec names a full 40-character commit. Upgrading a
tag-installed package means installing the next tag's spec over it.

### By commit (updatable)

Pass a full commit instead of the tag; that spec is what DSH's Update button can
replace later:

```text
github:acd407/dsh-plugins#<40-char-commit>&path:/packages/subagent-defaults
github:acd407/dsh-plugins#<40-char-commit>&path:/packages/gpt-apply-patch
github:acd407/dsh-plugins#<40-char-commit>&path:/packages/llm-capacity-retry
```

Read the current commit with:

```sh
git ls-remote https://github.com/acd407/dsh-plugins HEAD
```

Pin the **full 40-character** commit, not a branch: only a full-commit spec is
updatable (`updateBundle` refuses a branch or tag spec because a failed update
could not bring the old version back). Updating means replacing the spec with a
newer commit — there is no version list for Git bundles.

### From a local clone

Install a package directory instead. That records a `link:` dependency, which is
what this repository is developed against:

```sh
git clone git@github.com:acd407/dsh-plugins.git
# then install_bundle with the absolute path of
#   ~/repository/dsh/dsh-plugins/packages/<name>
```

A changed link install applies at the next profile recomposition (enable the row
again in Plugins) or after a `dsh web` restart.

## Tags

| Tag | Package | Version |
|---|---|---|
| `subagent-defaults-v0.2.2` | `packages/subagent-defaults` | 0.2.2 |
| `gpt-apply-patch-v1.0.1` | `packages/gpt-apply-patch` | 1.0.1 |
| `llm-capacity-retry-v1.0.1` | `packages/llm-capacity-retry` | 1.0.1 |

Tags mark released states; there are no Release assets. Bump a package's
`package.json` version and tag the same commit as `<package>-v<version>`.

## Layout

```text
packages/
  subagent-defaults/    lib/index.js, cordis.patch.yml, test/
  gpt-apply-patch/      index.js, cordis.patch.yml, locale/, test/
  llm-capacity-retry/   index.js, cordis.patch.yml, locale/, icon.svg, test/
.github/workflows/      unit tests on push
```

Each package is self-contained (no runtime dependencies, no build step) and keeps
DSH's display metadata: localized `meta.title` / `meta.description`, an icon where
one exists, and a README that the Plugin Manager detail page falls back to.

## Tests

```sh
node --test packages/*/test/*.test.js
```

`packages/llm-capacity-retry/scripts/integration.mjs` additionally boots the
installed DSH's `@deepseek-ai/dsh-llm` service and pushes a capacity refusal
through the real `llm/stream` waterfall. It needs a local DSH installation and is
not run in CI:

```sh
node packages/llm-capacity-retry/scripts/integration.mjs
# or: DSH_ROOT=/path/to/dsh node packages/llm-capacity-retry/scripts/integration.mjs
```

## Notes and limits

- These packages are `private: true`: they are installed from Git or a directory,
  not from npm. The historical `@local/*` names are harmless for Git installs; a
  future npm release would need a scope the publisher owns.
- `llm-capacity-retry` matches wording and depends on DSH's internal `llm/stream`
  waterfall, so a DSH upgrade can require rechecking it. Its README lists the exact
  conditions it rewrites and how to disable it.
- `gpt-apply-patch` reuses the `apply_patch` definition shipped in
  `@deepseek-ai/dsh-tool-fs`; it does not reimplement the parser or applier.

## License

MIT — see [LICENSE](LICENSE).
