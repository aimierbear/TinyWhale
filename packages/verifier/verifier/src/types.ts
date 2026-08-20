/**
 * Vocabulary for the verifier capability (`ctx.verifier`): pairwise scoring,
 * PPT selection, provider registration, and the log-only `verifier/call` event.
 * @module @deepseek-ai/dsh-verifier/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** One scoring criterion with a stable id, display name, and judge instruction. */
export interface VerifierCriterion {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** One candidate trajectory identified for ranking or comparison. */
export interface VerifierCandidate {
  readonly id: string
  readonly text: string
}

/**
 * Agent-owned session plus the conversation route fallback used when no
 * `request/header` is present. `Agent` satisfies this structurally.
 */
export interface VerifierContext {
  readonly session: Session
  readonly options: { readonly provider?: string; readonly model?: string }
}

/** Inputs for a PPT `select` over two or more candidates. */
export interface VerifierSelectRequest {
  readonly problem: string
  readonly candidates: readonly VerifierCandidate[]
  readonly criteria: readonly VerifierCriterion[]
  readonly groundTruthNote: string
  readonly nEvaluations: number
  readonly pivots: number
  readonly seed: number
}

/** Inputs for a single directed `compare` of two candidates in fixed slot order. */
export interface VerifierCompareRequest {
  readonly problem: string
  readonly candidates: readonly [VerifierCandidate, VerifierCandidate]
  readonly criteria: readonly VerifierCriterion[]
  readonly groundTruthNote: string
  readonly nEvaluations: number
}

/**
 * Inputs for one provider scoring batch. Pair keys are candidate indexes.
 * `select` sets `swapOddRepetitions` and forwards the provider's `onError`;
 * `compare` never swaps and always uses `onError: 'raise'`.
 */
export interface VerifierPairsRequest {
  readonly problem: string
  readonly candidates: readonly VerifierCandidate[]
  readonly pairs: readonly (readonly [number, number])[]
  readonly criteria: readonly VerifierCriterion[]
  readonly groundTruthNote: string
  readonly nEvaluations: number
  readonly onError: 'raise' | 'tie'
  readonly swapOddRepetitions: boolean
}

/** Directed pairwise rewards, optionally with per-criterion breakdown and usage. */
export interface PairwiseScore {
  readonly rA: number
  readonly rB: number
  readonly criteria: readonly {
    readonly criterionId: string
    readonly rA: number
    readonly rB: number
  }[]
  readonly calls: number
  readonly usage?: TokenUsage
}

/** A backend that scores directed candidate pairs through nested LLM calls. */
export interface VerifierProvider {
  readonly id: string
  /**
   * How `select` pair jobs treat a failed nested call. `compare` ignores this
   * and always raises.
   */
  readonly onError: 'raise' | 'tie'
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /**
   * Score the requested directed pairs.
   * @param agent - session and route fallback for target inheritance.
   * @param request - pairs, criteria, repetition, and failure policy.
   * @param signal - cancellation forwarded to nested streams.
   * @returns a map keyed by {@link pairKey} values `"a,b"`.
   */
  scorePairs(
    agent: VerifierContext,
    request: VerifierPairsRequest,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, PairwiseScore>>
}

/** PPT ranking over the supplied candidates. */
export interface VerifierSelectResult {
  readonly kind: 'select'
  readonly selectedId: string
  readonly ranking: readonly { readonly candidateId: string; readonly score: number }[]
  readonly nComparisons: number
  readonly criteriaIds: readonly string[]
  readonly calls: number
  readonly usage?: TokenUsage
}

/** Raw directed rewards for candidates `[0]` (A) and `[1]` (B). */
export interface VerifierCompareResult {
  readonly kind: 'compare'
  readonly rA: number
  readonly rB: number
  readonly criteria: PairwiseScore['criteria']
  readonly calls: number
  readonly usage?: TokenUsage
}

/**
 * Log-only record of one nested verifier LLM call, appended before the enclosing
 * `tool/result`. Replay derives a stream entry from `rawOutput` at this log position.
 */
export interface VerifierCallEventData {
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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One nested verifier scoring call — log-only, not a surface event.
     * `rawOutput` is the complete assembled provider output so llm-replay can
     * reconstruct the stream at this log position.
     */
    'verifier/call': VerifierCallEventData
  }
}

/**
 * Typed verifier error with a machine-routable `code`.
 * Shared codes cover duplicate, missing, unusable, or ambiguous providers,
 * partial judge config, missing conversation target or agent, call-budget
 * overflow, invalid arguments, and nested LLM failure.
 */
export class VerifierError extends HarnessError {}

/** Shipped conversation-model provider id. */
export const VERIFIER_PROVIDER_CONVERSATION = 'conversation'

/** Bundled criteria names accepted by the `verify` tool. */
export const BUNDLED_CRITERIA_NAMES = ['terminal_bench', 'swe_bench', 'medagentbench'] as const

/** One bundled criteria file name. */
export type BundledCriteriaName = (typeof BUNDLED_CRITERIA_NAMES)[number]
