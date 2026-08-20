# @deepseek-ai/dsh-tool-verifier

[English](README.md) | 中文

基于 `ctx.verifier` 的面向模型 `verify` 工具。本包拥有 schema、默认值、校验、渲染和展示。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultNEvaluations` | `2` | 与 Terminal-Bench 2.1 benchmark 条目一致 |
| `maxNEvaluations` | `8` | 重复次数上限 |
| `defaultPivots` | `2` | PPT 支点数量 |
| `maxCandidates` | `6` | `select` 上限 |
| `maxCandidateChars` | `20000` | 单个候选文本上限 |
| `maxTotalChars` | `60000` | 总和上限 |
| `timeoutMs` | `3600000` | 覆盖 ring/pivot、warm/rest 以及一次重试的独占屏障预算 |

工具不声明 `isConcurrencySafe`，因此同一步内后续工具调用会等待。

## 模型体验

### `verify` 工具

#### What the model sees

生成的[工具目录](../../../docs/tool-catalog.md#verify)以及这段 description：

##### Verify tool description

```markdown
Compare or rank candidate trajectories with a pairwise verifier. Scoring issues auxiliary LLM calls through the same conversation model (purpose verification). Use mode=compare when you have exactly two candidates. select over two candidates repeats ring edges and costs more. select ranks 2..6 candidates with a probabilistic pivot tournament. Call cost: select makes (N + k(N-k) + C(k,2)) × criteria × n_evaluations nested calls, where k = min(pivots, N). compare makes criteria × n_evaluations nested calls. Default n_evaluations is 2. The call is an exclusive barrier: later same-step tool calls wait, up to 60 minutes. Default criteria is the bundled terminal_bench rubric (specification, output match, error signals). Pass explicit criteria for any task that is not a terminal-benchmark trajectory. Do not supply both criteriaName and criteria. Candidate text stays in the model-visible tool-call record and is resent with conversation history until compaction. Paste only the evidence a judge needs. This tool does not execute candidates, run tests, or inspect files. It only scores the text you provide.
```

#### Token effect

候选文本会保留在工具调用记录中直到 compaction。嵌套评分独立于对话请求。

#### KV Cache effect

外层对话前缀因 `verify` 调用和结果而增长。嵌套评分请求是独立的，不会改写该前缀。

## 已知限制与延后工作

- **上下文税** — 候选文本是模型可见输入，并在 compaction 前重发。
- **默认准则是 Terminal-Bench** — 非终端任务必须显式传 `criteria`。
