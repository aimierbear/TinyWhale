# Agent Note: TinyWhale extras web bundle

Status: implemented

English | [中文](2026-08-15-tinywhale-extras-web-bundle.zh.md)

## Problem

A new TinyWhale `web` profile only mounted `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. Product extras — fractal, security scan, the right sidebar, plugin market, GenUI, auto-continue, and ModLens — had to be added by hand, and an already-initialized `$DSH_HOME/profiles/web` is user-owned, so a template rewrite would surprise existing installs.

## Decision

[`@deepseek-ai/dsh-tinywhale`](../../../../packages/bundle/tinywhale/README.md) is a patch-list extras bundle. [`PROFILE_TEMPLATES.web`](../../../../packages/boot/app-boot/src/profile.ts) is `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-tinywhale`. `headless` does not mount it. An already-initialized web profile keeps its stored bundle list.

The insert list is fractal, security-codex, dshmarket, `@omdsh-dev/dsh-genui`, `dsh-client-auto-continue`, `dsh-better-sidebar`, and `@liustack/modlens`. `dsh-fractal`, `dsh-security-codex`, and `dsh-better-sidebar` live as `file:` copies under [`plugins/`](../../../../packages/bundle/tinywhale/plugins/ORIGIN.md). The better-sidebar copy keeps the center-column layout patch and seeds a factory right-hand leaf as Tasks then Explorer; a persisted factory leaf that still holds only those two types is upgraded on load.

## Alternatives considered

- **Fold extras into `dsh-web-app`** — rejected because that bundle is an upstream merge hotspot and the extras are TinyWhale-owned.
- **Rewrite existing web profiles on upgrade** — rejected because those manifests are user-owned; [TINYWHALE.md](../../../../TINYWHALE.md) states they stay as stored.
- **Mount the extras on `headless` too** — rejected because the inserted rows are GUI or desktop-adjacent.
- **Install `dsh-better-sidebar` from npm unchanged** — rejected because TinyWhale needs the center-column squeeze and the Tasks-then-Explorer factory default.

## Consequences

A missing `web` profile picks up the extras; an existing one does not until the user appends `@deepseek-ai/dsh-tinywhale` after `dsh-web-app` and removes any user-layer copies of the same rows. Workspace install must not rebuild `dshmarket`, and the fractal scanner ships a closed `node_modules`. Custom sidebar splits and extra tab types stay untouched.
