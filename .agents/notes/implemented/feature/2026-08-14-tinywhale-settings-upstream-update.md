# Agent Note: TinyWhale Settings upstream update

Status: implemented

English | [中文](2026-08-14-tinywhale-settings-upstream-update.zh.md)

## Problem

TinyWhale is a git checkout of DeepSeek Harness. Updating it meant leaving the app for a terminal `git fetch` / `git merge`. The Electron shell only loads the Web UI, so a Settings control on the Host is the product path that also appears in the desktop app.

## Decision

[`@deepseek-ai/dsh-client-ui-settings-update`](../../../../packages/client/ui-settings-update/README.md) owns both halves. The Host registers a loopback-only `/tinywhale` Connection channel (`status`, `apply`) instead of extending the shared `RpcMethodMap`, so the privileged git write does not ride Typert's trusted-host interceptor or the apiproxy surface that every upstream merge would touch.

`status` walks from this plugin's module path (and `process.cwd()`) to `TINYWHALE.md` plus `.git` and does not fetch. `apply` refuses a dirty or detached tree, adds the `upstream` remote when missing (default URL `https://github.com/deepseek-ai/deepseek-harness.git`), fetches, and merges `upstream/master` (or the remote HEAD when that branch name is absent). A conflict runs `git merge --abort`. A lockfile change runs `pnpm --dir <root> install`. The General-settings row registers only on loopback and stays visible when the checkout is missing or the status call fails; the button is disabled and the row shows why. Electron prefers this checkout's `apps/cli/src/bin.ts` over a published `dsh` on PATH, and it attaches to an already-running Web UI only when `/tinywhale/status` answers.

## Alternatives considered

- **Put the button only in the Electron menu** — rejected because the request is a Settings control, and the desktop app has no Node in the renderer. A Host channel is what both the browser and Electron already share.
- **Add `host.pullUpdate` to apiproxy** — rejected because that map is an upstream merge hotspot and would expose a TinyWhale-only git write on the public RPC surface.
- **Merge `origin` (this TinyWhale remote) instead of `upstream`** — rejected for this button. The user asked for the upstream repository; [TINYWHALE.md](../../../../TINYWHALE.md) names that remote DeepSeek Harness.

## Consequences

A loopback Settings click can change the install checkout, including a network fetch and a `pnpm install`. Remote browsers never see the row. `desktop` `install:dev` stamps this monorepo into `tinywhale-checkout.json` so the Dock app starts `apps/cli/src/bin.ts` instead of a published `dsh` on 3080; that spawn still needs `pnpm build`. The running process is stale until restart. Branding conflicts still need a terminal, matching the existing fork sync rule.
