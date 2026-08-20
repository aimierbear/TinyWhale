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

function hangingProvider(options: { rejectOnAbort?: boolean } = {}): {
  provider: SubagentProvider
  releases: Array<(value: SubagentResult) => void>
  signals: AbortSignal[]
} {
  const releases: Array<(value: SubagentResult) => void> = []
  const signals: AbortSignal[] = []
  const provider: SubagentProvider = {
    name: 'spawn',
    inheritsParentContext: false,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    async start(request: ResolvedSubagentStartRequest) {
      signals.push(request.signal)
      const outcome = await new Promise<SubagentResult>((resolve, reject) => {
        releases.push(resolve)
        if (options.rejectOnAbort === true) {
          request.signal.addEventListener('abort', () => {
            reject(request.signal.reason instanceof Error ? request.signal.reason : new Error('aborted'))
          }, { once: true })
        }
      })
      return {
        id: SessionId(`child-hung-${releases.length}`),
        localAgent: undefined,
        result: Promise.resolve(outcome),
        async dispose() {},
      }
    },
  }
  return { provider, releases, signals }
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

function commandDoneOf(agent: Agent): { kind?: string; text?: string } | undefined {
  const done = agent.session.events.find(event => event.type === 'command/done')
  return done?.type === 'command/done' ? done.data : undefined
}

async function waitForFollowup(agent: ReturnType<typeof fakeAgent>): Promise<unknown> {
  await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalled() })
  return agent.followup.mock.calls[0]?.[0]
}

function userMessageBodies(agent: Agent): string {
  return agent.session.events
    .filter(event => event.type === 'user/message')
    .map(event => JSON.stringify(event.data))
    .join('\n')
}

