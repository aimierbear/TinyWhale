# @deepseek-ai/dsh-client-ui-settings-update

[English](README.md) | 中文

TinyWhale 自有的通用设置行：从 DeepSeek Harness 上游远程更新当前安装。Host 半边定位包含 `TINYWHALE.md` 的检出，注册仅 loopback 可用的 `/tinywhale` Connection 通道；应用更新时 fetch `upstream`（若该远程不存在则添加 `https://github.com/deepseek-ai/deepseek-harness.git`），再合并 `upstream/master`。工作区有未提交更改或处于 detached HEAD 时拒绝执行；合并冲突会运行 `git merge --abort`。若合并改动了 `pnpm-lock.yaml`，Host 会执行 `pnpm --dir <root> install`。浏览器半边只在 loopback 页面注册该行。当 Host 不是 TinyWhale git 检出或 status 调用失败时，这一行仍显示，按钮禁用并说明原因。Electron 优先使用本检出的 CLI，而不是 PATH 上已发布的 `dsh`；只有 `/tinywhale/status` 有应答时才会挂到已经在跑的 Web UI。

`remoteName`、`remoteUrl` 与 `branch` 是插件 `Config` 字段。Electron 壳不会自行重启；正在运行的 `dsh web` 进程会继续使用已经加载的代码，直到用户退出。

## 模型体验

无，因为本插件是针对 Host git 检出的浏览器设置操作；这里没有任何内容会进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有盖章且未编译的检出时，打包应用无法更新** — Host 从本插件模块路径和 `process.cwd()` 向上查找 `TINYWHALE.md` 与 `.git`。`desktop` 的 `install:dev` 会把该路径写入 `Contents/Resources/tinywhale-checkout.json`，让 Dock 应用启动这棵树而不是已发布的 `dsh`。没有这枚 stamp，或还没跑过 `pnpm build`，这一行仍显示，但「更新」不会作用到本检出。
- **不会重载正在运行的进程** — apply 只更新磁盘上的文件；TinyWhale 与 `dsh web` 会继续提供此前已加载的代码，直到用户重启。
- **冲突与脏工作区会拦住按钮** — apply 不会 stash、不会强制 reset，也不会自动解决品牌文件冲突。
