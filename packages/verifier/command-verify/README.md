# @deepseek-ai/dsh-command-verify

English | [中文](README.zh.md)

Human-facing `/verify` command over `ctx.subagents` and `ctx.verifier`. The command runs parallel candidate attempts and submits the verifier-selected winner as an ordinary user message.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `trials` | `3` | Parallel candidate attempts per invocation |
| `provider` | `spawn` | `ctx.subagents` provider name |
| `pivots` | `2` | PPT pivot count |
| `nVerifications` | `1` | Verifier repetitions per directed pair |
| `seed` | `0` | PPT ring seed |
| `majorityVoting` | `true` | Skip the tournament on a strict majority |
| `timeoutMs` | `900000` | End-to-end command deadline |

## Model Experience

### `/verify` command

#### What the model sees

The command input and direct status/error output are absent from model requests. When candidate selection finishes, the model sees one ordinary user message: the text `Best verified result for: <task>` followed by the selected candidate result. The message is a `user/message` and is replayed from the session log like any other user turn.

#### Token effect

The submitted winner message is billed as ordinary user input. Candidate attempts and verifier scoring run as separate agent sessions and nested LLM calls; their intermediate output is not added to the main conversation history.

#### KV Cache effect

The main conversation appends the submitted user message after the command invocation; later requests follow the ordinary history. Candidate and verifier calls are independent requests.

## Known Limitations and Deferred Work

- **Shared workspace** — candidate attempts run as fresh spawn subagents in the same working directory; concurrent writes can conflict.
- **Final-answer selection** — candidates are ranked by their final assistant output, not by full replayable trajectory detail.
- **No progress UI** — the command reports one success or error result; the visualizer-equivalent progress curve is deferred.
