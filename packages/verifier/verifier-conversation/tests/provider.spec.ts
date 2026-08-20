import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import VerifierRuntime, { VerifierError } from '@deepseek-ai/dsh-verifier'
import type { VerifierContext } from '@deepseek-ai/dsh-verifier'
import * as conversation from '../src/index.ts'
import { resolveConversationConfig } from '../src/config.ts'
import {
  ProviderCancelled,
  resolveJudgeTarget,
  throwIfCancelled,
  wrapLlmFailure,
} from '../src/provider.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][], private readonly fallback?: () => StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift() ?? this.fallback?.()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) {
      if (options.signal?.aborted) options.signal.throwIfAborted()
      yield chunk
    }
  }
}

function scoreChunks(letterA: string, letterB: string, usage = { inputTokens: 3, outputTokens: 5 }): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text: `<score_A> ${letterA} </score_A>\n<score_B> ${letterB} </score_B>` },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function agentWithHeader(provider = 'mock', model = 'judge'): VerifierContext {
  const session = Session.create(SessionId('verify-1'))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider, model } },
  })
  return { session, options: { provider: 'fallback', model: 'fallback-model' } }
}

async function mount(adapter: ScriptedAdapter, config: conversation.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(VerifierRuntime)
  await ctx.plugin(conversation, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const pairRequest = {
  problem: 'task',
  candidates: [
    { id: 'a', text: 'trace A' },
    { id: 'b', text: 'trace B' },
  ],
  pairs: [[0, 1]] as const,
  criteria: [{ id: 'fit', name: 'Fit', description: 'Did it fit?' }],
  groundTruthNote: 'note',
  nEvaluations: 1,
  onError: 'raise' as const,
  swapOddRepetitions: false,
}

describe('failure helpers', () => {
  it('wraps Error, VerifierError, and non-Error values', () => {
    const existing = new VerifierError('x', 'VERIFIER_LLM_FAILED')
    expect(wrapLlmFailure(existing)).toBe(existing)
    expect(wrapLlmFailure(new Error('boom'))).toMatchObject({ code: 'VERIFIER_LLM_FAILED', message: 'boom' })
    expect(wrapLlmFailure('nope').message).toBe('nope')
  })

  it('rethrows upstream abort, provider cancel, and controller abort', () => {
    const live = new AbortController()
    expect(() => {
      throwIfCancelled(live, undefined)
    }).not.toThrow()
    const upstream = new AbortController()
    upstream.abort(new Error('up'))
    expect(() => {
      throwIfCancelled(new AbortController(), upstream.signal)
    }).toThrow(/up/)
    const cancelled = new AbortController()
    cancelled.abort(new ProviderCancelled(new VerifierError('inner', 'VERIFIER_LLM_FAILED')))
    expect(() => {
      throwIfCancelled(cancelled, undefined)
    }).toThrow(VerifierError)
    const other = new AbortController()
    other.abort(new Error('stop'))
    expect(() => {
      throwIfCancelled(other, undefined)
    }).toThrow(/stop/)
  })
})

describe('resolveConversationConfig', () => {
  it('rejects a partial judge route at load', () => {
    expect(() => resolveConversationConfig({ judgeProvider: 'mock' }))
      .toThrow(expect.objectContaining({ code: 'VERIFIER_TARGET_PARTIAL' }))
    expect(() => resolveConversationConfig({ judgeModel: 'x' }))
      .toThrow(expect.objectContaining({ code: 'VERIFIER_TARGET_PARTIAL' }))
  })

  it('rejects non-positive limits, out-of-range temperature, and a bad onError', () => {
    expect(() => resolveConversationConfig({ maxConcurrency: 0 })).toThrow(VerifierError)
    expect(() => resolveConversationConfig({ maxScoreTokens: -1 })).toThrow(VerifierError)
    expect(() => resolveConversationConfig({ judgeTemperature: Number.NaN })).toThrow(VerifierError)
    expect(() => resolveConversationConfig({ judgeTemperature: -0.1 })).toThrow(VerifierError)
    expect(() => resolveConversationConfig({ judgeTemperature: 2.1 })).toThrow(VerifierError)
    expect(() => resolveConversationConfig({ perCallTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(VerifierError)
    expect(() => resolveConversationConfig({ onError: 'nope' })).toThrow(VerifierError)
  })
})

describe('resolveJudgeTarget', () => {
  it('prefers the configured pair, then the request header, then agent options', () => {
    const configured = resolveConversationConfig({ judgeProvider: 'pinned', judgeModel: 'pin-model' })
    expect(resolveJudgeTarget(configured, agentWithHeader())).toEqual({
      provider: 'pinned',
      model: 'pin-model',
    })
    const inherited = resolveConversationConfig({})
    expect(resolveJudgeTarget(inherited, agentWithHeader('hdr', 'hdr-model'))).toEqual({
      provider: 'hdr',
      model: 'hdr-model',
    })
    const session = Session.create(SessionId('bare'))
    expect(resolveJudgeTarget(inherited, { session, options: { provider: 'opt', model: 'opt-model' } }))
      .toEqual({ provider: 'opt', model: 'opt-model' })
    expect(() => resolveJudgeTarget(inherited, { session, options: {} }))
      .toThrow(expect.objectContaining({ code: 'VERIFIER_NO_TARGET' }))
  })
})

describe('ConversationVerifierProvider', () => {
  it('inherits the request-header route and sets purpose verification', async () => {
    const adapter = new ScriptedAdapter([scoreChunks('A', 'T')])
    const ctx = await mount(adapter)
    const sessionAgent = agentWithHeader()
    const result = await ctx.verifier.compare(sessionAgent, {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: 'note',
      nEvaluations: 1,
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.provider).toBe('mock')
    expect(adapter.requests[0]?.model).toBe('judge')
    expect(adapter.requests[0]?.purpose).toBe('verification')
    expect(adapter.requests[0]?.temperature).toBe(1)
    expect(adapter.requests[0]?.maxTokens).toBeUndefined()
    expect(result.rA).toBe(1)
    expect(result.rB).toBe(0)
    expect(result.calls).toBe(1)
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
    expect(sessionAgent.session.events.some(event => event.type === 'verifier/call')).toBe(true)
  })

  it('appends verifier/call, swaps odd repetitions, and groups by prompt prefix', async () => {
    const adapter = new ScriptedAdapter(
      [scoreChunks('A', 'T'), scoreChunks('T', 'A')],
      () => scoreChunks('A', 'T'),
    )
    const ctx = await mount(adapter)
    const sessionAgent = agentWithHeader()
    const scores = await ctx.verifier.select(sessionAgent, {
      problem: 'task',
      candidates: pairRequest.candidates,
      criteria: pairRequest.criteria,
      groundTruthNote: 'note',
      nEvaluations: 2,
      pivots: 2,
      seed: 0,
    })
    const calls = sessionAgent.session.events.filter(event => event.type === 'verifier/call')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every(event => event.data.ok)).toBe(true)
    const prompts = adapter.requests.map((request) => {
      const block = request.messages[0]?.content[0]
      return block?.type === 'text' ? block.text : ''
    })
    expect(scores.calls).toBeGreaterThanOrEqual(2)
    expect(prompts.some(text => text.includes('**Trajectory A:**\ntrace A'))).toBe(true)
    expect(prompts.some(text => text.includes('**Trajectory A:**\ntrace B'))).toBe(true)
  })

  it('omits maxTokens when maxScoreTokens is 0 and sets it when pinned', async () => {
    const adapter = new ScriptedAdapter([scoreChunks('A', 'A')])
    const ctx = await mount(adapter, { maxScoreTokens: 128 })
    await ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })
    expect(adapter.requests[0]?.maxTokens).toBe(128)
  })

  it('retries a terminal error then raises by default', async () => {
    const adapter = new ScriptedAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } }],
      scoreChunks('A', 'T'),
    ])
    const ctx = await mount(adapter, { maxAttempts: 2 })
    const result = await ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })
    expect(adapter.requests).toHaveLength(2)
    expect(result.rA).toBe(1)
  })

  it('records 0.5/0.5 for select jobs when onError is tie', async () => {
    const adapter = new ScriptedAdapter([
      [{ type: 'finish', reason: { kind: 'max-tokens' } }],
    ])
    const ctx = await mount(adapter, { onError: 'tie', maxAttempts: 1 })
    const result = await ctx.verifier.select(agentWithHeader(), {
      problem: 'task',
      candidates: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 1,
      seed: 0,
    })
    expect(result.calls).toBeGreaterThan(0)
    expect(result.ranking.every(row => row.score === 0.5)).toBe(true)
    expect(result.selectedId).toBe('a')
  })

  it('aborts in-flight jobs on a raise-class failure', async () => {
    const adapter = new ScriptedAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'fail' } } }],
    ])
    const ctx = await mount(adapter, { maxAttempts: 1 })
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_LLM_FAILED' }))
  })

  it('forwards an already-aborted signal', async () => {
    const adapter = new ScriptedAdapter([scoreChunks('A', 'T')])
    const ctx = await mount(adapter)
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    }, controller.signal)).rejects.toThrow()
  })

  it('treats aborted, tool-calls, and unknown finishes as failures', async () => {
    const adapter = new ScriptedAdapter([
      [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'A', message: 'aborted' } } }],
    ])
    const ctx = await mount(adapter, { maxAttempts: 1 })
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(/aborted/)

    const tools = new ScriptedAdapter([
      [{ type: 'finish', reason: { kind: 'tool-calls' } }],
    ])
    const ctxTools = await mount(tools, { maxAttempts: 1 })
    await expect(ctxTools.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(/tool/)

    const unknown = new ScriptedAdapter([
      [{ type: 'finish', reason: { kind: 'other' } as never }],
    ])
    const ctxUnknown = await mount(unknown, { maxAttempts: 1 })
    await expect(ctxUnknown.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(/unsupported finish/)
  })

  it('retries a thrown assembler error then raises', async () => {
    const adapter = new ScriptedAdapter([
      [{ type: 'not-a-chunk' } as unknown as StreamChunk],
    ])
    const ctx = await mount(adapter, { maxAttempts: 1 })
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(VerifierError)
  })

  it('wraps a thrown stream error as VERIFIER_LLM_FAILED', async () => {
    class BoomAdapter extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        throw 'nope'
      }
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(VerifierRuntime)
    await ctx.plugin(conversation, { maxAttempts: 1 })
    ctx.llm.registerAdapter(['mock'], new BoomAdapter())
    const sessionAgent = agentWithHeader()
    await expect(ctx.verifier.compare(sessionAgent, {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(expect.objectContaining({ code: 'VERIFIER_LLM_FAILED' }))
    const failed = sessionAgent.session.events.filter(event => event.type === 'verifier/call')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.data.ok).toBe(false)
  })

  it('maps a per-call deadline to VERIFIER_LLM_FAILED', async () => {
    class HangAdapter extends LlmAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        await new Promise<void>((_resolve, reject) => {
          const signal = options.signal
          if (signal === undefined) return
          const fail = (reason: unknown): void => {
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          }
          if (signal.aborted) {
            fail(signal.reason)
            return
          }
          signal.addEventListener('abort', () => {
            fail(signal.reason)
          })
        })
      }
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(VerifierRuntime)
    await ctx.plugin(conversation, { maxAttempts: 1, perCallTimeoutMs: 20 })
    ctx.llm.registerAdapter(['mock'], new HangAdapter())
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(/timed out/)
  })

  it('rejects a pair outside the candidate list', async () => {
    const adapter = new ScriptedAdapter([])
    const ctx = await mount(adapter)
    const sessionAgent = agentWithHeader()
    const instance = new (await import('../src/provider.ts')).ConversationVerifierProvider(
      ctx,
      resolveConversationConfig({}),
    )
    await expect(instance.scorePairs(sessionAgent, {
      ...pairRequest,
      pairs: [[0, 5]],
    })).rejects.toThrow(/outside the candidate list/)
  })

  it('registers with an explicit raise onError', async () => {
    const adapter = new ScriptedAdapter([scoreChunks('A', 'T')])
    const ctx = await mount(adapter, { onError: 'raise' })
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })).resolves.toMatchObject({ kind: 'compare' })
  })

  it('parses a stop with no score tags as 0.5 letters omitted', async () => {
    const adapter = new ScriptedAdapter([[
      { type: 'text-delta', index: 0, text: 'no tags here' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const ctx = await mount(adapter)
    const result = await ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })
    expect(result.rA).toBe(0.5)
    expect(result.rB).toBe(0.5)
  })

  it('keeps usage on a tie-class failed job', async () => {
    const adapter = new ScriptedAdapter([[
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]])
    const ctx = await mount(adapter, { onError: 'tie' })
    const result = await ctx.verifier.select(agentWithHeader(), {
      problem: 'task',
      candidates: pairRequest.candidates,
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 1,
      seed: 0,
    })
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 2 })
    expect(result.calls).toBeGreaterThan(0)
  })

  it('counts a thrown non-timeout attempt once for tie-class jobs', async () => {
    class BoomAdapter extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        throw new Error('boom')
      }
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(VerifierRuntime)
    await ctx.plugin(conversation, { onError: 'tie', maxAttempts: 1 })
    ctx.llm.registerAdapter(['mock'], new BoomAdapter())
    const sessionAgent = agentWithHeader()
    const result = await ctx.verifier.select(sessionAgent, {
      problem: 'task',
      candidates: pairRequest.candidates,
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
      pivots: 1,
      seed: 0,
    })
    const failed = sessionAgent.session.events.filter(event => event.type === 'verifier/call')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every(event => event.data.ok === false)).toBe(true)
    expect(result.calls).toBe(failed.length)
  })

  it('aggregates empty jobs when nEvaluations is 0', async () => {
    const adapter = new ScriptedAdapter([])
    const ctx = await mount(adapter)
    const instance = new (await import('../src/provider.ts')).ConversationVerifierProvider(
      ctx,
      resolveConversationConfig({}),
    )
    const scores = await instance.scorePairs(agentWithHeader(), {
      ...pairRequest,
      nEvaluations: 0,
    })
    expect(scores.get('0,1')).toMatchObject({ rA: 0, rB: 0, calls: 0 })
  })

  it('records fallback: true when score tags are missing', async () => {
    const adapter = new ScriptedAdapter([[
      { type: 'text-delta', index: 0, text: 'no tags here' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const ctx = await mount(adapter, { maxAttempts: 1 })
    const sessionAgent = agentWithHeader()
    const result = await ctx.verifier.compare(sessionAgent, {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: pairRequest.criteria,
      groundTruthNote: '',
      nEvaluations: 1,
    })
    expect(result.rA).toBe(0.5)
    expect(result.rB).toBe(0.5)
    const call = sessionAgent.session.events.find(event => event.type === 'verifier/call')
    expect(call?.type === 'verifier/call' ? call.data.fallback : undefined).toBe(true)
    expect(call?.type === 'verifier/call' ? call.data.ok : undefined).toBe(true)
  })

  it('cancels in-flight work after a raise-class failure', async () => {
    class SlowErrorAdapter extends LlmAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (this.started === 0) {
          this.started += 1
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'fail-one' } } }
          return
        }
        this.started += 1
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('aborted'))
          }, { once: true })
        })
      }

      started = 0
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(VerifierRuntime)
    await ctx.plugin(conversation, { maxAttempts: 1, maxConcurrency: 2 })
    ctx.llm.registerAdapter(['mock'], new SlowErrorAdapter())
    await expect(ctx.verifier.compare(agentWithHeader(), {
      problem: 'task',
      candidates: [pairRequest.candidates[0]!, pairRequest.candidates[1]!],
      criteria: [
        { id: 'fit', name: 'Fit', description: 'a' },
        { id: 'other', name: 'Other', description: 'b' },
      ],
      groundTruthNote: '',
      nEvaluations: 1,
    })).rejects.toThrow(/fail-one/)
  })

  it('rejects unknown onError at plugin apply', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(VerifierRuntime)
    expect(() => {
      conversation.apply(ctx, { onError: 'maybe' } satisfies conversation.Config)
    }).toThrow(VerifierError)
  })
})
