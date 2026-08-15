# TinyWhale desktop

English | [中文](README.zh.md)

Electron shell around the local harness Web UI. This directory is **not** a pnpm workspace member: `apps/*` packages are treated as publishable release members by the harness gates.

```
desktop/
  src/main.mjs           Electron main process
  src/menu.mjs           TinyWhale application menu
  src/harness.mjs        Attach to or spawn `dsh web`
  src/gui-path.mjs       Finder-safe PATH for Node / dsh
  src/packaged.mjs       Release-install stamp and bundled runtime env
  src/resolve-node.mjs   Find a real Node binary (never Electron's execPath)
  src/loading.html       Startup screen
  resources/icon-master.jpg  App icon artwork
  resources/icon.png         1024px icon
  resources/icon.icns        macOS icon
  tests/                 node:test unit tests
  scripts/install-dev-app.sh
  scripts/write-checkout-root.mjs
  scripts/build-runtime.ts
  runtime-root/          Deploy-root manifest (workspace member)
  electron-builder.yml   macOS packager config
```

## Run

The machine needs either `dsh` on `PATH` or this checkout after `pnpm build` (the source CLI will not boot until host `lib/` and the web frontend exist).

If `npm start` fails because `Electron.app` is missing, npm blocked the download script. From `desktop/` run `node node_modules/electron/install.js` once.

```sh
cd desktop
npm install
npm start
```

`npm start` attaches to `http://127.0.0.1:3080/` only when that origin already serves TinyWhale's `/tinywhale/status` channel. A published DeepSeek `dsh web` on the same port is ignored: the shell starts this checkout's `apps/cli/src/bin.ts` on the next free port. Set `TINYWHALE_DSH_BIN` to force a specific CLI.

```sh
npm test              # unit tests, no Electron window
npm run smoke         # attach to an already-running Web UI and quit
npm run icon          # rebuild resources/icon.png and icon.icns from the SVG
npm run pack          # unsigned TinyWhale.app under release/mac-arm64/ (dev checkout)
npm run build:runtime # assemble the bundled Node / dsh / pnpm / git / python tree
npm run dist          # self-contained unsigned DMG (does not stamp this checkout)
```

`npm run pack` then `npm run install:dev` is the **developer** Dock app: it stamps this monorepo path into `Contents/Resources/tinywhale-checkout.json` and starts `apps/cli/src/bin.ts`. Click the Dock tile to launch; it is not notarized.

`npm run dist` is the **release** install: `build-runtime` vendors Node, pnpm, Git, CPython, and a hoisted `dsh` tree into `runtime/`, then electron-builder writes a DMG and stamps `tinywhale-packaged.json`. That app does not need a checkout, system Node, or Homebrew.

## Environment

| Variable | Effect |
|---|---|
| `TINYWHALE_PORT` | Web UI port (default `3080`) |
| `TINYWHALE_DSH_BIN` | Explicit `dsh` executable |
| `TINYWHALE_NODE_EXECUTABLE` | Explicit Node binary used only when launching from `apps/cli/src/bin.ts` |
| `TINYWHALE_ATTACH_ONLY=1` | Do not spawn `dsh`; fail if nothing is listening |
| `TINYWHALE_PACKAGED=1` | Set by a release app; Settings Update opens Releases instead of merging git |
| `TINYWHALE_PNPM` | Explicit pnpm used by `dsh plugin` |

Spawning a Node script with Electron's `process.execPath` starts another GUI process. The packaged wrapper always execs the bundled Node; the developer Dock app looks up a real `node` on PATH.

## Packaging status

A release DMG is a self-contained unsigned build. Signing and notarization are still required before shipping to machines that enforce Gatekeeper. Do not run a packaged app and `pnpm dsh web` against the same `$DSH_HOME` at the same time: each launch rewrites `$DSH_HOME/profiles/node_modules` to point at its own install.
