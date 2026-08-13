# TinyWhale fork notes

TinyWhale is the public product name of this repository. It is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) under the MIT License.

## Boundaries

- User-facing name, window title, and GitHub repository: **TinyWhale**.
- Internal npm packages remain `@deepseek-ai/*` until an explicit rescope. The workspace treats `apps/*` as publishable release members; do not add a private Electron package there.
- Desktop shell lives in [`desktop/`](desktop/README.md) and is **not** a pnpm workspace member.
- Keep the upstream copyright in `LICENSE` and the attribution in `NOTICE` when distributing.

## Syncing upstream

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream
git merge upstream/master
```

Resolve conflicts in branding files (`README.md`, `README.zh.md`, `NOTICE`, `TINYWHALE.md`, `desktop/`) in favor of TinyWhale naming, and keep harness behavior from upstream unless a TinyWhale change owns that file.
