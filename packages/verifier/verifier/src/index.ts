/**
 * Service Definition for the verifier capability (`ctx.verifier`): provider
 * registry, selection, budget check, and `select`/`compare` orchestration.
 * @module @deepseek-ai/dsh-verifier
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  accumulate,
  atIndex,
  countSelectComparisons,
  pairKey,
  pivotRoundPairs,
  rankingFromTotals,
  ringCycleFromSeed,
  selectPivots,
} from './pivot-tournament.ts'
import type { DirectedPair } from './pivot-tournament.ts'
import { addUsage } from './usage.ts'
import { VerifierError } from './types.ts'
import type {
  PairwiseScore,
  VerifierCompareRequest,
  VerifierCompareResult,
  VerifierContext,
  VerifierPairsRequest,
  VerifierProvider,
  VerifierSelectRequest,
  VerifierSelectResult,
} from './types.ts'

export {
  BUNDLED_CRITERIA_NAMES,
  VERIFIER_PROVIDER_CONVERSATION,
  VerifierError,
} from './types.ts'
export type {
  BundledCriteriaName,
  PairwiseScore,
  VerifierCallEventData,
  VerifierCandidate,
  VerifierCompareRequest,
  VerifierCompareResult,
  VerifierContext,
  VerifierCriterion,
  VerifierPairsRequest,
  VerifierProvider,
  VerifierSelectRequest,
  VerifierSelectResult,
} from './types.ts'
export {
  dedupCriterionId,
  isBundledCriteriaName,
  loadBundledCriteria,
  normalizeCriteria,
  parseCriteriaMarkdown,
  slugCriterionId,
} from './criteria.ts'
export type { InlineCriterionInput, ParsedCriteria } from './criteria.ts'
export {
  accumulate,
  atIndex,
  bradleyTerry,
  countSelectComparisons,
  pairKey,
  pivotRoundPairs,
  rankingFromTotals,
  ringCycle,
  ringCycleFromSeed,
  selectBest,
  selectPivots,
} from './pivot-tournament.ts'
export type { DirectedPair, DirectedScore, PivotTournamentResult, RankingTotals } from './pivot-tournament.ts'
export { addUsage } from './usage.ts'
export { createSeededRng } from './rng.ts'
export { MEDAGENTBENCH_CRITERIA_MARKDOWN } from './bundled/medagentbench.ts'
export { SWE_BENCH_CRITERIA_MARKDOWN } from './bundled/swe-bench.ts'
export { TERMINAL_BENCH_CRITERIA_MARKDOWN } from './bundled/terminal-bench.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierRuntime
  }
}

/** Deployment config for the verifier seam. */
export interface VerifierRuntimeConfig {
  /** Explicit provider id. Empty or omitted auto-selects when exactly one usable provider is registered. */
  readonly provider?: string
  /** Hard cap on nested LLM calls per `select`/`compare`. */
  readonly maxCalls?: number
}

/** Default hard cap on nested LLM calls per `select`/`compare`. */
export const DEFAULT_VERIFIER_MAX_CALLS = 96

/**
 * The verifier service. Registered as `ctx.verifier` (one instance per context).
 *
 * Selection is resolved at execution time and never depends on registration order:
 * a configured id must be registered and `available()`; otherwise exactly one
 * usable provider is required.
 */
export class VerifierRuntime extends Service {
  /**
   * Provider pin and call-budget cap. An empty `provider` auto-selects the sole
   * registered usable provider.
   */
  static Config: z<VerifierRuntimeConfig> = z.object({
    provider: z.string(),
    maxCalls: z.number().step(1).min(1).default(DEFAULT_VERIFIER_MAX_CALLS),
  })

  private readonly providers = new Map<string, VerifierProvider>()
  private readonly providerId: string | undefined
  private readonly maxCalls: number

