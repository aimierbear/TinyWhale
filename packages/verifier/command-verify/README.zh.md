# @deepseek-ai/dsh-command-verify

[English](README.md) | 中文

面向用户的 `/verify` 命令，基于 `ctx.subagents` 与 `ctx.verifier`。命令并行运行多个候选尝试，并把 verifier 选出的最优结果作为普通用户消息提交。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `trials` | `3` | 每次调用的并行候选尝试数 |
| `provider` | `spawn` | `ctx.subagents` provider 名称 |
| `pivots` | `2` | PPT pivot 数 |
| `nVerifications` | `1` | 每个定向对的重复验证次数 |
| `seed` | `0` | PPT ring 种子 |
| `majorityVoting` | `true` | 严格多数时跳过 tournament |
| `timeoutMs` | `900000` | 命令端到端截止时间 |

## Model Experience

### `/verify` 命令

#### 模型看到什么

命令输入和直接的状态/错误输出不会进入模型请求。命令派发时，聊天表面会立即追加一条可见的 `user/message` 占位 `[Verification started] <task>`，随后才启动候选子代理。候选选择完成后，一条 `Best verified result for: <task>` 加所选结果的后续用户消息唤醒模型。失败时，一条 `Verification failed for: <task>` 加失败详情的后续用户消息同样唤醒模型，因此会话不会无声停止。这两条后续消息都是普通 `user/message` 事件，并从会话日志重放。

#### Token 影响

提交的获胜消息按普通用户输入计费。候选尝试和 verifier 评分在独立 agent 会话和嵌套 LLM 调用中运行，其中间输出不进入主对话历史。

#### KV Cache 影响

主对话在命令调用后追加提交的用户消息，后续请求按普通历史继续。候选与 verifier 调用是独立请求。

## Known Limitations and Deferred Work

- **共享工作目录** — 候选尝试以全新 spawn 子代理运行在同一工作目录，并发写入可能冲突。
- **按最终回答选优** — 候选按最终 assistant 输出排名，不是按完整可回放轨迹细节。
- **没有进度 UI** — 命令只返回一次成功或错误结果，尚未提供可视化器对应的进度曲线。
