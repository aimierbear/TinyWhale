# Vendored extras

These directories are the in-box copies of plugins that are not a published
npm package, or that TinyWhale must keep a local patch for.

| Directory | Why it lives here |
|---|---|
| `dsh-fractal/` | Unpublished first-party adapter plus the shipped fractal-agent 1.3.1 core under `dsh-fractal/core/`. |
| `dsh-security-codex/` | Unpublished first-party `security_scan` tool. |
| `dsh-better-sidebar/` | Upstream `github:omdsh-dev/DSH-better-sidebar#277e7d3` plus the layout patch in `LOCAL-PATCH.md`. |

`dsh-fractal/core/` is fractal-agent 1.3.1 (source maps omitted). The adapter
resolves `core/bin/fractal-action` and `core/bin/fractal-capability` so a
packaged TinyWhale does not need `~/.local/bin`. Runtime still needs `python3`
and `node` on PATH.

Refresh a copy from the working plugin checkout, then rebuild its `lib/`
before committing. Do not restore `prepare` / `prepublishOnly` scripts: the
workspace install must use the committed artifacts.
