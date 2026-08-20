import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import VerifierRuntime from '@deepseek-ai/dsh-verifier'
import type { PairwiseScore, VerifierProvider } from '@deepseek-ai/dsh-verifier'
import * as commandVerify from '../src/index.ts'

class StubSubagentProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  startCount = 0
  failStarts = 0

  constructor(
    readonly name: string,
    private readonly outcomes: readonly SubagentResult[],
  ) {}

  async start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.startCount += 1
    if (this.failStarts > 0) {
      this.failStarts -= 1
      throw new Error('synthetic start failure')
    }
    const outcome = this.outcomes[(this.startCount - 1) % this.outcomes.length]
    return {
      id: SessionId(`child-${this.startCount}`),
      localAgent: undefined,
      result: Promise.resolve(outcome ?? { output: [], stopReason: 'error', diagnostic: 'missing outcome' }),
      async dispose() {},
    }
  }
}

function result(text: string): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function fakeAgent(): Agent & { followup: ReturnType<typeof vi.fn> } {
  const session = Session.create(SessionId('owner'))
  return {
    id: SessionId('owner'),
    session,
    options: { provider: 'mock', model: 'judge' },
    followup: vi.fn(),
  } as unknown as Agent & { followup: ReturnType<typeof vi.fn> }
}

function verifierProvider(): VerifierProvider {
  return {
    id: 'conversation',
    onError: 'raise',
    available: () => true,
    async scorePairs(_agent, request) {
      const map = new Map<string, PairwiseScore>()
      for (const [a, b] of request.pairs) {
        map.set(`${a},${b}`, {
          rA: a === 0 ? 0.9 : 0.1,
          rB: b === 0 ? 0.9 : 0.1,
          criteria: [{ criterionId: 'task_success', rA: a === 0 ? 0.9 : 0.1, rB: b === 0 ? 0.9 : 0.1 }],
          calls: 1,
        })
      }
      return map
    },
  }
}

async function mount(
  provider: SubagentProvider,
  verifier: VerifierProvider,
  config: Partial<commandVerify.Config> = {},
): Promise<{ ctx: Context; agent: ReturnType<typeof fakeAgent> }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(VerifierRuntime)
  ctx.subagents.registerProvider(provider)
  ctx.verifier.registerProvider(verifier)
  await ctx.plugin(commandVerify, config)
  return { ctx, agent: fakeAgent() }
}

describe('command-verify', () => {
  it('rejects an empty task', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('a')]),
      verifierProvider(),
    )
    const execution = await ctx.commands.execute(agent, '/verify   ', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage') })
  })

  it('uses majority voting and skips the verifier', async () => {
    const verifier = verifierProvider()
    const scorePairs = vi.spyOn(verifier, 'scorePairs')
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('same answer'), result('same answer'), result('different')]),
      verifier,
      { trials: 3, majorityVoting: true },
    )
    const execution = await ctx.commands.execute(agent, '/verify do the thing', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('majority voting') })
    expect(agent.followup).toHaveBeenCalledOnce()
    const message = agent.followup.mock.calls[0]?.[0]
    expect(JSON.stringify(message)).toContain('same answer')
    expect(scorePairs).not.toHaveBeenCalled()
  })

  it('runs the verifier tournament when there is no majority', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifierProvider(),
      { trials: 2, majorityVoting: false },
    )
    const execution = await ctx.commands.execute(agent, '/verify pick the best', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('verifier tournament') })
    expect(agent.followup).toHaveBeenCalledOnce()
    const message = agent.followup.mock.calls[0]?.[0]
    expect(JSON.stringify(message)).toContain('first answer')
  })

  it('submits the only successful candidate without a tournament', async () => {
    const provider = new StubSubagentProvider('spawn', [result('only answer')])
    provider.failStarts = 1
    const { ctx, agent } = await mount(provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify only one', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('Only one candidate') })
    expect(JSON.stringify(agent.followup.mock.calls[0]?.[0])).toContain('only answer')
  })

  it('fails when every candidate start is rejected and posts the failure to chat', async () => {
    const provider = new StubSubagentProvider('spawn', [])
    provider.failStarts = 2
    const { ctx, agent } = await mount(provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify cannot start', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('failed to start') })
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(JSON.stringify(agent.followup.mock.calls[0]?.[0])).toContain('Verification failed')
  })
})
