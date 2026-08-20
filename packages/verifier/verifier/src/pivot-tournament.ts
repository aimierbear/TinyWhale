/**
 * Probabilistic Pivot Tournament: O(Nk) best-of-N selection from directed pairwise rewards.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier/pivot-tournament
 */

import { createSeededRng } from './rng.ts'

/** Directed candidate-index pair `(a, b)` with `a` in slot A. */
export type DirectedPair = readonly [number, number]

/**
 * Map a pair to its score-map key. Keys are candidate indexes, never model-supplied ids.
 * @param a - slot-A candidate index.
 * @param b - slot-B candidate index.
 * @returns `"a,b"`.
 */
export function pairKey(a: number, b: number): string {
  return `${a},${b}`
}

/**
 * Read `items[index]`.
 * @param items - source list.
 * @param index - position to read.
 * @returns the item at `index`.
 * @throws {Error} when `index` is out of range.
 */
export function atIndex<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`missing index ${index}`)
  return item
}

/**
 * Adjacent directed pairs of a random Hamiltonian cycle over `n` candidates.
 * @param n - candidate count.
 * @param rng - unit-interval generator used for Fisher-Yates.
 * @returns `n` directed edges when `n > 1`, otherwise an empty list.
 */
export function ringCycle(n: number, rng: () => number): DirectedPair[] {
  if (n <= 1) return []
  const perm = Array.from({ length: n }, (_, index) => index)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const current = atIndex(perm, i)
    perm[i] = atIndex(perm, j)
    perm[j] = current
  }
  return perm.map((value, index) => [value, atIndex(perm, (index + 1) % n)] as const)
}

/**
 * Ring over `n` candidates from a DSH-internal seed.
 * @param n - candidate count.
 * @param seed - integer seed for {@link createSeededRng}.
 * @returns the directed ring pairs.
 */
export function ringCycleFromSeed(n: number, seed: number): DirectedPair[] {
  return ringCycle(n, createSeededRng(seed))
}

/**
 * Bradley-Terry `p(a beats b)` on rewards in `[0, 1]`.
 * @param rA - reward for candidate a.
 * @param rB - reward for candidate b.
 * @returns a probability in `(0, 1)`.
 */
export function bradleyTerry(rA: number, rB: number): number {
  return 1 / (1 + Math.exp(-(rA - rB)))
}

/** Looks up a directed pair's rewards. */
export type DirectedScore = (a: number, b: number) => readonly [number, number]

/**
 * Score each directed pair and add soft wins into `w` and comparison counts into `c`.
 * Duplicate pairs are applied again: that is upstream weighting, not a porting bug.
 * @param pairs - directed pairs to accumulate.
 * @param score - directed reward lookup.
 * @param w - per-candidate soft-win totals, mutated in place.
 * @param c - per-candidate comparison counts, mutated in place.
 */
export function accumulate(
  pairs: readonly DirectedPair[],
  score: DirectedScore,
  w: number[],
  c: number[],
): void {
  for (const [a, b] of pairs) {
    const [rA, rB] = score(a, b)
    const p = bradleyTerry(rA, rB)
    w[a] = atIndex(w, a) + p
    c[a] = atIndex(c, a) + 1
    w[b] = atIndex(w, b) + (1 - p)
    c[b] = atIndex(c, b) + 1
  }
}

/**
 * Top-`k` candidates by mean preference `w_i / c_i`, ties broken by lower index.
 * @param w - soft-win totals.
 * @param c - comparison counts.
 * @param k - requested pivot count; clamped to `n`.
 * @returns pivot indexes in rank order.
 */
export function selectPivots(w: readonly number[], c: readonly number[], k: number): number[] {
  const n = w.length
  const count = Math.min(k, n)
  const order = Array.from({ length: n }, (_, index) => index)
  order.sort((left, right) => {
    const leftCount = atIndex(c, left)
    const rightCount = atIndex(c, right)
    const leftMean = leftCount === 0 ? 0 : atIndex(w, left) / leftCount
    const rightMean = rightCount === 0 ? 0 : atIndex(w, right) / rightCount
    if (rightMean !== leftMean) return rightMean - leftMean
    return left - right
  })
  return order.slice(0, count)
}

