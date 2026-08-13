# @deepseek-ai/dsh-client-ui-settings-update

English | [中文](README.zh.md)

TinyWhale-owned General-settings row that updates this install from the DeepSeek Harness upstream remote. The Host half locates the checkout that contains `TINYWHALE.md`, registers a loopback-only `/tinywhale` Connection channel, and on apply fetches `upstream` (adding `https://github.com/deepseek-ai/deepseek-harness.git` when that remote is missing) then merges `upstream/master`. A dirty or detached work tree is refused; a merge conflict runs `git merge --abort`. When the merge changes `pnpm-lock.yaml`, the Host runs `pnpm --dir <root> install`. The browser half registers the row only on a loopback page. When the Host is not a TinyWhale git checkout or the status call fails, the row stays visible with a disabled button and the reason. Electron prefers this checkout's CLI over a published `dsh` on PATH, and attaches to an already-running Web UI only when `/tinywhale/status` answers.

`remoteName`, `remoteUrl`, and `branch` are plugin `Config` fields. The Electron shell does not restart itself; the running `dsh web` process keeps the code it already loaded until the user quits.

## Model Experience

None, as the plugin is a browser Settings action over a Host git checkout; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A packaged app without a stamped, built checkout cannot update** — the Host walks from this plugin's module path and `process.cwd()` to `TINYWHALE.md` and `.git`. `desktop` `install:dev` stamps that path into `Contents/Resources/tinywhale-checkout.json` so the Dock app starts this tree instead of a published `dsh`. Without the stamp, or without `pnpm build`, the row stays visible but Update does not run against this checkout.
- **The running process is not reloaded** — apply updates files on disk; TinyWhale and `dsh web` keep serving the previous code until the user restarts them.
- **Conflicts and dirty trees stop the button** — apply never stashes, never force-resets, and never resolves branding conflicts.
