# @deepseek-ai/dsh-verifier

English | [中文](README.zh.md)

**`VerifierRuntime`** (`ctx.verifier`) defines what pairwise verification the harness has — rank candidates with a Probabilistic Pivot Tournament, or score one directed pair — without binding the model contract to one judge transport.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-verifier` (this) | Service Definition: registry, selection, budget, PPT, criteria parsing, `VerifierError` |
| `@deepseek-ai/dsh-verifier-conversation` | Provider: nested `ctx.llm` scoring with conversation-target inheritance |
| `@deepseek-ai/dsh-tool-verifier` | Consumer: the model-facing `verify` tool |

Portions derived from [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) (MIT).

```
MIT License

Copyright (c) 2026 llm-as-a-verifier
```

The upstream license text is retained in this README as required for ported algorithm and criteria material.

## Service API (`ctx.verifier`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Register a backend. Throws `VerifierError` `VERIFIER_DUPLICATE_PROVIDER` on a duplicate id. Returns a disposer. |
| `select(agent, request, signal?)` | Resolve the provider, budget-check, run PPT, and return the ranking. |
| `compare(agent, request, signal?)` | Score directed pair `[0, 1]` with `onError: 'raise'` and return raw rewards. |

## Selection

| Situation | Execution |
|---|---|
| configured id registered and `available()` | runs that provider |
| configured id not registered | `VERIFIER_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `VERIFIER_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `VERIFIER_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `VERIFIER_PROVIDER_AMBIGUOUS` |

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | `''` | Empty selects the sole registered provider |
| `maxCalls` | `96` | Hard cap on nested LLM calls per `select`/`compare` |

Budget: `select` costs `(N + k(N-k) + C(k,2)) × criteria × nEvaluations` with `k = min(pivots, N)`; `compare` costs `criteria × nEvaluations`. Exceeding `maxCalls` throws `VERIFIER_BUDGET_EXCEEDED` before any nested call.

## Model Experience

Indirectly, through `dsh-tool-verifier`, which retains the `verify` schema, rendered ranking or compare summary, and structured `VerifierError` failures while this registry contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; the named consumer and conversation provider own request-prefix changes.

## Known Limitations and Deferred Work

- **No token-level logprobs** — the conversation provider samples one A-T letter per nested call; a future logprob provider can reuse `extractScore` without changing PPT or `verify`.
- **No `track`, images, or score cache** — v1 accepts candidate text only and does not persist pairwise scores.
- **No reference-form candidates** — file paths and subagent session ids are deferred.