  constructor(ctx: Context, config: VerifierRuntimeConfig = {}) {
    super(ctx, 'verifier')
    this.providerId = config.provider !== undefined && config.provider.length > 0
      ? config.provider
      : undefined
    // Direct construction resolves the same default the Loader materializes from `Config`.
    this.maxCalls = config.maxCalls ?? DEFAULT_VERIFIER_MAX_CALLS
  }

  /**
   * Register a scoring provider. Throws {@link VerifierError}
   * `VERIFIER_DUPLICATE_PROVIDER` if its id is already registered.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: VerifierProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new VerifierError(
        `a verifier provider with id "${provider.id}" is already registered`,
        'VERIFIER_DUPLICATE_PROVIDER',
      )
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'verifier.registerProvider()')
    return () => void dispose()
  }

  /**
   * Rank candidates with a Probabilistic Pivot Tournament. Pair generation
   * matches upstream, including directed pairs a pivot round may repeat.
   * @param agent - session and conversation-route fallback.
   * @param request - problem, candidates, criteria, and PPT parameters.
   * @param signal - cancellation forwarded to the provider.
   * @returns the selected candidate, ranking, comparison count, and usage.
   */
  async select(
    agent: VerifierContext,
    request: VerifierSelectRequest,
    signal?: AbortSignal,
  ): Promise<VerifierSelectResult> {
    const n = request.candidates.length
    if (n < 2) {
      throw new VerifierError('select requires at least two candidates', 'VERIFIER_INVALID_ARGUMENT')
    }
    if (request.criteria.length === 0) {
      throw new VerifierError('select requires at least one criterion', 'VERIFIER_INVALID_ARGUMENT')
    }
    if (request.nEvaluations < 1) {
      throw new VerifierError('nEvaluations must be >= 1', 'VERIFIER_INVALID_ARGUMENT')
    }
    const comparisons = countSelectComparisons(n, request.pivots)
    this.assertBudget(comparisons * request.criteria.length * request.nEvaluations, 'select')
    const provider = this.resolveProvider()
    const ring = ringCycleFromSeed(n, request.seed)
    const ringScores = await this.scoreDirected(
      provider,
      agent,
      request,
      ring,
      provider.onError,
      true,
      signal,
    )
    const ringWins = Array.from({ length: n }, () => 0)
    const ringCounts = Array.from({ length: n }, () => 0)
    accumulate(ring, scoreLookup(ringScores), ringWins, ringCounts)
    const extra = pivotRoundPairs(n, selectPivots(ringWins, ringCounts, request.pivots))
    const extraScores = await this.scoreDirected(
      provider,
      agent,
      request,
      extra,
      provider.onError,
      true,
      signal,
    )
    const merged = new Map(ringScores)
    for (const [key, value] of extraScores) merged.set(key, value)
    const totalsW = Array.from({ length: n }, () => 0)
    const totalsC = Array.from({ length: n }, () => 0)
    const mergedLookup = scoreLookup(merged)
    accumulate(ring, mergedLookup, totalsW, totalsC)
    accumulate(extra, mergedLookup, totalsW, totalsC)
    const result = rankingFromTotals(totalsW, totalsC)
    const { calls, usage } = tallyScores([ringScores, extraScores])
    return {
      kind: 'select',
      selectedId: atIndex(request.candidates, result.selectedIndex).id,
      ranking: result.ranking.map(index => ({
        candidateId: atIndex(request.candidates, index).id,
        score: atIndex(result.scores, index),
      })),
      nComparisons: ring.length + extra.length,
      criteriaIds: request.criteria.map(criterion => criterion.id),
      calls,
      ...usage !== undefined ? { usage } : {},
    }
  }

