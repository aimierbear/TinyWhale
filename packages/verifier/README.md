# verifier/ — pairwise verifier family

English | [中文](README.zh.md)

This family ports the llm-as-a-verifier pairwise reward and Probabilistic Pivot Tournament behind `ctx.verifier`, and exposes them to the model as `verify`.

| Package | Role | ctx key |
|---|---|---|
| [`verifier/`](verifier/README.md) | Defines provider registration, `select`/`compare`, budget, PPT, and criteria parsing | `ctx.verifier` |
| [`verifier-conversation/`](verifier-conversation/README.md) | Scores directed pairs through `ctx.llm` with conversation-target inheritance | registers on `ctx.verifier` |
| [`tool-verifier/`](tool-verifier/README.md) | Exposes `verify` to the model | registers on `ctx.tools` |

The subsystem reference is [docs/subsystems/verifier.md](../../docs/subsystems/verifier.md). Portions of the algorithm, prompt, and bundled criteria are derived from [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) (MIT).
