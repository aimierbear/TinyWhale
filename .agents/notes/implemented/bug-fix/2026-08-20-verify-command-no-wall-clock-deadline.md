# Agent Note: Verify command has no wall-clock deadline

Status: implemented

English | [中文](2026-08-20-verify-command-no-wall-clock-deadline.zh.md)

## Problem

`/verify` runs parallel candidate subagents and a verifier tournament. A 15-minute command-owned `timeoutMs` fused `invocation.signal` into `deadline()`, so a real implementation task that outlived that window failed as `VERIFY_COMMAND_TIMEOUT after 900000ms` and posted `Verification failed for: …` while candidates were still working. `timeoutMs <= 0` is internal timeout-library vocabulary, not a public config switch for "no timeout".

## Decision

`dsh-command-verify` does not arm a wall-clock deadline and does not depend on `@deepseek-ai/dsh-timeout`. Config has no `timeoutMs`. Candidate `ctx.subagents.start` calls and `ctx.verifier.select` receive `invocation.signal` directly. Selection runs until it settles or that signal aborts.

After each await, an aborted signal appends `The verification was cancelled.` as a plugin-sourced `user/message` without waking the driver, instead of ranking aborted candidate diagnostics as a winner. Only `completed` runs with non-empty text enter majority voting or the tournament. Admission and `command/done` stay on the [background-command path](2026-08-20-background-command-admits-before-handler.md).

## Testing

`packages/verifier/command-verify/tests/command-verify.spec.ts` pins that candidate starts receive the invocation signal object (not a fused deadline) and that aborting that signal before starts settle posts the cancellation failure.

## Alternatives considered

**Keep `timeoutMs` with a larger default.** Rejected: any finite default still kills a longer real task. The failure is the same class as 15 minutes.

**Keep optional `timeoutMs` defaulting to "off".** Rejected: zero is not a public disable-timeout sentinel. An unused operator knob is hypothetical flexibility.

**Leave aborted candidate results as tournament inputs.** Rejected: identical abort diagnostics can win majority voting and submit an abort string as the best verified result.

## Consequences

A hung candidate occupies the command until cancel or plugin dispose. The model-facing `verify` tool declares its own `timeoutMs` (default 60 minutes); that budget is the exclusive-barrier tool-call policy, not this command.