/**
 * Pivot-round directed pairs: every non-pivot vs each pivot, then each pivot-vs-pivot
 * with the lower index in slot A. Non-pivots keep slot A. Pivot order in the first
 * family is the order returned by {@link selectPivots}.
 * @param n - candidate count.
 * @param pivots - pivot indexes.
 * @returns directed pairs for the pivot rounds.
 */
export function pivotRoundPairs(n: number, pivots: readonly number[]): DirectedPair[] {
  const pivotSet = new Set(pivots)
  const pairs: DirectedPair[] = []
  for (let i = 0; i < n; i++) {
    if (pivotSet.has(i)) continue
    for (const pivot of pivots) pairs.push([i, pivot])
  }
  const sorted = [...pivots].sort((left, right) => left - right)
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      pairs.push([atIndex(sorted, i), atIndex(sorted, j)])
    }
  }
  return pairs
}

/**
 * Comparison slots PPT will request: ring edges plus pivot-round pairs.
 * The count does not depend on which candidates become pivots.
 * @param n - candidate count; ring is empty when `n <= 1`.
 * @param pivots - requested pivot count before clamping.
 * @returns `n + k(n-k) + C(k,2)` when `n > 1`, otherwise `0`.
 */
export function countSelectComparisons(n: number, pivots: number): number {
  if (n <= 1) return 0
  const k = Math.min(pivots, n)
  return n + k * (n - k) + (k * (k - 1)) / 2
}

/** Ranking produced from accumulated soft wins. */
export interface RankingTotals {
  /** Winning candidate index (lower index wins exact ties, matching upstream). */
  readonly selectedIndex: number
  /** Mean preference `w_i / c_i` per candidate. */
  readonly scores: readonly number[]
  /** Candidate indexes sorted best-first; lower index wins exact ties. */
  readonly ranking: readonly number[]
}

/** Ranking produced by PPT over a known score function. */
export interface PivotTournamentResult extends RankingTotals {
  /** `len(ring) + len(pivotRoundPairs)`, including repeated directed pairs. */
  readonly nComparisons: number
  /** Pivot indexes from the ring pass. */
  readonly pivots: readonly number[]
  /** Directed pairs scored in the pivot rounds. */
  readonly pivotRoundPairs: readonly DirectedPair[]
}

/**
 * Convert accumulated soft wins into mean preferences, selected index, and ranking.
 * @param w - soft-win totals.
 * @param c - comparison counts.
 * @returns selected index, per-candidate means, and best-first ranking.
 */
export function rankingFromTotals(w: readonly number[], c: readonly number[]): RankingTotals {
  const n = w.length
  const scores = w.map((value, index) => {
    const count = atIndex(c, index)
    return count === 0 ? 0 : value / count
  })
  const selectedIndex = scores.reduce((best, value, index) => {
    const bestValue = atIndex(scores, best)
    return value > bestValue ? index : best
  }, 0)
  const ranking = Array.from({ length: n }, (_, index) => index)
  ranking.sort((left, right) => {
    const rightScore = atIndex(scores, right)
    const leftScore = atIndex(scores, left)
    if (rightScore !== leftScore) return rightScore - leftScore
    return left - right
  })
  return { selectedIndex, scores, ranking }
}

/**
 * Run PPT given a pre-sampled ring and a directed score function.
 * @param n - candidate count.
 * @param ring - directed ring pairs.
 * @param k - requested pivot count.
 * @param score - directed reward lookup.
 * @returns selected index, mean preferences, comparison count, and pivot-round pairs.
 */
export function selectBest(
  n: number,
  ring: readonly DirectedPair[],
  k: number,
  score: DirectedScore,
): PivotTournamentResult {
  const w = Array.from({ length: n }, () => 0)
  const c = Array.from({ length: n }, () => 0)
  accumulate(ring, score, w, c)
  const pivots = selectPivots(w, c, k)
  const extra = pivotRoundPairs(n, pivots)
  accumulate(extra, score, w, c)
  return {
    ...rankingFromTotals(w, c),
    nComparisons: ring.length + extra.length,
    pivots,
    pivotRoundPairs: extra,
  }
}
