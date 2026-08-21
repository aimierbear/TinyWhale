# Verifier

English | [中文](verifier.zh.md)

The verifier capability — a [capability seam](../../.agents/notes/implemented/feature/2026-08-19-llm-as-a-verifier-plugin.md) that ranks or compares candidate trajectories: Service Definition ([dsh-verifier](../../packages/verifier/verifier), `ctx.verifier`), Service Provider ([dsh-verifier-conversation](../../packages/verifier/verifier-conversation)), and Consumer ([dsh-tool-verifier](../../packages/verifier/tool-verifier), the `verify` tool). The human `/verify` command lives in [dsh-command-verify](../../packages/verifier/command-verify). Verifier is an optional capability, not part of the agent-loop spine.

Source: [`packages/verifier/verifier/src/types.ts`](../../packages/verifier/verifier/src/types.ts)

## Requests and results

```ts type-equiv
/** One scoring criterion with a stable id, display name, and judge instruction. */
interface VerifierCriterion {
  readonly id: string
  readonly name: string
  readonly description: string
}
```

```ts type-equiv
/** One candidate trajectory identified for ranking or comparison. */
interface VerifierCandidate {
  readonly id: string
  readonly text: string
}
```

```ts type-equiv
/**
 * Agent-owned session plus the conversation route fallback used when no
 * `request/header` is present. `Agent` satisfies this structurally.
 */
interface VerifierContext {
  readonly session: Session
  readonly options: { readonly provider?: string; readonly model?: string }
}
```

`select` runs a Probabilistic Pivot Tournament over directed pairwise rewards. Pair keys are candidate indexes `a,b`. `compare` scores the single directed pair `[0, 1]` in fixed slot order.

## Errors

`VerifierError` extends `HarnessError`. Shared codes: `VERIFIER_DUPLICATE_PROVIDER`, `VERIFIER_PROVIDER_CONFIGURED_MISSING`, `VERIFIER_PROVIDER_CONFIGURED_UNAVAILABLE`, `VERIFIER_PROVIDER_UNAVAILABLE`, `VERIFIER_PROVIDER_AMBIGUOUS`, `VERIFIER_TARGET_PARTIAL`, `VERIFIER_NO_TARGET`, `VERIFIER_NO_AGENT`, `VERIFIER_BUDGET_EXCEEDED`, `VERIFIER_INVALID_ARGUMENT`, `VERIFIER_LLM_FAILED`.

## Session event

`verifier/call` is a log-only record of one nested scoring stream. llm-replay derives a stream entry from `rawOutput` at that log position.

```ts type-equiv
/**
 * Log-only record of one nested verifier LLM call, appended before the enclosing
 * `tool/result`. Replay derives a stream entry from `rawOutput` at this log position.
 */
interface VerifierCallEventData {
  readonly providerId: string
  readonly route: { readonly provider: string; readonly model: string }
  readonly pair: readonly [number, number]
  readonly criterionId: string
  readonly repetition: number
  readonly sampledLetters: readonly string[]
  readonly rawOutput: readonly ContentBlock[]
  /** False when the nested stream finished as a failure or threw. */
  readonly ok: boolean
  /** True when a successful call scored either slot as the 0.5 text fallback. */
  readonly fallback?: boolean
  readonly usage?: TokenUsage
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxverifier--verifierruntime"></a>

### `ctx.verifier` — `VerifierRuntime`

The verifier service. Registered as `ctx.verifier` (one instance per context).

Selection is resolved at execution time and never depends on registration order: a configured id must be registered and `available()`; otherwise exactly one usable provider is required.

```ts cordis-catalog
/**
 * Register a scoring provider. Throws {@link VerifierError}
 * `VERIFIER_DUPLICATE_PROVIDER` if its id is already registered.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: VerifierProvider): () => void

/**
 * Rank candidates with a Probabilistic Pivot Tournament. Pair generation
 * matches upstream, including directed pairs a pivot round may repeat.
 * @param agent - session and conversation-route fallback.
 * @param request - problem, candidates, criteria, and PPT parameters.
 * @param signal - cancellation forwarded to the provider.
 * @returns the selected candidate, ranking, comparison count, and usage.
 */
async select( agent: VerifierContext, request: VerifierSelectRequest, signal?: AbortSignal, ): Promise<VerifierSelectResult>

/**
 * Score one directed pair in fixed candidate order. Always raises on a
 * failed nested call, matching upstream `compare()`.
 * @param agent - session and conversation-route fallback.
 * @param request - problem, the two candidates, and criteria.
 * @param signal - cancellation forwarded to the provider.
 * @returns raw rewards in candidate order plus per-criterion breakdown.
 */
async compare( agent: VerifierContext, request: VerifierCompareRequest, signal?: AbortSignal, ): Promise<VerifierCompareResult>
```

Source: [`packages/verifier/verifier/src/index.ts`](../../packages/verifier/verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
