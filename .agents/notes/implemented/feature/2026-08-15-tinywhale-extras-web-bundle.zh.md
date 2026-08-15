# Agent Note: TinyWhale extras web bundle

Status: implemented

[English](2026-08-15-tinywhale-extras-web-bundle.md) | 中文

## Problem

新建 TinyWhale `web` profile 只挂载 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`。产品 extras——分形、安全扫描、右侧边栏、插件市场、GenUI、自动续写、ModLens——必须手工加；已经初始化过的 `$DSH_HOME/profiles/web` 归用户所有，改写模板会惊吓现有安装。

## Decision

[`@deepseek-ai/dsh-tinywhale`](../../../../packages/bundle/tinywhale/README.md) 是一份 patch 列表 extras 组合包。[`PROFILE_TEMPLATES.web`](../../../../packages/boot/app-boot/src/profile.ts) 为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-tinywhale`。`headless` 不挂载它。已经初始化过的 web profile 保留自己存下的组合包列表。

插入行是 fractal、security-codex、dshmarket、`@omdsh-dev/dsh-genui`、`dsh-client-auto-continue`、`dsh-better-sidebar`、`@liustack/modlens`。`dsh-fractal`、`dsh-security-codex` 和 `dsh-better-sidebar` 作为 `file:` 副本放在 [`plugins/`](../../../../packages/bundle/tinywhale/plugins/ORIGIN.md) 下。better-sidebar 副本保留中间栏压缩补丁，并把出厂右侧叶播种为「任务管理」再「资源管理器」；仍只含这两类页签的已持久化出厂叶会在加载时升级。

## Alternatives considered

- **把 extras 折进 `dsh-web-app`** — 否决，因为该组合包是上游合并热点，而这些 extras 归 TinyWhale。
- **升级时改写已有 web profile** — 否决，因为那些清单归用户所有；[TINYWHALE.md](../../../../TINYWHALE.md) 写明保持原样。
- **也把 extras 挂到 `headless`** — 否决，因为插入行是 GUI 或桌面侧的。
- **原样从 npm 安装 `dsh-better-sidebar`** — 否决，因为 TinyWhale 需要中间栏压缩，以及「任务管理再资源管理器」的出厂默认。

## Consequences

缺失的 `web` profile 会拾取 extras；已有的不会，除非用户把 `@deepseek-ai/dsh-tinywhale` 加到 `dsh-web-app` 之后，并去掉同一行的用户层副本。工作区安装不得重建 `dshmarket`，分形扫描器随包携带封闭的 `node_modules`。自定义侧边栏分栏和额外页签类型保持不动。
