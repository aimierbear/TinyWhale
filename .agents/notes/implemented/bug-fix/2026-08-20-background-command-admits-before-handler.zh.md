# Agent Note: Background commands admit before handler settlement

Status: implemented

[English](2026-08-20-background-command-admits-before-handler.md) | 中文

## Problem

composer 在 `submitting` 阶段把草稿设为只读，直到 `commands.execute` 返回。`/verify` 在该处理器内并行运行候选子代理和 verifier 评选，因此这条 RPC 会在整个选择窗口（默认 15 分钟）内一直不返回。发送控件看起来仍可用，已输入的 `/verify` 行留在 composer 里，后续消息无法排队，即使 `command/run` 和候选行已经可见。

## Decision

`CommandDefinition.background` 是仅 Host 使用的标志。当它为 true 且处理器返回 thenable 时，`CommandRuntime.execute` 一旦得到该 thenable，就带着新生成的 `commandId` 返回 `{ kind: 'success' }`。`command/run` 此时已经追加。`command/done` 仍记录处理器随后的结算，包括预期错误和抛出的失败。

同步的处理器结果仍在同一轮结算 `execute`，因此没有任务的 `/verify` 行仍走 composer 错误路径。图片准入仍在处理器运行前完成。列出的描述符省略 `background`。

`/verify` 设置 `background: true`，并在任务为空时返回同步的用法错误。候选启动、多数投票、verifier 评选、`submitStarted`、`submitWinner` 和 `submitFailure` 仍在同一条处理器 promise 上。

## Testing

`packages/interaction/commands/tests/commands.spec.ts` 覆盖结算前准入、background 同步错误、显式 `background: false` 等待、随后的处理器拒绝，以及随后的畸形结果。`packages/verifier/command-verify/tests/command-verify.spec.ts` 覆盖空任务的 execute 错误、准入后的 follow-up，以及候选启动仍挂起时 execute 已返回。

## Alternatives considered

**在 `submitStarted` 之后让 `/verify` 处理器返回成功，并把评选放到分离的 promise 上。** 否决，因为那样 `command/done` 会在准入时触发，命令卡片会在候选仍在运行时离开“执行中”。注册表标志让卡片留在 `command/run`，直到选择真正结算。

**让每次 `execute` 都在 `command/run` 之后返回。** 否决，因为携带图片的命令需要把处理器错误结果放在 RPC 上，composer 才能保留草稿图片。如果准入总是成功，`/goal` 和 `/plan` 的语法错误会清空 composer。

**在客户端看到 `command/run` 时解锁 composer，同时让 RPC 继续等待。** 否决，因为挂起的一元请求仍会占用到评选结束，而这正是发送按钮表现出来的故障。

**向 background 处理器传入永不中止的信号。** 否决，因为 `/verify` 把 `invocation.signal` 转发给候选启动和 verifier 评选；选择期间仍可协作取消。不合作的处理器今天本来就会比 `execute` 活得更久。

## Consequences

background 命令的 `execute` 结果是准入成功，而不是处理器文本。因此提交该命令的客户端上的本地 `command/executed` 观察者看到的是这次准入，而 `command/done` 仍是持久化结果。`/verify` 是目前唯一设置该标志的已交付定义。空的 `/verify` 仍返回 execute 错误，因为处理器结果是同步的。
