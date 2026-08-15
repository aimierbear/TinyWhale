# Agent Note: TinyWhale packaged desktop runtime

Status: implemented

[English](2026-08-15-tinywhale-packaged-desktop-runtime.md) | 中文

## Problem

`desktop/` 里的 Electron 壳可以打出未签名的 `.app`，但那个应用只会启动一份 git 检出，或 PATH 上已有的 `dsh`。没有 Node、pnpm、git 或 Xcode CLT 的机器打不开 TinyWhale，插件市场也装不了东西，因为 `dsh plugin` 会转发给 pnpm。

## Decision

在 Electron 壳旁边发一份自包含的 macOS Apple Silicon 运行时：

- `desktop/runtime-root` 是私有 workspace 成员，也是 web 闭包（`@deepseek-ai/dsh` 加上它够得着的每个 workspace peer）的 `pnpm deploy` 根。Electron 包本身仍留在 workspace 外。
- `desktop/scripts/build-runtime.ts` 把该闭包部署到 `desktop/.runtime-stage`，使用 `--ignore-scripts` 和 `blockExoticSubdeps=false`（给钉死的 `dsh-genui` git commit），把残留 symlink 换成文件，再捆上 Node 24、pnpm 11.7.0、dugite Git 和一份独立 CPython，然后写出 `runtime/bin/dsh` 与 `runtime/bin/pnpm`。打包后的 `dsh` 入口是 `runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- 发行应用带上 `runtime/bin/dsh` 和 `runtime/packaged.json`（版本元数据）。壳把完整的捆绑运行时当作打包信号，把这些 bin 放到 PATH 前面，设置 `TINYWHALE_PACKAGED=1`，并启动 `runtime/bin/dsh web`。开发用的 `pack` 仍盖 `tinywhale-checkout.json`，并启动 `apps/cli/src/bin.ts`。
- `$DSH_HOME` 仍是 `~/.dsh`。`healProfilesModuleFallback` 继续把 `$DSH_HOME/profiles/node_modules` 指到当前这次运行的安装。
- `dsh-fractal` 发布 `core/`，并遵守 `FRACTAL_PYTHON`；打包包装脚本把它设成捆绑的 CPython，启动器不会再掉进 macOS CLT stub。
- `dsh plugin` 优先用 `TINYWHALE_PNPM` 或 `runtime/bin/pnpm`，而不是 PATH。
- 打包 Host 上的设置 → 更新会打开 GitHub Releases，而不是做 git merge。

## Alternatives considered

**用 SEA exe 当桌面后端。** 不采用：Python 单文件 exe 是封闭 VFS，无法和事后安装的插件共享同一个 Cordis 实例。

**把缺的 peer 全写进 `apps/cli`。** 不采用：CLI 的发布面会列出上百个它并不 import 的实现 peer。单独的部署根和 `python/sdk-runtime` 一致。

**给打包应用换 `$DSH_HOME`。** 不采用：市场和侧栏安装命令假定是 `~/.dsh`。

## Consequences

- `desktop/` 下的 `npm run dist` 是发行路径；`npm run pack` 仍是检出 Dock 应用。
- 打包应用和源码 `dsh web` 不能同时对着同一个 `$DSH_HOME`。
- 对外发的 DMG 在 Gatekeeper 信任它之前，仍需签名和公证。
