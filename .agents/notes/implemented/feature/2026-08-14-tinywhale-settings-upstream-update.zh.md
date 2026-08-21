# Agent Note: TinyWhale Settings upstream update

Status: implemented

[English](2026-08-14-tinywhale-settings-upstream-update.md) | 中文

## Problem

TinyWhale 是 DeepSeek Harness 的 git 检出。更新它意味着离开应用，去终端执行 `git fetch` / `git merge`。Electron 壳只加载 Web UI，因此 Host 上的设置控件才是桌面应用里也会出现的产品路径。

## Decision

[`@deepseek-ai/dsh-client-ui-settings-update`](../../../../packages/client/ui-settings-update/README.zh.md) 同时拥有两端。Host 注册仅 loopback 可用的 `/tinywhale` Connection 通道（`status`、`apply`），而不扩展共享的 `RpcMethodMap`，因此这次特权 git 写入不会走 Typert 的 trusted-host 拦截器，也不会进入每次上游合并都会碰到的 apiproxy 表面。

`status` 从本插件模块路径（以及 `process.cwd()`）向上查找 `TINYWHALE.md` 与 `.git`，并且不 fetch。`apply` 在工作区有未提交更改或 detached HEAD 时拒绝执行；若缺少 `upstream` 远程则添加它（默认 URL 为 `https://github.com/deepseek-ai/deepseek-harness.git`），然后 fetch，并合并 `upstream/master`（若该分支名不存在则使用远程 HEAD）。冲突时运行 `git merge --abort`。锁文件变化时运行 `pnpm --dir <root> install`。通用设置行只在 loopback 上注册；检出缺失或 status 调用失败时这一行仍显示，按钮禁用并说明原因。Electron 优先使用本检出的 `apps/cli/src/bin.ts`，而不是 PATH 上已发布的 `dsh`；只有 `/tinywhale/status` 有应答时才会挂到已经在跑的 Web UI。

## Alternatives considered

- **只把按钮放在 Electron 菜单里** — 否决，因为需求是设置控件，而且桌面应用的渲染进程没有 Node。浏览器和 Electron 已经共享的是 Host 通道。
- **把 `host.pullUpdate` 加进 apiproxy** — 否决，因为那张表是上游合并热点，而且会把 TinyWhale 独有的 git 写入暴露到公共 RPC 表面。
- **合并 `origin`（本 TinyWhale 远程）而不是 `upstream`** — 此次按钮否决。用户要的是上游仓库；[TINYWHALE.md](../../../../TINYWHALE.md) 把该远程定为 DeepSeek Harness。

## Consequences

一次 loopback 设置点击就能改动安装检出，包括网络 fetch 和 `pnpm install`。远程浏览器永远看不到该行。`desktop` 的 `install:dev` 会把本 monorepo 写入 `tinywhale-checkout.json`，让 Dock 应用启动 `apps/cli/src/bin.ts`，而不是 3080 上已发布的 `dsh`；这次拉起仍然需要先 `pnpm build`。正在运行的进程在重启前仍是旧代码。品牌文件冲突仍然需要终端处理，与现有 fork 同步规则一致。
