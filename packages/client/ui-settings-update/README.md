# @deepseek-ai/dsh-client-ui-settings-update

English | [中文](README.zh.md)

TinyWhale-owned General-settings row that updates this install. A source checkout still fetches `upstream` (adding `https://github.com/deepseek-ai/deepseek-harness.git` when that remote is missing) and merges `upstream/master`. A dirty or detached work tree is refused. After `git merge --no-commit`, apply restores the overlay paths in `src/overlay.ts` from the pre-merge HEAD (README pair, LICENSE, desktop, TinyWhale packages). Remaining conflicts run `git merge --abort`. When the merge changes `pnpm-lock.yaml`, the Host runs `pnpm --dir <root> install`. A packaged app (`TINYWHALE_PACKAGED=1`) does not merge git: apply opens the GitHub Releases page so the user can download a new DMG. The Host registers a loopback-only `/tinywhale` Connection channel. The browser half registers the row only on a loopback page. When the Host is neither a TinyWhale git checkout nor a packaged install, or the status call fails, the row stays visible with a disabled button and the reason. Electron prefers this checkout's CLI over a published `dsh` on PATH, and attaches to an already-running Web UI only when `/tinywhale/status` answers.

`remoteName`, `remoteUrl`, and `branch` are plugin `Config` fields. The Electron shell does not restart itself; the running `dsh web` process keeps the code it already loaded until the user quits.

## Model Experience

None, as the plugin is a browser Settings action over a Host git checkout; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A packaged app updates by download, not git merge** — `TINYWHALE_PACKAGED=1` makes status available and apply return a Releases URL. The running `dsh web` process still does not reload itself.
- **A checkout without `TINYWHALE.md` and `.git` cannot merge** — the Host walks from this plugin's module path and `process.cwd()`. `desktop` `install:dev` stamps that path into `Contents/Resources/tinywhale-checkout.json` so the Dock app starts this tree instead of a published `dsh`.
- **The running process is not reloaded** — apply updates files on disk; TinyWhale and `dsh web` keep serving the previous code until the user restarts them.
- **Non-overlay conflicts and dirty trees stop the button** — apply never stashes and never force-resets. Overlay paths in `src/overlay.ts` are restored from ours; any other conflict still aborts.
