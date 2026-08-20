# Agent Note: Background commands admit before handler settlement

Status: implemented

English | [中文](2026-08-20-background-command-admits-before-handler.zh.md)

## Problem

The composer holds the draft read-only in `submitting` until `commands.execute` returns. `/verify` runs parallel candidate subagents and a verifier tournament inside that handler, so the RPC stayed open for the whole selection window (default 15 minutes). The send control looked live, the typed `/verify` line stayed in the composer, and follow-up messages could not be queued even though `command/run` and the candidate rows were already visible.

## Decision

`CommandDefinition.background` is a host-only flag. When it is true and the handler returns a thenable, `CommandRuntime.execute` returns `{ kind: 'success' }` with the minted `commandId` as soon as that thenable exists. `command/run` has already been appended. `command/done` still records the handler's later settlement, including expected errors and thrown failures.

A synchronous handler result still settles `execute` in the same turn, so a `/verify` line with no task keeps the composer error path. Image admission still completes before the handler runs. Listed descriptors omit `background`.

`/verify` sets `background: true` and returns a synchronous usage error for an empty task. Candidate start, majority voting, the verifier tournament, `submitStarted`, `submitWinner`, and `submitFailure` stay on the same handler promise.

## Testing

`packages/interaction/commands/tests/commands.spec.ts` covers admission before settlement, synchronous background errors, an explicit `background: false` wait, a later handler rejection, and a later malformed result. `packages/verifier/command-verify/tests/command-verify.spec.ts` covers empty-task execute errors, follow-up after admission, and execute returning while candidate starts are still pending.

## Alternatives considered

**Return success from the `/verify` handler after `submitStarted` and fire the tournament on a detached promise.** Rejected because `command/done` would then fire at admission and the command card would leave "running" while candidates were still live. The registry flag keeps the card on `command/run` until selection actually settles.

**Make every `execute` return after `command/run`.** Rejected because image-carrying commands need the handler's error result on the RPC so the composer can keep draft images. `/goal` and `/plan` grammar errors would clear the composer if admission always succeeded.

**Unlock the composer on the client when `command/run` arrives, while leaving the RPC waiting.** Rejected because the hanging unary still occupies the request until the tournament ends, which is the failure the send button exhibited.

**Pass a never-aborted signal into background handlers.** Rejected because `/verify` forwards `invocation.signal` to candidate starts and the verifier tournament; cooperative cancellation during selection stays available. Uncooperative handlers already outlive `execute` today.

## Consequences

A background command's `execute` result is admission success, not the handler text. Local `command/executed` observers on the submitting client therefore see that admission, while `command/done` remains the durable outcome. `/verify` is the only shipped definition that sets the flag. Empty `/verify` still returns an execute error because the handler result is synchronous.
