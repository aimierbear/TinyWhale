import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import VerifierRuntime, { pairKey, VerifierError } from '@deepseek-ai/dsh-verifier'
import type { PairwiseScore, VerifierContext, VerifierPairsRequest, VerifierProvider } from '@deepseek-ai/dsh-verifier'

const criterion = { id: 'fit', name: 'Fit', description: 'Did it fit?' }
const candidates = [
  { id: 'a', text: 'trace A' },
  { id: 'b', text: 'trace B' },
  { id: 'c', text: 'trace C' },
]

function agent(): VerifierContext {
  return { session: Session.create(SessionId('v1')), options: {} }
}

function score(rA: number, rB: number, calls = 1): PairwiseScore {
  return { rA, rB, criteria: [{ criterionId: 'fit', rA, rB }], calls }
}

function provider(
  id: string,
  available: boolean,
  impl?: (request: VerifierPairsRequest) => Promise<ReadonlyMap<string, PairwiseScore>>,
  onError: 'raise' | 'tie' = 'raise',
): VerifierProvider {
  return {
    id,
    onError,
    available: () => available,
    scorePairs: (_agent, request) => impl === undefined
      ? Promise.resolve(new Map())
      : impl(request),
  }
}

async function mount(config: ConstructorParameters<typeof VerifierRuntime>[1] = {}): Promise<{
  ctx: Context
  verifier: VerifierRuntime
}> {
  const ctx = new Context()
  await ctx.plugin(VerifierRuntime, config)
  return { ctx, verifier: ctx.verifier }
}

describe('VerifierRuntime registration', () => {
  it('registers a provider and unregisters it via the disposer', async () => {
    const { verifier } = await mount()
    const dispose = verifier.registerProvider(provider('conversation', true, async (request) => {
      const map = new Map<string, PairwiseScore>()
      for (const pair of request.pairs) map.set(pairKey(pair[0], pair[1]), score(0.8, 0.2))
      return map
    }))
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).resolves.toMatchObject({ kind: 'compare', rA: 0.8, rB: 0.2 })
    dispose()
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws VERIFIER_DUPLICATE_PROVIDER on a repeated id', async () => {
    const { verifier } = await mount()
    verifier.registerProvider(provider('conversation', true))
    expect(() => verifier.registerProvider(provider('conversation', true)))
      .toThrow(expect.objectContaining({ code: 'VERIFIER_DUPLICATE_PROVIDER' }))
  })

  it('disposes provider registrations when the contributing fiber is disposed', async () => {
    const { ctx, verifier } = await mount()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.verifier.registerProvider(provider('conversation', true, async (request) => {
        const map = new Map<string, PairwiseScore>()
        for (const pair of request.pairs) map.set(pairKey(pair[0], pair[1]), score(1, 0))
        return map
      }))
    }, { inject: ['verifier'] }))
    await fiber.dispose()
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(VerifierError)
  })
})

