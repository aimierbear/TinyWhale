# `@deepseek-ai/dsh-tinywhale`

[English](README.md) | 中文

TinyWhale extras 作为 profile 组合包：[`cordis.patch.yml`](cordis.patch.yml) 在随发行版交付的 `web` 模板上，于 [`dsh-web-app`](../web-app/README.zh.md) 之后插入默认的社区与第一方插件行。该包没有运行时 API；profile 组合器通过 manifest（元数据清单）的 `dsh.bundle.patch` 字段解析 patch，绝不通过代码。

被插入的包是本组合包的依赖，因此从本次安装解析。其中三个提交在 [`plugins/`](plugins/ORIGIN.md) 下（`dsh-fractal`、`dsh-security-codex`，以及 TinyWhale 打过补丁的 `dsh-better-sidebar`）；其余来自 npm 或钉死的 GitHub commit。后续的 profile 或 home `cordis.patch.yml` 仍可按 id 禁用或覆盖任一插入行。

这一层只做 `web` 模板的第三个组合包。`headless` 不挂载它。已经初始化过的 `web` profile 归用户所有，不会被改写；若要改用本层，把 `@deepseek-ai/dsh-tinywhale` 加到该 profile 的 `dsh.profile.bundles`（放在 `@deepseek-ai/dsh-web-app` 之后），并先去掉对应的用户层副本，否则这些行会双重挂载。

## 模型体验

通过插入的行间接产生影响：该组合包选定 TinyWhale 的默认 extras，自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响由其所属的包负责。

## 已知限制与暂缓事项

- **已有 `web` profile 保持原样** — 只有缺失的 profile 才会从随发行版交付的模板拾取本组合包。库存的 `[dsh-base, dsh-web-app]` 列表不会被改写。
- **`dsh-better-sidebar` 是打过补丁的快照** — 上游给 `#root` 加的 margin 会挤塌 TinyWhale 左侧会话列表；内置副本保留 `plugins/dsh-better-sidebar/LOCAL-PATCH.md` 里的中间栏压缩。不要用上游 tarball 替换该目录。
- **GitHub 托管的 `dsh-genui` 按 commit 钉死** — 升级 extras 时，依赖 spec 与本条限制必须一起改。
- **内置的 `file:` 插件从本检出解析** — `dsh-fractal`、`dsh-security-codex` 和 `dsh-better-sidebar` 不是 registry 包。把本组合包发成 npm tarball 时无法安装它们。
- **`dsh-fractal` 需要 PATH 上有 `python3` 和 `node`** — 随包的 1.3.1 核心通过这两个解释器启动。适配器优先用 `core/bin/fractal-*`，然后是 `FRACTAL_ACTION_BIN` / `FRACTAL_CAPABILITY_BIN`，最后是 `~/.local/bin`。
