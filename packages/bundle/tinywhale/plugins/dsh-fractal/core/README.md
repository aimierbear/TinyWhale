# 六端分形公共后端

这里是现有用户级分形能力的公共实现，不是独立产品，也不替代 `.folder.md`、现有规则文档或 `fractal-self-description` Skill。

## 1.3 系列实现

- 九个版本化公共 action，通过 `bin/fractal-action` 的单 JSON stdin/stdout 合同调用。
- 四个受限 capability：依赖图谱扫描/查询、CAS 分形文档更新和 closeout 完成，通过 `bin/fractal-capability` 调用。
- SQLite 权威状态、并发 scope、unowned journal、精确 closeout 回执、崩溃恢复和 operation 防重放。
- 图谱扫描器及运行依赖随 release 哈希闭合；状态写入私有 state root，回合收尾批量处理本 session 尚未确认的变更。
- `.folder.md` 与根 README 更新必须经过候选白名单、内容哈希和最终提交点复验；模型不接触 capability token。
- 原生 closeout 把已改源码作为只读审计输入，自动写入仅限白名单内的 `.folder.md` / 根 README；文件头协议仍由显式 `fractal-self-description` 流程处理。
- Claude、Codex、Kimi、Grok、Pi、Cursor 六个 Manifest 与薄事件适配器。
- Manifest 动态注册；新增 Agent 不需要修改公共动作或 doctor 枚举。
- 自动 LLM 技术审计：无工具、封闭四字段输出、精确证据 token 和本地 gate 复核。
- 版本化 release、`current/previous` 回滚、owner-scoped JSON/TOML 合并和默认 dry-run。
- 六端原生入口统一落到 `~/.local/bin/fractal-hook`；升级 release 时不需要再次改写宿主配置。
- 激活器按 owner 精确迁移已登记的旧入口并保留无关 hook；实际是否 installed/discovered/invoked/effective 以 doctor 证据为准，不由配置文件存在性推断。

## 安全边界

- 原始 session ID 进入公共层前必须 SHA-256。
- vendor 原始 payload 只能在端侧适配器解析；持久 fixture 仅保存 schema shape 和 synthetic 值。
- change scope 建立时固化 Git 工作区基线；既有未提交改动不会被归到新 scope，只有 scope 内的进一步变化才触发审计。图谱索引在需要分类或显式查询时更新，不阻塞 SessionStart 热路径。
- fixture/manual 证据只能显示黄色。只有当前 runtime/adapter 版本匹配且 24 小时内的 native probe 才显示绿色。
- 技术审计可自动处理；产品意图、费用、凭据生命周期和不可逆操作必须请求用户授权。
- `fractal-manage release` 默认 dry-run。真实切换还要求调用方同时提供 `--runtime-stopped` 与可信 quiescence verifier；命令行标志本身不能充当停机证据。
- `fractal-manage activate` 只替换各端由 `ai.fractal.*.v1` 标记的节点及 activation spec 精确登记的旧入口，保留其他钩子；写入前生成私有备份，重复执行必须零差异。

## 本地验证

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
FRACTAL_RUN_SCALE_TESTS=1 python3 -m unittest tests.performance.test_public_hotpaths -v
bin/fractal-manage doctor --runtime-version grok=0.2.111
```

doctor 的 installed/discovered/invoked/effective 是四个独立证据等级；文件存在不等于行为生效。

## 1.3 切换后的激活目标

- Claude：`~/.claude/settings.json`
- Codex：`~/.codex/hooks.json`
- Kimi：`~/.kimi-code/config.toml`
- Grok：`~/.grok/hooks/fractal-agent.json`
- Pi：`~/.pi/agent/extensions/fractal-agent.ts`
- Cursor：`~/.cursor/hooks.json`

新会话默认加载；安装期间已经打开的会话需要重新打开，Cursor 需要重载窗口或重启应用。Cursor 同时使用 `postToolUse` 与 `afterFileEdit` 检测改动，并在 `stop` 通过 `followup_message` 让 LLM 自动完成分形自审，不要求用户阅读技术审计。宿主自身的网络、模型、代理或钩子投递故障会被 doctor 如实显示为未验证，不会被配置存在掩盖。
