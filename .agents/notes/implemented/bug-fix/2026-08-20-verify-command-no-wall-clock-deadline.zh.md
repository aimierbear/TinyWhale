# Agent Note: Verify command has no wall-clock deadline

Status: implemented

[English](2026-08-20-verify-command-no-wall-clock-deadline.md) | 中文

## Problem

`/verify` 并行运行候选子代理和 verifier 评选。命令自有的 15 分钟 `timeoutMs` 把 `invocation.signal` 折入 `deadline()`，因此超过该窗口的真实实现任务会以 `VERIFY_COMMAND_TIMEOUT after 900000ms` 失败，并在候选仍在工作时发出 `Verification failed for: …`。`timeoutMs <= 0` 是超时库的内部词汇，不是面向配置的「关闭超时」开关。

## Decision

`dsh-command-verify` 不设置截止时间，也不依赖 `@deepseek-ai/dsh-timeout`。Config 没有 `timeoutMs`。候选的 `ctx.subagents.start` 调用和 `ctx.verifier.select` 直接接收 `invocation.signal`。选择过程一直运行到结算或该信号中止。

每次 await 之后，若信号已中止，则把 `The verification was cancelled.` 作为插件来源的 `user/message` 追加且不唤醒驱动器，而不是把已中止候选的诊断文本当作获胜结果。只有 `completed` 且文本非空的运行会进入多数投票或 tournament。准入和 `command/done` 走 [background 命令路径](2026-08-20-background-command-admits-before-handler.zh.md)。

## Testing

`packages/verifier/command-verify/tests/command-verify.spec.ts` 固定：候选启动收到的是 invocation 信号对象本身（不是融合后的 deadline），以及在启动结算前中止该信号会发出取消失败。

## Alternatives considered

**保留 `timeoutMs` 并加大默认值。** 否决：任何有限默认值仍会杀死更长的真实任务。失败类型与 15 分钟相同。

**保留可选 `timeoutMs`，默认「关闭」。** 否决：零不是面向公开配置的关闭超时哨兵。无人使用的操作员旋钮属于假想灵活性。

**把已中止候选的结果留给 tournament 输入。** 否决：相同的中止诊断可以通过多数投票，把中止字符串当作最优验证结果提交。

## Consequences

挂起的候选会占用该命令，直到取消或插件 dispose（资源释放）。面向模型的 `verify` 工具声明自己的 `timeoutMs`（默认 60 分钟）；那是独占屏障的工具调用策略，不是这条命令。
