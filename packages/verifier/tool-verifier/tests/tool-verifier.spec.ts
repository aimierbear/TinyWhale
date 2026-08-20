import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Agent } from '@deepseek-ai/dsh-agent'
import VerifierRuntime, { pairKey } from '@deepseek-ai/dsh-verifier'
import type { PairwiseScore, VerifierProvider } from '@deepseek-ai/dsh-verifier'
import * as tool from '../src/index.ts'
import {
  buildVerifyDescription,
  formatVerifyOutput,
  parseVerifyArgs,
  presentVerifyCall,
  presentVerifyResult,
  presentationMetaFromValue,
  toCompareOutput,
  toSelectOutput,
  truncateProblem,
} from '../src/index.ts'

const testToolSignal = new AbortController().signal

function agentWithSession(id = 'owner'): Agent {
  return { id: SessionId(id), session: Session.create(SessionId(id)), options: { provider: 'mock', model: 'judge' } } as unknown as Agent
}

function score(rA: number, rB: number): PairwiseScore {
  return { rA, rB, criteria: [{ criterionId: 'fit', rA, rB }], calls: 1 }
}

async function mount(impl?: VerifierProvider['scorePairs']): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(VerifierRuntime)
  ctx.verifier.registerProvider({
    id: 'conversation',
    onError: 'raise',
    available: () => true,
    scorePairs: impl ?? (async (_agent, request) => {
      const map = new Map<string, PairwiseScore>()
      for (const pair of request.pairs) map.set(pairKey(pair[0], pair[1]), score(0.8, 0.2))
      return map
    }),
  })
  await ctx.plugin(tool, {})
  return ctx
}

let calls = 0
function execute(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`c-${++calls}`),
    name: 'verify',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

const two = [
  { id: 'a', text: 'trace A' },
  { id: 'b', text: 'trace B' },
]

describe('parseVerifyArgs', () => {
  const config = {
    defaultNEvaluations: 2,
    maxNEvaluations: 8,
    defaultPivots: 2,
    maxCandidates: 6,
    maxCandidateChars: 20,
    maxTotalChars: 40,
    timeoutMs: 1000,
  }

  it('defaults to select and bundled terminal_bench', () => {
    const parsed = parseVerifyArgs({ problem: 'p', candidates: two }, config)
    expect(parsed.mode).toBe('select')
    expect(parsed.criteria.map(row => row.id)).toEqual(['specification', 'output_match', 'error_signals'])
    expect(parsed.groundTruthNote).toContain('TERMINAL OUTPUT')
    expect(parsed.nEvaluations).toBe(2)
    expect(parsed.pivots).toBe(2)
  })

  it('derives model-visible cost prose from resolved config', () => {
    expect(tool.DEFAULT_VERIFY_TIMEOUT_MS).toBe(3_600_000)
    expect(buildVerifyDescription({ ...config, timeoutMs: tool.DEFAULT_VERIFY_TIMEOUT_MS }))
      .toContain('up to 60 minutes')
    expect(buildVerifyDescription(config)).toContain('select ranks 2..6 candidates')
    expect(buildVerifyDescription(config)).toContain('Default n_evaluations is 2')
    expect(buildVerifyDescription({ ...config, maxCandidates: 3, defaultNEvaluations: 1, timeoutMs: 60_000 }))
      .toContain('select ranks 2..3 candidates')
    expect(buildVerifyDescription({ ...config, defaultNEvaluations: 1, timeoutMs: 60_000 }))
      .toContain('Default n_evaluations is 1')
    expect(buildVerifyDescription({ ...config, timeoutMs: 60_000 })).toContain('up to 1 minutes')
  })

  it('rejects both criteria forms, 7 candidates, and empty text', () => {
    expect(() => parseVerifyArgs({
      problem: 'p',
      candidates: two,
      criteriaName: 'terminal_bench',
      criteria: [{ name: 'x', description: 'y' }],
    }, config)).toThrow(/not both/)
    expect(() => parseVerifyArgs({
      problem: 'p',
      candidates: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, text: 'x' })),
    }, { ...config, maxCandidateChars: 200, maxTotalChars: 2000 })).toThrow(/2\.\.6/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: [{ id: 'a', text: ' ' }, { id: 'b', text: 'x' }] }, config))
      .toThrow(/empty/)
    expect(() => parseVerifyArgs({
      mode: 'compare',
      problem: 'p',
      candidates: [{ id: 'a', text: 'only' }],
    }, config)).toThrow(/exactly two/)
    expect(() => parseVerifyArgs({ problem: '  ', candidates: two }, config)).toThrow(/problem/)
    expect(() => parseVerifyArgs({ mode: 'other', problem: 'p', candidates: two }, config)).toThrow(/mode/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: two, criteriaName: 'nope' }, config))
      .toThrow(/unknown criteriaName/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: [{ id: ' ', text: 'x' }, { id: 'b', text: 'y' }] }, config))
      .toThrow(/id/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }, config))
      .toThrow(/duplicate/)
    expect(() => parseVerifyArgs({
      problem: 'p',
      candidates: [{ id: 'a', text: 'too-long-for-the-cap!!' }, { id: 'b', text: 'y' }],
    }, config)).toThrow(/maxCandidateChars/)
    expect(() => parseVerifyArgs({
      problem: 'p',
      candidates: [{ id: 'a', text: '12345678901234567890' }, { id: 'b', text: '12345678901234567890' }],
    }, { ...config, maxCandidateChars: 20, maxTotalChars: 30 })).toThrow(/maxTotalChars/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: two, n_evaluations: 9 }, config))
      .toThrow(/n_evaluations/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: two, pivots: 0 }, config)).toThrow(/pivots/)
    expect(() => parseVerifyArgs({ problem: 'p', candidates: two, seed: 1.5 }, config)).toThrow(/seed/)
    expect(parseVerifyArgs({
      problem: 'p',
      candidates: two,
      criteriaName: 'swe_bench',
      ground_truth_note: 'custom',
    }, config).groundTruthNote).toBe('custom')
  })
})

