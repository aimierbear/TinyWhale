# Agent Note: Remove the first-party plugin market

Status: implemented

English | [中文](2026-08-15-remove-first-party-plugin-market.zh.md)

## Problem

TinyWhale shipped a first-party plugin market as two workspace packages plus Web Settings wiring: a Host Remote that scanned GitHub sources, installed into a profile, and stored self-review and ignore marks, and a Settings tab that projected a maintainer-verified snapshot of the `dsh-plugin` topic. That surface duplicated community discovery without becoming the product's chosen market, while still adding a forwarded Host event, a catalog-data gate, and two packages every web assembly had to carry.

The original motivation was real: browsing community plugins only through GitHub is unsafe if the product then offers install, and a catalog that silently tracks upstream would inherit unreviewed changes. Those constraints still apply to any future first-party market. They do not justify keeping this unused in-tree implementation.

## Decision

Delete the first-party market completely: `@deepseek-ai/dsh-host-plugin-market`, `@deepseek-ai/dsh-client-ui-settings-plugin-market`, their tests, snapshot and verified-catalog data, generate and verify scripts, the `verify-plugin-market-data` gate, the `plugin-market/scan-progress` forwarded event, and the two `dsh-web-app` rows. No alias, stub Remote, or empty Settings tab remains.

Settings → Plugins keeps the existing configuration and inventory tabs. Community market plugins installed into a profile stay outside this change. This note consolidates and replaces the former architecture record for the in-tree market.

A first-party market may return only as a new decision with its own packages and wiring. Leftover settings namespaces `plugin-market-self-verified` and `plugin-market-ignored` are inert user data; this change does not migrate or delete them.

## Alternatives considered

- **Disable the two `dsh-web-app` rows and keep the packages.** Rejected because unused packages, a forwarded event, and a catalog gate would still compile, install, and demand maintenance.
- **Keep the Host Remote for other UIs.** Rejected because no remaining surface calls `pluginMarket`, and a Remote without a consumer is not a product seam.
- **Replace the tab with a link to an external catalog.** Rejected because that is a different product decision; this change only removes the unused first-party implementation.

## Consequences

Web Settings no longer contributes a first-party Plugin market tab. `pluginMarket` is not a Remote namespace, and `plugin-market/scan-progress` is not a forwarded Host event. Imports of `@deepseek-ai/dsh-host-plugin-market` and `@deepseek-ai/dsh-client-ui-settings-plugin-market` no longer resolve.

The repository no longer owns a maintainer-verified `dsh-plugin` snapshot or a static scanner for community plugin sources. Plugin inventory and plugin configuration are unchanged. An installed third-party market plugin is not part of this removal.

## Verification

Workspace package discovery, the web-app patch list, the Remote assembly, and the forwarded-event allowlist contain no first-party market package, row, namespace, or event. Focused remotes and apiproxy tests still pass. Documentation and generated-catalog gates reject live references to the removed packages.
