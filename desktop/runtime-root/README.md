# tinywhale-desktop-runtime

English | [中文](README.zh.md)

Dependency-only deploy root for the TinyWhale desktop app. `pnpm --filter tinywhale-desktop-runtime deploy` materializes this manifest into a hoisted `node_modules` tree. The Electron shell in `desktop/` is not a workspace member; only this package is.

Adding a workspace plugin to the packaged app means adding it to the `dsh` web closure (so `apps/cli` or a bundle already depends on it) and re-running `desktop/scripts/build-runtime.ts`.
