# TinyWhale desktop

Electron shell around the local harness Web UI. This directory is **not** a pnpm workspace member: `apps/*` packages are treated as publishable release members by the harness gates.

```
desktop/
  src/main.mjs           Electron main process
  src/menu.mjs           TinyWhale application menu
  src/harness.mjs        Attach to or spawn `dsh web`
  src/gui-path.mjs       Finder-safe PATH for Node / dsh
  src/resolve-node.mjs   Find a real Node binary (never Electron's execPath)
  src/loading.html       Startup screen
  resources/icon-master.jpg  App icon artwork
  resources/icon.png         1024px icon
  resources/icon.icns        macOS icon
  tests/                 node:test unit tests
  scripts/install-dev-app.sh
  scripts/write-checkout-root.mjs
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
npm run pack          # unsigned TinyWhale.app under release/mac-arm64/
```

The packaged app is a local unsigned build. After `npm run pack`, `npm run install:dev` copies it to `~/Applications/TinyWhale.app` and stamps this monorepo path into `Contents/Resources/tinywhale-checkout.json`, so the Dock app starts this checkout instead of a published `dsh` on PATH. Click the Dock tile to launch; it is not notarized.

## Environment

| Variable | Effect |
|---|---|
| `TINYWHALE_PORT` | Web UI port (default `3080`) |
| `TINYWHALE_DSH_BIN` | Explicit `dsh` executable |
| `TINYWHALE_NODE_EXECUTABLE` | Explicit Node binary used only when launching from `apps/cli/src/bin.ts` |
| `TINYWHALE_ATTACH_ONLY=1` | Do not spawn `dsh`; fail if nothing is listening |

Spawning a Node script with Electron's `process.execPath` starts another GUI process. The shell looks up a real `node` (or runs the `dsh` binary, whose shebang uses the system Node).

## Packaging status

`electron-builder` can produce a `.app` / DMG from this folder. A signed, self-contained Mac app still needs the harness runtime copied into `extraResources` and a bundled Node. This directory is the shell; it does not yet vendor the whole monorepo.
