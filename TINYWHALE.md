# TinyWhale fork notes

TinyWhale is the public product name of this repository. It is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) under the MIT License.

## Boundaries

- User-facing name, window title, and GitHub repository: **TinyWhale**.
- Internal npm packages remain `@deepseek-ai/*` until an explicit rescope. The workspace treats `apps/*` as publishable release members; do not add a private Electron package there.
- Desktop shell lives in [`desktop/`](desktop/README.md) and is **not** a pnpm workspace member. The dependency-only deploy root [`desktop/runtime-root`](desktop/runtime-root/package.json) is a workspace member so `pnpm deploy` can materialize the packaged harness.
- `desktop` `npm run pack` is the developer Dock app (stamps this checkout). `npm run dist` is the self-contained DMG (vendors `runtime/` with `packaged.json`, starts the bundled `dsh`).
- New `web` profiles include [`@deepseek-ai/dsh-tinywhale`](packages/bundle/tinywhale/README.md) after `dsh-web-app`. An already-initialized `$DSH_HOME/profiles/web` is not rewritten.
- Keep the upstream copyright in `LICENSE` and the attribution in `NOTICE` when distributing.

## Syncing upstream

Loopback Settings → General → **软件更新** / **Software update** on a git checkout fetches and merges the configured upstream remote. The button refuses a dirty or detached tree, restores the overlay paths below from the pre-merge HEAD, aborts on any remaining conflict, and installs from `pnpm-lock.yaml` when that file changed. A packaged app (`TINYWHALE_PACKAGED=1`) does not merge git: the same row opens the GitHub Releases page. Restart TinyWhale afterward; the running `dsh web` process does not reload itself. Electron shows the same row because it loads the Web Settings UI. The Dock/dev app (`desktop` `npm run pack && npm run install:dev`) stamps this checkout into `Contents/Resources/tinywhale-checkout.json` and starts `apps/cli/src/bin.ts` unless `/tinywhale/status` is already answering; `pnpm build` must have produced host `lib/` and the web frontend, or that spawn exits before the UI is ready.

From a terminal, use the same overlay merge (do not run a raw `git merge`; that still takes upstream-only edits to branding files):

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
pnpm run merge-upstream
```

### Overlay (TinyWhale keeps these on every upstream merge)

Git cannot mark a path as "never take theirs": a merge driver only runs when both sides changed. The update path therefore restores these paths after `git merge --no-commit`:

- `README.md`, `README.zh.md`, `README.i18n.yaml`
- `LICENSE`, `NOTICE`, `TINYWHALE.md`
- `apps/web/index.html`, `apps/web/public/icon-mark.png`
- `desktop/`
- `packages/bundle/tinywhale/`
- `packages/client/ui-settings-update/`
- `packages/verifier/`

The list lives in [`packages/client/ui-settings-update/src/overlay.ts`](packages/client/ui-settings-update/src/overlay.ts). Paths that mix branding with harness behavior stay off it and still merge: `packages/client/web/src/boot-page.ts`, theme tokens, `packages/boot/app-boot/src/profile.ts`, generated catalogs, `THIRD_PARTY_NOTICES.md`. Keep harness behavior from upstream in those files unless a TinyWhale change owns the hunk.
