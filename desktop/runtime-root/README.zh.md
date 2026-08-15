# tinywhale-desktop-runtime

[English](README.md) | 中文

TinyWhale 桌面应用的纯依赖部署根目录。`pnpm --filter tinywhale-desktop-runtime deploy` 会把这份 manifest 物化成一份 hoisted 的 `node_modules` 树。`desktop/` 里的 Electron 壳不是 workspace 成员；加入 workspace 的只有本包。

往打包应用里加 workspace 插件，就是把它加进 `dsh` web 闭包（让 `apps/cli` 或某个组合包已经依赖它），再跑一次 `desktop/scripts/build-runtime.ts`。
