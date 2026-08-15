# dsh-security-codex

DeepSeek Harness / TinyWhale 的树外（out-of-tree）插件：`security_scan`
后台任务工具。审查完全在 harness 进程内运行，通过 DSH 的 LLM 服务调用
**聊天正在使用的同一 provider / model**（默认取发起会话当前的路由），
不依赖任何外部 CLI、子进程或额外凭据。

每个任务：收集目标仓库的文本源码（跳过二进制、超大文件、`.git` /
`node_modules` 等目录），按字节预算分批，逐批让模型以严格 JSON 输出
findings（severity / title / path / line / description / suggestion），
聚合去重后写入 `report.md` 并返回完成摘要。`deep` 模式在第一轮之后对
有 findings 的批次追加一轮校验，模型对照代码确认、修正或剔除误报。

## 安装

```sh
cd ~/.dsh/plugins/dsh-security-codex
npm run build
npm pack
~/.hermes/node/bin/dsh plugin --profile web add "$PWD/dsh-security-codex-0.2.4.tgz"
```

`dsh plugin add` 会把包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`。
重启 TinyWhale（或当前连接的 `dsh web` 进程）后，新会话的模型即可见
`security_scan` 工具。

## 前置条件

- 目标 profile 已组合 LLM 服务（`ctx.llm`）与 jobs 能力（`ctx.jobs`）；
  web profile 天然具备。
- 模型凭据走 harness 自身的聊天凭据链，插件不需要也不读取任何额外凭据。

## 模型路由解析

一次扫描的 provider / model 按以下顺序确定，任何一步为空或未注册都
fail loud：

1. 插件配置的 `provider` / `model`（配置即覆盖）；
2. 发起会话的当前聊天路由（`session.requestHeader()` 记录的
   `deepseek-official` / 模型 id）；
3. 都没有 → 工具调用报错，要求配置 `provider` 与 `model`。

`effort` 配置控制审查调用的思考档位（默认 `off`），模型调用自己的输出上限由
`maxTokens` 控制。

## 配置（cordis.patch.yml 中按 id 覆盖 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | 无（取会话路由） | LLM provider 路由，必须已注册 adapter |
| `effort` | `off` | 审查调用的思考档位：`off` / `high` / `max` |
| `model` | 无（取会话路由） | 模型 id |
| `maxFileBytes` | `262144` (256 KB) | 单文件字节上限，更大直接跳过 |
| `maxTotalBytes` | `4194304` (4 MB) | 全仓库收集字节预算，超出的文件跳过 |
| `batchBytes` | `524288` (512 KB) | 单次模型调用的文件内容字节预算 |
| `maxBatches` | `12` | 每轮最多调用次数（deep 的校验轮同样受此约束） |
| `maxTokens` | `16384` | 单次调用的输出 token 上限 |
| `maxFindings` | `100` | 最终报告保留的 findings 上限 |
| `outputDir` | 无（每次扫描的临时目录） | 报告目录，必须是绝对路径 |

## 工具行为

`security_scan` 每次调用立即返回 `{ kind: 'background', jobId }`，审查在
`ctx.jobs` 后台任务（kind `security-scan`）中运行：完成时按通用 jobs 机制
通知模型，`job_output` 幂等返回完成摘要（模型路由、文件与调用计数、
token 用量、按严重度的 findings 列表、报告路径；上限 32 KB）。取消在批次
之间生效，模型调用携带 AbortSignal。

工具参数：`target`（绝对路径，默认会话工作区）、`mode`
（`standard` / `deep`）、`paths`（仓库相对路径过滤）、
`extra_instructions`（追加到每批提示词的额外审查指令，≤ 32 KB）。

## 已知限制

- 单轮内审查：模型只读给定批次的文件快照，不执行代码、不跑子进程；
  需要动态验证（如运行 PoC）的确认留给人。
- 符号链接一律不跟随：全仓遍历跳过链接项；显式 paths 里指向仓库外的链接直接报错。
- 审查提示词把文件内容标为不可信数据，但模型仍可能被精心构造的源码内容诱导——这是 LLM 审查的固有残余风险，deep 模式的校验轮是其缓解。
- findings 依赖模型的 JSON 输出：解析失败的批次计入
  `unparseable batches`，该批次文件不会重试（deep 模式的校验轮对可解析
  批次重读）。
- 不比较 git 基线：没有 `--diff` 语义，审查的是当前工作区快照。
- 任务进行中不流式呈现进度；`job_output` 完成时才有摘要。

## 开发

```sh
npm run typecheck   # tsc --noEmit
npm run test        # node:test + tsx（29 个单测，fake LLM stream）
npm run build       # tsc → lib/
```

peer 依赖（`@deepseek-ai/cordis`、`dsh-agent`、`dsh-jobs`、`dsh-llm`、
`dsh-session`、`dsh-tools`、`schemastery`）通过符号链接指向本机 dsh 安装
的 node_modules，与仓库内插件版本要求一致（0.1.0-rc.5 || 0.1.0-rc.6）。