describe('rendering', () => {
  it('covers all-equal select and compare tie summaries', () => {
    const select = toSelectOutput({
      kind: 'select',
      selectedId: 'b',
      ranking: [{ candidateId: 'a', score: 0.5 }, { candidateId: 'b', score: 0.5 }],
      nComparisons: 3,
      criteriaIds: ['fit'],
      calls: 2,
    })
    expect(select.selectedId).toBeNull()
    expect(select.margin).toBe(0)
    expect(formatVerifyOutput(select)).toContain('every candidate score is equal')
    const compare = toCompareOutput({
      kind: 'compare',
      rA: 0.4,
      rB: 0.4,
      criteria: [{ criterionId: 'fit', rA: 0.4, rB: 0.4 }],
      calls: 1,
    })
    expect(compare.winner).toBe('tie')
    expect(formatVerifyOutput(compare)).toContain('Tie')
    expect(presentVerifyResult({}, { content: [], isError: false, meta: presentationMetaFromValue({}, compare) })?.title)
      .toBe('verify compare: tie')
    expect(presentVerifyResult({}, { content: [], isError: false })?.title).toBe('verify')
    expect(presentVerifyResult({}, { content: [], isError: false, meta: presentationMetaFromValue({}, select) })?.title)
      .toBe('verify select: tie')
    expect(presentVerifyResult({}, { content: [], isError: false, meta: { kind: 'compare' } })?.title)
      .toBe('verify compare: tie')
    expect(toSelectOutput({
      kind: 'select',
      selectedId: 'a',
      ranking: [],
      nComparisons: 0,
      criteriaIds: [],
      calls: 0,
    }).margin).toBe(0)
    expect(toSelectOutput({
      kind: 'select',
      selectedId: 'a',
      ranking: [{ candidateId: 'a', score: 1 }],
      nComparisons: 0,
      criteriaIds: [],
      calls: 0,
    }).margin).toBe(0)
    expect(toCompareOutput({
      kind: 'compare',
      rA: 1,
      rB: 0,
      criteria: [],
      calls: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    }).usage).toEqual({ inputTokens: 1, outputTokens: 1 })
    expect(presentVerifyResult({}, { content: [], isError: true }) ).toBeUndefined()
    expect(truncateProblem('x'.repeat(90))).toHaveLength(80)
    const won = toSelectOutput({
      kind: 'select',
      selectedId: 'b',
      ranking: [{ candidateId: 'b', score: 0.8 }, { candidateId: 'a', score: 0.2 }],
      nComparisons: 3,
      criteriaIds: ['fit'],
      calls: 2,
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect(won.selectedId).toBe('b')
    expect(formatVerifyOutput(won)).toContain('Selected b')
    expect(presentVerifyResult({}, { content: [], isError: false, meta: presentationMetaFromValue({}, won) })?.title)
      .toBe('verify select: b')
    expect(toCompareOutput({
      kind: 'compare',
      rA: 0.1,
      rB: 0.9,
      criteria: [{ criterionId: 'fit', rA: 0.1, rB: 0.9 }],
      calls: 1,
    }).winner).toBe('B')
    expect(presentVerifyCall({ problem: 'hello', candidates: two }).title).toBe('verify select: hello')
    expect(presentationMetaFromValue({}, select)).toMatchObject({ kind: 'select', selectedId: null })
    expect(presentationMetaFromValue({}, compare)).toMatchObject({ kind: 'compare', winner: 'tie' })
  })
})

describe('verify tool', () => {
  it('requires an agent and runs compare', async () => {
    const ctx = await mount()
    const missing = await execute(ctx, {
      mode: 'compare',
      problem: 'p',
      candidates: two,
      criteria: [{ name: 'Fit', description: 'Did it fit?' }],
      n_evaluations: 1,
    }, { agent: undefined })
    expect(missing.isError).toBe(true)
    if (!missing.isError) throw new Error('expected error')
    expect(missing.error.info?.code).toBe('VERIFIER_NO_AGENT')

    const result = await execute(ctx, {
      mode: 'compare',
      problem: 'p',
      candidates: two,
      criteria: [{ name: 'Fit', description: 'Did it fit?' }],
      n_evaluations: 1,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ kind: 'compare', winner: 'A', rA: 0.8, rB: 0.2 })
  })

  it('runs select and disposes with the fiber', async () => {
    const ctx = await mount()
    const result = await execute(ctx, {
      mode: 'select',
      problem: 'p',
      candidates: [...two, { id: 'c', text: 'trace C' }],
      criteria: [{ name: 'Fit', description: 'Did it fit?' }],
      n_evaluations: 1,
      pivots: 2,
      seed: 0,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ kind: 'select' })
    const schema = ctx.tools.schemas().find(item => item.name === 'verify')
    expect(schema?.description).toContain('pairwise verifier')
  })

  it('rejects inverted evaluation bounds at apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const ok = {
      defaultNEvaluations: 2,
      maxNEvaluations: 8,
      defaultPivots: 2,
      maxCandidates: 6,
      maxCandidateChars: 20,
      maxTotalChars: 40,
      timeoutMs: 1000,
    }
    expect(() => {
      tool.apply(ctx, { ...ok, defaultNEvaluations: 4, maxNEvaluations: 2 })
    }).toThrow(/defaultNEvaluations/)
    for (const key of ['defaultNEvaluations', 'maxNEvaluations', 'defaultPivots', 'maxCandidates', 'maxCandidateChars', 'maxTotalChars', 'timeoutMs'] as const) {
      expect(() => {
        tool.apply(ctx, { ...ok, [key]: 0 })
      }).toThrow(key)
    }
    expect(() => {
      tool.apply(ctx, { ...ok, maxCandidates: 1 })
    }).toThrow(/maxCandidates/)
    expect(() => {
      tool.apply(ctx, { ...ok, timeoutMs: MAX_TIMER_DELAY_MS + 1 })
    }).toThrow(/timeoutMs/)
  })
})