async function waitForChat(agent: Agent, fragment: string): Promise<void> {
  await vi.waitFor(() => { expect(userMessageBodies(agent)).toContain(fragment) })
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
    expect(execution?.result?.kind).toBe('error')
    expect(execution?.result?.kind === 'error' ? execution.result.text : undefined).toContain('Usage')
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
    expect(execution?.result).toEqual({ kind: 'success' })
    const message = await waitForFollowup(agent)
    expect(JSON.stringify(message)).toContain('same answer')
    expect(commandDoneOf(agent)?.kind).toBe('success')
    expect(commandDoneOf(agent)?.text).toContain('majority voting')
    expect(scorePairs).not.toHaveBeenCalled()
  })

  it('runs the verifier tournament when there is no majority', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifierProvider(),
      { trials: 2, majorityVoting: false },
    )
    const execution = await ctx.commands.execute(agent, '/verify pick the best', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    const message = await waitForFollowup(agent)
    expect(JSON.stringify(message)).toContain('first answer')
    expect(commandDoneOf(agent)?.kind).toBe('success')
    expect(commandDoneOf(agent)?.text).toContain('verifier tournament')
  })

  it('submits the only successful candidate without a tournament', async () => {
    const provider = new StubSubagentProvider('spawn', [result('only answer')])
    provider.failStarts = 1
    const { ctx, agent } = await mount(provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify only one', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('only answer')
    expect(commandDoneOf(agent)?.kind).toBe('success')
    expect(commandDoneOf(agent)?.text).toContain('Only one candidate')
  })

  it('fails when every candidate start is rejected and posts the failure to chat', async () => {
    const provider = new StubSubagentProvider('spawn', [])
    provider.failStarts = 2
    const { ctx, agent } = await mount(provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify cannot start', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('Verification failed')
    expect(commandDoneOf(agent)?.kind).toBe('error')
    expect(commandDoneOf(agent)?.text).toContain('failed to start')
  })

  it('returns execute before candidate attempts settle so the composer can unlock', async () => {
    const hung = hangingProvider()
    const { ctx, agent } = await mount(hung.provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify still running', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(commandDoneOf(agent)).toBeUndefined()
    await vi.waitFor(() => { expect(hung.releases).toHaveLength(2) })
    for (const release of hung.releases) release(result('hung answer'))
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('hung answer')
    expect(commandDoneOf(agent)?.kind).toBe('success')
  })

  it('forwards the invocation signal to candidate starts without wrapping a deadline', async () => {
    const controller = new AbortController()
    const hung = hangingProvider()
    const { ctx, agent } = await mount(hung.provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify pin signal', [], controller.signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(hung.signals).toHaveLength(2) })
    expect(hung.signals[0]).toBe(controller.signal)
    expect(hung.signals[1]).toBe(controller.signal)
    for (const release of hung.releases) release(result('same answer'))
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('same answer')
  })

  it('cancels selection when the invocation signal aborts before candidates start', async () => {
    const controller = new AbortController()
    const hung = hangingProvider({ rejectOnAbort: true })
    const { ctx, agent } = await mount(hung.provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify cancel me', [], controller.signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(hung.signals).toHaveLength(2) })
    controller.abort()
    await waitForChat(agent, 'The verification was cancelled.')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(commandDoneOf(agent)?.kind).toBe('error')
    expect(commandDoneOf(agent)?.text).toBe('Verification cancelled.')
  })

  it('cancels selection when the invocation signal aborts after candidates start', async () => {
    const controller = new AbortController()
    const started: AbortSignal[] = []
    const provider: SubagentProvider = {
      name: 'spawn',
      inheritsParentContext: false,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start(request: ResolvedSubagentStartRequest) {
        started.push(request.signal)
        return {
          id: SessionId(`child-result-${started.length}`),
          localAgent: undefined,
          result: new Promise<SubagentResult>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              reject(request.signal.reason instanceof Error ? request.signal.reason : new Error('aborted'))
            }, { once: true })
          }),
          async dispose() {},
        }
      },
    }
    const { ctx, agent } = await mount(provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify cancel after start', [], controller.signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(started).toHaveLength(2) })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await waitForChat(agent, 'The verification was cancelled.')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(commandDoneOf(agent)?.text).toBe('Verification cancelled.')
  })

  it('cancels after the tournament returns if the invocation aborted during scoring', async () => {
    const controller = new AbortController()
    const verifier = verifierProvider()
    vi.spyOn(verifier, 'scorePairs').mockImplementation(async (_agent, request) => {
      controller.abort()
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
    })
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifier,
      { trials: 2 },
    )
    const execution = await ctx.commands.execute(agent, '/verify abort in judge', [], controller.signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    await waitForChat(agent, 'The verification was cancelled.')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(commandDoneOf(agent)?.text).toBe('Verification cancelled.')
  })

  it('treats a thrown judge error as cancellation when the invocation already aborted', async () => {
    const controller = new AbortController()
    const verifier = verifierProvider()
    vi.spyOn(verifier, 'scorePairs').mockImplementation(async () => {
      controller.abort()
      throw new Error('judge failed after abort')
    })
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifier,
      { trials: 2, majorityVoting: false },
    )
    const execution = await ctx.commands.execute(agent, '/verify abort then throw', [], controller.signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    await waitForChat(agent, 'The verification was cancelled.')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(commandDoneOf(agent)?.text).toBe('Verification cancelled.')
  })

  it('keeps the first candidate when the tournament returns an unknown id', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifierProvider(),
      { trials: 2, majorityVoting: false },
    )
    vi.spyOn(ctx.verifier, 'select').mockResolvedValue({
      kind: 'select',
      selectedId: 'missing',
      ranking: [],
      nComparisons: 0,
      criteriaIds: ['task_success'],
      calls: 0,
    })
    const execution = await ctx.commands.execute(agent, '/verify unknown winner', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('first answer')
  })

  it('posts a judge failure when the tournament throws', async () => {
    const verifier = verifierProvider()
    vi.spyOn(verifier, 'scorePairs').mockRejectedValue(new Error('judge failed'))
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifier,
      { trials: 2, majorityVoting: false },
    )
    const execution = await ctx.commands.execute(agent, '/verify judge boom', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('judge failed')
    expect(commandDoneOf(agent)?.kind).toBe('error')
  })

  it('posts a non-Error tournament failure', async () => {
    const verifier = verifierProvider()
    vi.spyOn(verifier, 'scorePairs').mockRejectedValue('judge exploded')
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifier,
      { trials: 2, majorityVoting: false },
    )
    const execution = await ctx.commands.execute(agent, '/verify judge string', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('judge exploded')
  })

  it('fails when every settled candidate is unsuccessful', async () => {
    let rejects = 0
    const provider: SubagentProvider = {
      name: 'spawn',
      inheritsParentContext: false,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start() {
        rejects += 1
        return {
          id: SessionId(`child-reject-${rejects}`),
          localAgent: undefined,
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers the non-Error diagnostic fallback
          result: rejects === 1 ? Promise.reject(new Error('candidate crashed')) : Promise.reject('raw crash'),
          async dispose() {},
        }
      },
    }
    const { ctx, agent } = await mount(provider, verifierProvider(), { trials: 2, majorityVoting: true })
    const execution = await ctx.commands.execute(agent, '/verify crash', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('All 2 candidate attempts failed')
    expect(commandDoneOf(agent)?.kind).toBe('error')
  })

  it('fails when completed runs have no text and the rest errored', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [
        { output: [], stopReason: 'completed' },
        { output: [], stopReason: 'error', diagnostic: 'boom' },
        { output: [], stopReason: 'error', diagnostic: '   ' },
      ]),
      verifierProvider(),
      { trials: 3 },
    )
    const execution = await ctx.commands.execute(agent, '/verify empty output', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('All 3 candidate attempts failed')
    expect(commandDoneOf(agent)?.kind).toBe('error')
  })

  it('submits the only completed output when the rest failed', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [
        result('only good'),
        { output: [{ type: 'text', text: 'partial' }], stopReason: 'error', diagnostic: 'boom' },
      ]),
      verifierProvider(),
      { trials: 2 },
    )
    const execution = await ctx.commands.execute(agent, '/verify mix', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('only good')
    expect(commandDoneOf(agent)?.text).toContain('Only one candidate')
  })

  it('runs the tournament when majority voting sees no majority', async () => {
    const { ctx, agent } = await mount(
      new StubSubagentProvider('spawn', [result('first answer'), result('second answer')]),
      verifierProvider(),
      { trials: 2, majorityVoting: true },
    )
    const execution = await ctx.commands.execute(agent, '/verify no majority', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('first answer')
    expect(commandDoneOf(agent)?.text).toContain('verifier tournament')
  })

  it('waits for an in-flight verify when the plugin disposes', async () => {
    const hung = hangingProvider()
    const { ctx, agent } = await mount(hung.provider, verifierProvider(), { trials: 2 })
    const execution = await ctx.commands.execute(agent, '/verify disposing', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(hung.releases).toHaveLength(2) })
    const disposing = ctx.fiber.dispose()
    for (const release of hung.releases) release(result('same answer'))
    await disposing
    expect(JSON.stringify(await waitForFollowup(agent))).toContain('same answer')
  })
})
