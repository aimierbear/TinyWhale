import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  atIndex,
  bradleyTerry,
  countSelectComparisons,
  pairKey,
  pivotRoundPairs,
  rankingFromTotals,
  ringCycle,
  selectBest,
  selectPivots,
} from '../src/pivot-tournament.ts'

const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden-select.json'), 'utf8'),
) as {
  n: number
  k: number
  ring: [number, number][]
  scoreMap: Record<string, { rA: number; rB: number }>
  selectedIndex: number
  scores: number[]
  ranking: number[]
  nComparisons: number
  pivots: number[]
  pivotRoundPairs: [number, number][]
}

describe('pair keys', () => {
  it('uses candidate indexes, not ids', () => {
    expect(pairKey(2, 0)).toBe('2,0')
  })

  it('reads a present index and rejects a missing one', () => {
    expect(atIndex(['a'], 0)).toBe('a')
    expect(() => atIndex([], 0)).toThrow(/missing index 0/)
  })
})

describe('ring and pivots', () => {
  it('returns no ring edges for n <= 1', () => {
    expect(ringCycle(0, () => 0)).toEqual([])
    expect(ringCycle(1, () => 0)).toEqual([])
  })

  it('builds n directed edges for a fixed permutation', () => {
    const values = [0.9, 0.1, 0.2]
    const rng = (): number => values.shift() ?? 0
    expect(ringCycle(3, rng)).toHaveLength(3)
  })

  it('counts PPT slots as N + k(N-k) + C(k,2) for n > 1', () => {
    expect(countSelectComparisons(1, 2)).toBe(0)
    expect(countSelectComparisons(2, 2)).toBe(3)
    expect(countSelectComparisons(6, 2)).toBe(15)
  })

  it('selects pivots by mean preference and lower index on ties', () => {
    expect(selectPivots([1, 1, 0], [2, 2, 2], 2)).toEqual([0, 1])
    expect(selectPivots([0, 0, 0], [0, 0, 0], 2)).toEqual([0, 1])
  })

  it('gives non-pivots slot A and sorts pivot-vs-pivot by index', () => {
    expect(pivotRoundPairs(4, [2, 1])).toEqual([
      [0, 2],
      [0, 1],
      [3, 2],
      [3, 1],
      [1, 2],
    ])
  })
})

describe('bradley-terry and ranking', () => {
  it('is 0.5 when rewards are equal', () => {
    expect(bradleyTerry(0.4, 0.4)).toBe(0.5)
  })

  it('picks the higher index when means are equal', () => {
    expect(rankingFromTotals([1, 1], [2, 2])).toMatchObject({
      selectedIndex: 1,
      ranking: [0, 1],
    })
  })

  it('treats a candidate with no comparisons as score 0', () => {
    expect(rankingFromTotals([2, 0], [2, 0]).scores).toEqual([1, 0])
  })
})

describe('golden PPT select', () => {
  it('matches the upstream Python ranking, scores, and comparison count', () => {
    const score = (a: number, b: number): readonly [number, number] => {
      const entry = golden.scoreMap[`${a},${b}`]
      if (entry === undefined) throw new Error(`missing golden score for ${a},${b}`)
      return [entry.rA, entry.rB]
    }
    const result = selectBest(golden.n, golden.ring, golden.k, score)
    expect(result.pivots).toEqual(golden.pivots)
    expect(result.pivotRoundPairs).toEqual(golden.pivotRoundPairs)
    expect(result.selectedIndex).toBe(golden.selectedIndex)
    expect(result.ranking).toEqual(golden.ranking)
    expect(result.nComparisons).toBe(golden.nComparisons)
    expect(result.scores.length).toBe(golden.scores.length)
    for (const [index, value] of result.scores.entries()) {
      expect(value).toBeCloseTo(golden.scores[index]!, 12)
    }
  })
})