describe('VerifierRuntime selection', () => {
  it('throws configured-missing, configured-unavailable, unavailable, and ambiguous', async () => {
    const missing = await mount({ provider: 'missing' })
    missing.verifier.registerProvider(provider('conversation', true))
    await expect(missing.verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_PROVIDER_CONFIGURED_MISSING' }))

    const unusable = await mount({ provider: 'conversation' })
    unusable.verifier.registerProvider(provider('conversation', false))
    await expect(unusable.verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_PROVIDER_CONFIGURED_UNAVAILABLE' }))

    const empty = await mount()
    await expect(empty.verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_PROVIDER_UNAVAILABLE' }))

    const many = await mount()
    many.verifier.registerProvider(provider('one', true, async () => new Map([['0,1', score(1, 0)]])))
    many.verifier.registerProvider(provider('two', true, async () => new Map([['0,1', score(1, 0)]])))
    await expect(many.verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_PROVIDER_AMBIGUOUS' }))
  })

  it('fails the budget before the first provider call', async () => {
    const { verifier } = await mount({ maxCalls: 1 })
    let called = 0
    verifier.registerProvider(provider('conversation', true, async () => {
      called += 1
      return new Map()
    }))
    await expect(verifier.select(agent(), {
      problem: 'p',
      candidates,
      criteria: [criterion, { id: 'other', name: 'Other', description: 'x' }],
      groundTruthNote: '',
      nEvaluations: 2,
      pivots: 2,
      seed: 0,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_BUDGET_EXCEEDED' }))
    expect(called).toBe(0)
  })

  it('rejects select with fewer than two candidates or empty criteria', async () => {
    const { verifier } = await mount()
    verifier.registerProvider(provider('conversation', true))
    await expect(verifier.select(agent(), {
      problem: 'p',
      candidates: [candidates[0]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 1,
      seed: 0,
    })).rejects.toThrow(/at least two/)
    await expect(verifier.select(agent(), {
      problem: 'p',
      candidates,
      criteria: [],
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 2,
      seed: 0,
    })).rejects.toThrow(/at least one criterion/)
    await expect(verifier.select(agent(), {
      problem: 'p',
      candidates,
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 0,
      pivots: 2,
      seed: 0,
    })).rejects.toThrow(/nEvaluations/)
  })
})

describe('select and compare orchestration', () => {
  it('asks compare for pair 0,1 without slot swap and with onError raise', async () => {
    const { verifier } = await mount()
    let seen: VerifierPairsRequest | undefined
    verifier.registerProvider(provider('conversation', true, async (request) => {
      seen = request
      return new Map([['0,1', score(0.7, 0.3, 2)]])
    }))
    const result = await verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: 'note',
      nEvaluations: 2,
    })
    expect(seen?.pairs).toEqual([[0, 1]])
    expect(seen?.onError).toBe('raise')
    expect(seen?.swapOddRepetitions).toBe(false)
    expect(result).toMatchObject({ kind: 'compare', rA: 0.7, rB: 0.3, calls: 2 })
  })

  it('swaps odd repetitions for select pair jobs and records scores in candidate order', async () => {
    const { verifier } = await mount()
    const requests: VerifierPairsRequest[] = []
    verifier.registerProvider(provider('conversation', true, async (request) => {
      requests.push(request)
      const map = new Map<string, PairwiseScore>()
      for (const pair of request.pairs) {
        const [a, b] = pair
        map.set(pairKey(a, b), score(0.2 + a * 0.2, 0.2 + b * 0.2))
      }
      return map
    }, 'tie'))
    const result = await verifier.select(agent(), {
      problem: 'p',
      candidates,
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 2,
      pivots: 2,
      seed: 0,
    })
    expect(requests.length).toBeGreaterThanOrEqual(1)
    expect(requests.every(request => request.swapOddRepetitions)).toBe(true)
    expect(requests.every(request => request.onError === 'tie')).toBe(true)
    expect(result.kind).toBe('select')
    expect(result.ranking).toHaveLength(3)
    expect(result.criteriaIds).toEqual(['fit'])
  })

  it('rejects compare with empty criteria or nEvaluations < 1', async () => {
    const { verifier } = await mount()
    verifier.registerProvider(provider('conversation', true))
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(/at least one criterion/)
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 0,
    })).rejects.toThrow(/nEvaluations/)
  })

  it('runs a configured available provider', async () => {
    const { verifier } = await mount({ provider: 'conversation' })
    verifier.registerProvider(provider('conversation', true, async () => new Map([['0,1', score(1, 0)]])))
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).resolves.toMatchObject({ rA: 1 })
  })

  it('uses 0.5 when a requested pair is missing from the provider map', async () => {
    const { verifier } = await mount()
    verifier.registerProvider(provider('conversation', true, async () => new Map()))
    const result = await verifier.select(agent(), {
      problem: 'p',
      candidates,
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 0,
      seed: 0,
    })
    expect(result.ranking.every(row => row.score === 0.5 || row.score === 0)).toBe(true)
  })

  it('defaults maxCalls when constructed without plugin config', () => {
    const ctx = new Context()
    expect(() => new VerifierRuntime(ctx)).not.toThrow()
  })

  it('treats an empty provider pin as auto-select', async () => {
    const { verifier } = await mount({ provider: '' })
    verifier.registerProvider(provider('conversation', true, async () => new Map([['0,1', score(1, 0)]])))
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).resolves.toMatchObject({ rA: 1 })
  })

  it('scores an empty pivot-round list when pivots is 0', async () => {
    const { verifier } = await mount()
    verifier.registerProvider(provider('conversation', true, async (request) => {
      const map = new Map<string, PairwiseScore>()
      for (const pair of request.pairs) map.set(pairKey(pair[0], pair[1]), score(0.9, 0.1, 1))
      return map
    }))
    const result = await verifier.select(agent(), {
      problem: 'p',
      candidates,
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 0,
      seed: 0,
    })
    expect(result.nComparisons).toBe(3)
  })

  it('throws when compare receives no score for 0,1', async () => {
    const { verifier } = await mount()
    verifier.registerProvider(provider('conversation', true, async () => new Map()))
    await expect(verifier.compare(agent(), {
      problem: 'p',
      candidates: [candidates[0]!, candidates[1]!],
      criteria: [criterion],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_LLM_FAILED' }))
  })
})
