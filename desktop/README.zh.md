# TinyWhale 桌面应用

[English](README.md) | 中文

包裹本地 harness Web UI 的 Electron 壳。本目录**不是** pnpm workspace 成员：harness 门禁把 `apps/*` 包当作可发布的发行成员。

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

## 运行

机器上需要 PATH 中有 `dsh`，或者在本检出上完成 `pnpm build`（在 host `lib/` 与 web 前端生成之前，源码 CLI 无法启动）。

若 `npm start` 因缺少 `Electron.app` 失败，是 npm 拦截了下载脚本。请在 `desktop/` 下执行一次 `node node_modules/electron/install.js`。

```sh
cd desktop
npm install
npm start
```

`npm start` 仅当该源已提供 TinyWhale 的 `/tinywhale/status` 通道时，才会接入 `http://127.0.0.1:3080/`。同一端口上已发布的 DeepSeek `dsh web` 会被忽略：壳会在下一个空闲端口启动本检出的 `apps/cli/src/bin.ts`。设置 `TINYWHALE_DSH_BIN` 可强制使用指定 CLI。

```sh
npm test              # unit tests, no Electron window
npm run smoke         # attach to an already-running Web UI and quit
npm run icon          # rebuild resources/icon.png and icon.icns from the SVG
npm run pack          # unsigned TinyWhale.app under release/mac-arm64/
```

打包产物是本地未签名构建。`npm run pack` 之后，`npm run install:dev` 会把它复制到 `~/Applications/TinyWhale.app`，并把本 monorepo 路径写入 `Contents/Resources/tinywhale-checkout.json`，因此 Dock 应用会启动本检出，而不是 PATH 上已发布的 `dsh`。点击 Dock 图标即可启动；该应用未经公证。

## 环境变量

| 变量 | 作用 |
|---|---|
| `TINYWHALE_PORT` | Web UI 端口（默认 `3080`） |
| `TINYWHALE_DSH_BIN` | 显式指定的 `dsh` 可执行文件 |
| `TINYWHALE_NODE_EXECUTABLE` | 仅在从 `apps/cli/src/bin.ts` 启动时使用的显式 Node 二进制 |
| `TINYWHALE_ATTACH_ONLY=1` | 不要 spawn `dsh`；若没有进程在监听则失败 |

用 Electron 的 `process.execPath` 去 spawn Node 脚本会再拉起一个 GUI 进程。壳会查找真正的 `node`（或运行 `dsh` 二进制，其 shebang 使用系统 Node）。

## 打包状态

`electron-builder` 可以从本目录产出 `.app` / DMG。已签名、自包含的 Mac 应用仍需要把 harness 运行时复制进 `extraResources`，并捆绑一份 Node。本目录只是壳；它尚未把整个 monorepo 打进去。
