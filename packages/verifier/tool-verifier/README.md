# @deepseek-ai/dsh-tool-verifier

English | [中文](README.zh.md)

Model-facing `verify` tool over `ctx.verifier`. This package owns schemas, defaults, validation, rendering, and presentation.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `defaultNEvaluations` | `2` | Matches the Terminal-Bench 2.1 benchmark entry |
| `maxNEvaluations` | `8` | Upper bound on repetitions |
| `defaultPivots` | `2` | PPT pivot count |
| `maxCandidates` | `6` | `select` upper bound |
| `maxCandidateChars` | `20000` | Per-candidate text cap |
| `maxTotalChars` | `60000` | Sum cap |
| `timeoutMs` | `3600000` | Exclusive-barrier budget covering ring/pivot, warm/rest, and one retry |

The tool does not declare `isConcurrencySafe`, so later same-step tool calls wait.

## Model Experience

### `verify` tool

#### What the model sees

The generated [tool catalog](../../../docs/tool-catalog.md#verify) plus this description:

##### Verify tool description

```markdown
Compare or rank candidate trajectories with a pairwise verifier. Scoring issues auxiliary LLM calls through the same conversation model (purpose verification). Use mode=compare when you have exactly two candidates. select over two candidates repeats ring edges and costs more. select ranks 2..6 candidates with a probabilistic pivot tournament. Call cost: select makes (N + k(N-k) + C(k,2)) × criteria × n_evaluations nested calls, where k = min(pivots, N). compare makes criteria × n_evaluations nested calls. Default n_evaluations is 2. The call is an exclusive barrier: later same-step tool calls wait, up to 60 minutes. Default criteria is the bundled terminal_bench rubric (specification, output match, error signals). Pass explicit criteria for any task that is not a terminal-benchmark trajectory. Do not supply both criteriaName and criteria. Candidate text stays in the model-visible tool-call record and is resent with conversation history until compaction. Paste only the evidence a judge needs. This tool does not execute candidates, run tests, or inspect files. It only scores the text you provide.
```

#### Token effect

Candidate text is retained on the tool-call record until compaction. Nested scoring is independent of the conversation request.

#### KV Cache effect

The outer conversation prefix grows by the `verify` call and result. Nested scoring requests are independent and do not rewrite that prefix.

## Known Limitations and Deferred Work

- **Context tax** — candidate text is model-visible input and is resent until compaction.
- **Default rubric is Terminal-Bench** — non-terminal tasks must pass explicit `criteria`.
