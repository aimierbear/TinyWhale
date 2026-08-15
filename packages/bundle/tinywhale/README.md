# `@deepseek-ai/dsh-tinywhale`

English | [中文](README.zh.md)

TinyWhale extras as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts the default community and first-party plugin rows after [`dsh-web-app`](../web-app/README.md) on the shipped `web` template. The package has no runtime API; the profile composer resolves the patch through the `dsh.bundle.patch` manifest field, never through code.

The inserted packages resolve from this installation because they are dependencies of this bundle. Three of them are committed under [`plugins/`](plugins/ORIGIN.md) (`dsh-fractal`, `dsh-security-codex`, and the TinyWhale-patched `dsh-better-sidebar`); the rest come from npm or a pinned GitHub commit. A later profile or home `cordis.patch.yml` can still disable or override any inserted row by id.

This layer is only the `web` template's third bundle. `headless` does not mount it. An already-initialized `web` profile is user-owned and is not rewritten; add `@deepseek-ai/dsh-tinywhale` to that profile's `dsh.profile.bundles` (after `@deepseek-ai/dsh-web-app`) and remove the matching user-layer copies first, or those rows double-mount.

## Model Experience

Indirectly, through the inserted rows: this bundle selects TinyWhale's default extras and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **Existing `web` profiles stay as they are** — only a missing profile picks up this bundle from the shipped template. A stock `[dsh-base, dsh-web-app]` list is not rewritten.
- **`dsh-better-sidebar` is a patched snapshot** — upstream's `#root` margin collapses TinyWhale's left session list; the in-box copy keeps the center-column squeeze from `plugins/dsh-better-sidebar/LOCAL-PATCH.md`. Do not replace that directory with an upstream tarball.
- **GitHub-hosted `dsh-genui` is pinned by commit** — bumping extras means updating both the dependency spec and this limitation when the pin moves.
- **Vendored `file:` plugins resolve from this checkout** — `dsh-fractal`, `dsh-security-codex`, and `dsh-better-sidebar` are not registry packages. A published npm tarball of this bundle cannot install them.
- **`dsh-fractal` needs `python3` and `node` on PATH** — the shipped 1.3.1 core is invoked through those interpreters. The adapter prefers `core/bin/fractal-*`, then `FRACTAL_ACTION_BIN` / `FRACTAL_CAPABILITY_BIN`, then `~/.local/bin`.
