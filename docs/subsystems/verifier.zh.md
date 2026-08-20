# 验证器

[English](verifier.md) | 中文

验证器能力——一个[能力 seam](../../.agents/notes/implemented/feature/2026-08-19-llm-as-a-verifier-plugin.md)，用于给候选轨迹排序或比较：Service Definition（[dsh-verifier](../../packages/verifier/verifier)，`ctx.verifier`）、Service Provider（[dsh-verifier-conversation](../../packages/verifier/verifier-conversation)）和 Consumer（[dsh-tool-verifier](../../packages/verifier/tool-verifier)，`verify` 工具）。验证器是可选能力，不是 agent-loop 主干的一部分。

来源：[`packages/verifier/verifier/src/types.ts`](../../packages/verifier/verifier/src/types.ts)

## 请求与结果

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

`select` 用定向成对奖励跑 Probabilistic Pivot Tournament。对的键是候选下标 `a,b`。`compare` 按固定槽位顺序为定向对 `[0, 1]` 打分。

## 错误

`VerifierError` 继承 `HarnessError`。共享错误码：`VERIFIER_DUPLICATE_PROVIDER`、`VERIFIER_PROVIDER_CONFIGURED_MISSING`、`VERIFIER_PROVIDER_CONFIGURED_UNAVAILABLE`、`VERIFIER_PROVIDER_UNAVAILABLE`、`VERIFIER_PROVIDER_AMBIGUOUS`、`VERIFIER_TARGET_PARTIAL`、`VERIFIER_NO_TARGET`、`VERIFIER_NO_AGENT`、`VERIFIER_BUDGET_EXCEEDED`、`VERIFIER_INVALID_ARGUMENT`、`VERIFIER_LLM_FAILED`。

## 会话事件

`verifier/call` 是一次嵌套评分流的只写日志记录。llm-replay 在该日志位置从 `rawOutput` 派生一条流条目。

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
  readonly usage?: TokenUsage
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Source: [`packages/verifier/verifier/src/index.ts:103`](../../packages/verifier/verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