  /**
   * Score one directed pair in fixed candidate order. Always raises on a
   * failed nested call, matching upstream `compare()`.
   * @param agent - session and conversation-route fallback.
   * @param request - problem, the two candidates, and criteria.
   * @param signal - cancellation forwarded to the provider.
   * @returns raw rewards in candidate order plus per-criterion breakdown.
   */
  async compare(
    agent: VerifierContext,
    request: VerifierCompareRequest,
    signal?: AbortSignal,
  ): Promise<VerifierCompareResult> {
    if (request.criteria.length === 0) {
      throw new VerifierError('compare requires at least one criterion', 'VERIFIER_INVALID_ARGUMENT')
    }
    if (request.nEvaluations < 1) {
      throw new VerifierError('nEvaluations must be >= 1', 'VERIFIER_INVALID_ARGUMENT')
    }
    this.assertBudget(request.criteria.length * request.nEvaluations, 'compare')
    const provider = this.resolveProvider()
    const scores = await this.scoreDirected(
      provider,
      agent,
      request,
      [[0, 1]],
      'raise',
      false,
      signal,
    )
    const pair = scores.get(pairKey(0, 1))
    if (pair === undefined) {
      throw new VerifierError('compare provider returned no score for pair 0,1', 'VERIFIER_LLM_FAILED')
    }
    return {
      kind: 'compare',
      rA: pair.rA,
      rB: pair.rB,
      criteria: pair.criteria,
      calls: pair.calls,
      ...pair.usage !== undefined ? { usage: pair.usage } : {},
    }
  }

  private assertBudget(needed: number, field: 'select' | 'compare'): void {
    if (needed <= this.maxCalls) return
    throw new VerifierError(
      `${field} would make ${needed} nested LLM calls, exceeding maxCalls ${this.maxCalls}; reduce candidates, criteria, nEvaluations, or pivots`,
      'VERIFIER_BUDGET_EXCEEDED',
    )
  }

  private resolveProvider(): VerifierProvider {
    if (this.providerId !== undefined) {
      const provider = this.providers.get(this.providerId)
      if (!provider) {
        throw new VerifierError(
          `configured verifier provider "${this.providerId}" is not registered`,
          'VERIFIER_PROVIDER_CONFIGURED_MISSING',
        )
      }
      if (!provider.available()) {
        throw new VerifierError(
          `configured verifier provider "${this.providerId}" is registered but unavailable`,
          'VERIFIER_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new VerifierError('no usable verifier provider is registered', 'VERIFIER_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new VerifierError(
        `multiple usable verifier providers are registered (${ids}); configure one explicitly`,
        'VERIFIER_PROVIDER_AMBIGUOUS',
      )
    }
    return single
  }

  private scoreDirected(
    provider: VerifierProvider,
    agent: VerifierContext,
    request: Pick<VerifierSelectRequest, 'problem' | 'candidates' | 'criteria' | 'groundTruthNote' | 'nEvaluations'>,
    pairs: readonly DirectedPair[],
    onError: 'raise' | 'tie',
    swapOddRepetitions: boolean,
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, PairwiseScore>> {
    if (pairs.length === 0) return Promise.resolve(new Map())
    const payload: VerifierPairsRequest = {
      problem: request.problem,
      candidates: request.candidates,
      pairs,
      criteria: request.criteria,
      groundTruthNote: request.groundTruthNote,
      nEvaluations: request.nEvaluations,
      onError,
      swapOddRepetitions,
    }
    return provider.scorePairs(agent, payload, signal)
  }
}

/** Build a directed score function from a pair-score map; missing entries are 0.5/0.5. */
function scoreLookup(scores: ReadonlyMap<string, PairwiseScore>): (a: number, b: number) => readonly [number, number] {
  return (a, b) => {
    const entry = scores.get(pairKey(a, b))
    return entry === undefined ? [0.5, 0.5] : [entry.rA, entry.rB]
  }
}

/** Sum calls and usage across one or more pair-score maps. */
function tallyScores(
  maps: readonly ReadonlyMap<string, PairwiseScore>[],
): { calls: number; usage?: TokenUsage } {
  let calls = 0
  let usage: TokenUsage | undefined
  for (const map of maps) {
    for (const score of map.values()) {
      calls += score.calls
      usage = addUsage(usage, score.usage)
    }
  }
  return usage === undefined ? { calls } : { calls, usage }
}

export default VerifierRuntime
