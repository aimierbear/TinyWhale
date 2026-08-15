# TinyWhale 桌面应用

[English](README.md) | 中文

包裹本地 harness Web UI 的 Electron 壳。本目录**不是** pnpm workspace 成员：harness 门禁把 `apps/*` 包当作可发布的发行成员。

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
npm run pack          # unsigned TinyWhale.app under release/mac-arm64/ (dev checkout)
npm run build:runtime # assemble the bundled Node / dsh / pnpm / git / python tree
npm run dist          # self-contained unsigned DMG (does not stamp this checkout)
```

`npm run pack` 再 `npm run install:dev` 是**开发用** Dock 应用：它把本 monorepo 路径写入 `Contents/Resources/tinywhale-checkout.json`，并启动 `apps/cli/src/bin.ts`。点击 Dock 图标即可启动；该应用未经公证。

`npm run dist` 是**发行**安装包：`build-runtime` 把 Node、pnpm、Git、CPython 和一份 hoisted 的 `dsh` 树放进 `runtime/`，然后 electron-builder 写出 DMG 并盖上 `tinywhale-packaged.json`。这个应用不需要检出、系统 Node 或 Homebrew。

## 环境变量

| 变量 | 作用 |
|---|---|
| `TINYWHALE_PORT` | Web UI 端口（默认 `3080`） |
| `TINYWHALE_DSH_BIN` | 显式指定的 `dsh` 可执行文件 |
| `TINYWHALE_NODE_EXECUTABLE` | 仅在从 `apps/cli/src/bin.ts` 启动时使用的显式 Node 二进制 |
| `TINYWHALE_ATTACH_ONLY=1` | 不要 spawn `dsh`；若没有进程在监听则失败 |
| `TINYWHALE_PACKAGED=1` | 发行应用会设置；设置里的更新会打开 Releases，而不是做 git merge |
| `TINYWHALE_PNPM` | `dsh plugin` 使用的显式 pnpm |

用 Electron 的 `process.execPath` 去 spawn Node 脚本会再拉起一个 GUI 进程。打包包装脚本总是 exec 捆绑的 Node；开发用 Dock 应用会在 PATH 上查找真正的 `node`。

## 打包状态

发行 DMG 是自包含的未签名构建。对外分发前仍需签名和公证，否则会撞上 Gatekeeper。不要让打包应用和 `pnpm dsh web` 同时对着同一个 `$DSH_HOME`：每次启动都会把 `$DSH_HOME/profiles/node_modules` 重指到自己的安装。
