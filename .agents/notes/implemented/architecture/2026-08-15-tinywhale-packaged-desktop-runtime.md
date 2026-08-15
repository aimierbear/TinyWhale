# Agent Note: TinyWhale packaged desktop runtime

Status: implemented

English | [中文](2026-08-15-tinywhale-packaged-desktop-runtime.zh.md)

## Problem

The Electron shell in `desktop/` could pack an unsigned `.app`, but that app only started a git checkout or a `dsh` already on PATH. A machine with no Node, pnpm, git, or Xcode CLT could not open TinyWhale, and the plugin market could not install anything because `dsh plugin` forwards to pnpm.

## Decision

Ship a self-contained macOS Apple Silicon runtime next to the Electron shell:

- `desktop/runtime-root` is a private workspace member and the `pnpm deploy` root for the web closure (`@deepseek-ai/dsh` plus every workspace peer it reaches). The Electron package itself stays outside the workspace.
- `desktop/scripts/build-runtime.ts` deploys that closure into `desktop/.runtime-stage` with `--ignore-scripts` and `blockExoticSubdeps=false` (for the pinned `dsh-genui` git commit), replaces remaining symlinks with files, vendors Node 24, pnpm 11.7.0, dugite Git, and a standalone CPython, then writes `runtime/bin/dsh` and `runtime/bin/pnpm`. The packaged `dsh` entry is `runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`.
- A release app vendors `runtime/bin/dsh` plus `runtime/packaged.json` (version metadata). The shell treats a complete bundled runtime as the packaged signal, prepends those bins, sets `TINYWHALE_PACKAGED=1`, and starts `runtime/bin/dsh web`. A developer `pack` still stamps `tinywhale-checkout.json` and starts `apps/cli/src/bin.ts`.
- `$DSH_HOME` remains `~/.dsh`. `healProfilesModuleFallback` keeps pointing `$DSH_HOME/profiles/node_modules` at the running install.
- `dsh-fractal` publishes `core/` and honors `FRACTAL_PYTHON`; packaged wrappers set that to the bundled CPython so launchers never fall through to the macOS CLT stub.
- `dsh plugin` prefers `TINYWHALE_PNPM` or `runtime/bin/pnpm` over PATH.
- Settings → Update on a packaged Host opens GitHub Releases instead of merging git.

## Alternatives considered

**SEA exe as the desktop backend.** Rejected: the Python single-exe is a closed VFS and cannot share a Cordis instance with plugins installed after the fact.

**Adding every missing peer to `apps/cli`.** Rejected: the CLI publish surface would list a hundred implementation peers it does not import. A dedicated deploy-root matches `python/sdk-runtime`.

**Changing `$DSH_HOME` for packaged apps.** Rejected: the market and sidebar install commands assume `~/.dsh`.

## Consequences

- `npm run dist` from `desktop/` is the release path; `npm run pack` remains the checkout Dock app.
- A packaged app and a source `dsh web` must not share one `$DSH_HOME` at the same time.
- Signing and notarization are still required before Gatekeeper will trust a public DMG.
