# @deepseek-ai/dsh-verifier

[English](README.md) | 中文

**`VerifierRuntime`**（`ctx.verifier`）定义 harness 具备哪些成对验证能力——用 Probabilistic Pivot Tournament 给候选排序，或对一个定向对打分——而不把模型约定绑定到某一种裁判传输层。

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-verifier`（本包） | Service Definition：注册表、选择、预算、PPT、准则解析、`VerifierError` |
| `@deepseek-ai/dsh-verifier-conversation` | Provider：通过嵌套 `ctx.llm` 打分，并继承对话目标 |
| `@deepseek-ai/dsh-tool-verifier` | Consumer：面向模型的 `verify` 工具 |

部分内容来自 [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)（MIT）。

```
MIT License

Copyright (c) 2026 llm-as-a-verifier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

本 README 保留上游许可证文本，因为本包含有移植的算法与准则材料。

## 服务 API（`ctx.verifier`）

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 注册后端。id 重复时抛出 `VerifierError` `VERIFIER_DUPLICATE_PROVIDER`。返回 disposer。 |
| `select(agent, request, signal?)` | 解析提供方、检查预算、运行 PPT 并返回排名。 |
| `compare(agent, request, signal?)` | 以 `onError: 'raise'` 为定向对 `[0, 1]` 打分，并返回原始奖励。 |

## 选择

| 情况 | 执行 |
|---|---|
| 已配置 id 已注册且 `available()` | 运行该提供方 |
| 已配置 id 未注册 | `VERIFIER_PROVIDER_CONFIGURED_MISSING` |
| 已配置 id 已注册但不可用 | `VERIFIER_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配置 id，恰好一个可用提供方 | 运行它 |
| 未配置 id，没有可用提供方 | `VERIFIER_PROVIDER_UNAVAILABLE` |
| 未配置 id，多个可用提供方 | `VERIFIER_PROVIDER_AMBIGUOUS` |

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` | `''` | 空表示选择唯一已注册的提供方 |
| `maxCalls` | `96` | 每次 `select`/`compare` 的嵌套 LLM 调用硬上限 |

预算：`select` 为 `(N + k(N-k) + C(k,2)) × 准则数 × nEvaluations`，其中 `k = min(pivots, N)`；`compare` 为 `准则数 × nEvaluations`。超过 `maxCalls` 会在任何嵌套调用前抛出 `VERIFIER_BUDGET_EXCEEDED`。

## 模型体验

间接通过 `dsh-tool-verifier`：该包保留 `verify` schema、渲染后的排名或比较摘要，以及结构化的 `VerifierError` 失败；本注册表本身不贡献提示词或 schema。

#### KV Cache effect

无直接失效；由具名消费者和对话提供方拥有请求前缀变化。

## 已知限制与延后工作

- **没有 token 级 logprobs** — 对话提供方每次嵌套调用采样一个 A-T 字母；未来的 logprob 提供方可复用 `extractScore` 而不改 PPT 或 `verify`。
- **没有 `track`、图片或分数缓存** — v1 只接受候选文本，且不持久化成对分数。
- **没有引用式候选** — 文件路径和 subagent session id 推迟。
