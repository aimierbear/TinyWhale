# verifier/ — 成对验证器系列

[English](README.md) | 中文

本系列把 llm-as-a-verifier 的成对奖励与 Probabilistic Pivot Tournament 接到 `ctx.verifier` 之后，通过 `verify` 向模型公开，并通过 `/verify` 面向用户。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`verifier/`](verifier/README.md) | 定义提供方注册、`select`/`compare`、预算、PPT 和准则解析 | `ctx.verifier` |
| [`verifier-conversation/`](verifier-conversation/README.md) | 通过 `ctx.llm` 对定向对打分，并继承对话目标 | 注册到 `ctx.verifier` |
| [`tool-verifier/`](tool-verifier/README.md) | 向模型公开 `verify` | 注册到 `ctx.tools` |
| [`command-verify/`](command-verify/README.md) | 面向用户的 `/verify` 命令：并行候选、多数投票或 PPT，提交获胜结果 | 注册到 `ctx.commands` |

子系统参考见 [docs/subsystems/verifier.md](../../docs/subsystems/verifier.md)。算法、prompt 和内置准则的部分内容来自 [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)（MIT）。
