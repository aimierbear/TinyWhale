# TinyWhale desktop

Electron shell around the local harness Web UI. This directory is **not** a pnpm workspace member: `apps/*` packages are treated as publishable release members by the harness gates.

```
desktop/
  src/main.mjs           Electron main process
  src/harness.mjs        Attach to or spawn `dsh web`
  src/resolve-node.mjs   Find a real Node binary (never Electron's execPath)
  tests/                 node:test unit tests
  electron-builder.yml   macOS / Windows / Linux packager config
```

## Run

The machine needs either `dsh` on `PATH` or a built/source checkout of this repository.

If `npm start` fails because `Electron.app` is missing, npm blocked the download script. From `desktop/` run `node node_modules/electron/install.js` once.

```sh
cd desktop
npm install
npm start
```

`npm start` opens `http://127.0.0.1:3080/` when that address already returns HTTP 200. Otherwise it runs `dsh web --port 3080` and waits for the page.

```sh
npm test              # unit tests, no Electron window
npm run smoke         # attach to an already-running Web UI and quit
npm run pack          # unpacked electron-builder directory
npm run dist          # DMG / zip (macOS)
```

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
