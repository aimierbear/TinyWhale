/**
 * Conversation-model verifier provider: nested `ctx.llm.stream()` scoring with
 * target inheritance, slot-bias cancellation, prefix warming, and bounded concurrency.
 * @module @deepseek-ai/dsh-verifier-conversation/provider
 */

import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  addUsage,
  pairKey,
  VERIFIER_PROVIDER_CONVERSATION,
  VerifierError,
} from '@deepseek-ai/dsh-verifier'
import type {
  PairwiseScore,
  VerifierContext,
  VerifierCriterion,
  VerifierPairsRequest,
  VerifierProvider,
} from '@deepseek-ai/dsh-verifier'
import { extractScore } from './extract-score.ts'
import { buildPrompt } from './prompt.ts'
import type { ResolvedConversationConfig } from './config.ts'

/** Capability-owned timeout reason code for nested scoring calls. */
export const VERIFIER_CALL_TIMEOUT_CODE = 'VERIFIER_CALL_TIMEOUT'

/** Abort reason used to cancel in-flight jobs after a raise-class failure. */
export class ProviderCancelled extends Error {
  override readonly name = 'ProviderCancelled'
  constructor(readonly causeError: unknown) {
    super('verifier provider cancelled remaining nested calls')
  }
}

/** One scoring job: one criterion, one directed pair, one repetition. */
interface ScoringJob {
  readonly pair: readonly [number, number]
  readonly criterion: VerifierCriterion
  readonly repetition: number
  readonly swap: boolean
  readonly prefix: string
  readonly prompt: string
}

/** Outcome of one nested stream, including retries that actually ran. */
interface JobOutcome {
  readonly pair: readonly [number, number]
  readonly criterionId: string
  readonly rA: number
  readonly rB: number
  readonly calls: number
  readonly usage?: TokenUsage
}

/**
 * Resolve the judge route: configured pair, else `request/header`, else `agent.options`.
 * @param config - resolved provider config.
 * @param agent - session and fallback options.
 * @returns provider and model ids.
 * @throws {@link VerifierError} `VERIFIER_NO_TARGET` when no complete route exists.
 */
export function resolveJudgeTarget(
  config: ResolvedConversationConfig,
  agent: VerifierContext,
): { provider: string; model: string } {
  if (config.judgeProvider.length > 0 && config.judgeModel.length > 0) {
    return { provider: config.judgeProvider, model: config.judgeModel }
  }
  const header = agent.session.requestHeader()?.config
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model }
  }
  if (agent.options.provider !== undefined && agent.options.provider.length > 0
    && agent.options.model !== undefined && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  throw new VerifierError(
    'no conversation provider/model is available for verification; the session needs a request/header or the agent needs options.provider and options.model',
    'VERIFIER_NO_TARGET',
  )
}

/**
 * Conversation-model provider registered as {@link VERIFIER_PROVIDER_CONVERSATION}.
 */
export class ConversationVerifierProvider implements VerifierProvider {
  readonly id = VERIFIER_PROVIDER_CONVERSATION
  readonly onError: 'raise' | 'tie'

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConversationConfig,
  ) {
    this.onError = config.onError
  }

  /** Always usable once the plugin has loaded; routing is checked per call. */
  available(): boolean {
    return true
  }

  /**
   * Score directed pairs through nested LLM calls.
   * @param agent - session and route fallback.
   * @param request - pairs, criteria, repetition, swap, and failure policy.
   * @param signal - tool or select cancellation.
   * @returns pairwise scores keyed by `"a,b"`.
   */
  async scorePairs(
    agent: VerifierContext,
    request: VerifierPairsRequest,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, PairwiseScore>> {
    const route = resolveJudgeTarget(this.config, agent)
    const jobs = buildJobs(request)
    const controller = new AbortController()
    const onUpstreamAbort = (): void => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', onUpstreamAbort)
    if (signal?.aborted) onUpstreamAbort()
    try {
      const warm: ScoringJob[] = []
      const rest: ScoringJob[] = []
      const seen = new Set<string>()
      for (const job of jobs) {
        if (seen.has(job.prefix)) rest.push(job)
        else {
          seen.add(job.prefix)
          warm.push(job)
        }
      }
      const outcomes: JobOutcome[] = []
      const run = (batch: ScoringJob[]): Promise<void> => this.runPhase(
        batch,
        agent,
        request,
        route,
        controller,
        signal,
        outcomes,
      )
      await run(warm)
      await run(rest)
      return aggregateOutcomes(outcomes, request)
    } finally {
      signal?.removeEventListener('abort', onUpstreamAbort)
    }
  }

  private async runPhase(
    jobs: ScoringJob[],
    agent: VerifierContext,
    request: VerifierPairsRequest,
    route: { provider: string; model: string },
    controller: AbortController,
    upstream: AbortSignal | undefined,
    outcomes: JobOutcome[],
  ): Promise<void> {
    if (jobs.length === 0) return
    const concurrency = Math.min(this.config.maxConcurrency, jobs.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (true) {
        throwIfCancelled(controller, upstream)
        const index = next
        next += 1
        const job = jobs[index]
        if (job === undefined) return
        const outcome = await this.runJob(job, agent, request, route, controller, upstream)
        outcomes.push(outcome)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
  }

  private async runJob(
    job: ScoringJob,
    agent: VerifierContext,
    request: VerifierPairsRequest,
    route: { provider: string; model: string },
    controller: AbortController,
    upstream: AbortSignal | undefined,
  ): Promise<JobOutcome> {
    let calls = 0
    let usage: TokenUsage | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      throwIfCancelled(controller, upstream)
      using callDeadline = deadline(controller.signal, this.config.perCallTimeoutMs, VERIFIER_CALL_TIMEOUT_CODE)
      try {
        const streamed = await this.streamOnce(job, agent, route, callDeadline.signal)
        calls += 1
        usage = addUsage(usage, streamed.usage)
        this.recordCall(agent, route, job, streamed)
        if (streamed.ok) {
          const rA = job.swap ? streamed.rB : streamed.rA
          const rB = job.swap ? streamed.rA : streamed.rB
          return {
            pair: job.pair,
            criterionId: job.criterion.id,
            rA,
            rB,
            calls,
            ...usage !== undefined ? { usage } : {},
          }
        }
        lastError = streamed.error
      } catch (error: unknown) {
        throwIfCancelled(controller, upstream)
        calls += 1
        const timedOut = timeoutOf(callDeadline.signal, VERIFIER_CALL_TIMEOUT_CODE) !== undefined
        lastError = timedOut
          ? new VerifierError(
            `verifier nested call timed out after ${this.config.perCallTimeoutMs}ms`,
            'VERIFIER_LLM_FAILED',
            { cause: error },
          )
          : error
        this.recordCall(agent, route, job, {
          ok: false,
          error: lastError,
          blocks: [],
          letters: [],
        })
      }
    }
    if (request.onError === 'raise') {
      const failure = wrapLlmFailure(lastError)
      controller.abort(new ProviderCancelled(failure))
      throw failure
    }
    return {
      pair: job.pair,
      criterionId: job.criterion.id,
      rA: 0.5,
      rB: 0.5,
      calls,
      ...usage !== undefined ? { usage } : {},
    }
  }

  private async streamOnce(
    job: ScoringJob,
    agent: VerifierContext,
    route: { provider: string; model: string },
    signal: AbortSignal,
  ): Promise<StreamedScore> {
    const options: GenerateOptions = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: job.prompt }],
        source: { kind: 'plugin', plugin: 'dsh-verifier-conversation' },
      })],
      temperature: this.config.judgeTemperature,
      sessionId: agent.session.id,
      purpose: 'verification',
      signal,
      ...this.config.maxScoreTokens > 0 ? { maxTokens: this.config.maxScoreTokens } : {},
    })
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const blocks = assembler.blocks()
    const text = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    const terminal = finishFailure(assembler.finish)
    const usage = assembler.usage
    if (terminal !== undefined) {
      return {
        ok: false,
        error: terminal,
        blocks,
        letters: [],
        ...usage !== undefined ? { usage } : {},
      }
    }
    const scoreA = extractScore(text, undefined, undefined, '<score_A>')
    const scoreB = extractScore(text, undefined, undefined, '<score_B>')
    const letters = [
      ...scoreA.token !== undefined ? [scoreA.token] : [],
      ...scoreB.token !== undefined ? [scoreB.token] : [],
    ]
    return {
      ok: true,
      rA: scoreA.value,
      rB: scoreB.value,
      blocks,
      letters,
      ...usage !== undefined ? { usage } : {},
    }
  }

  private recordCall(
    agent: VerifierContext,
    route: { provider: string; model: string },
    job: ScoringJob,
    streamed: StreamedScore,
  ): void {
    const letters = job.swap ? streamed.letters.slice().reverse() : streamed.letters
    agent.session.append('verifier/call', {
      providerId: this.id,
      route,
      pair: job.pair,
      criterionId: job.criterion.id,
      repetition: job.repetition,
      sampledLetters: letters,
      rawOutput: streamed.blocks,
      ok: streamed.ok,
      ...streamed.usage !== undefined ? { usage: streamed.usage } : {},
    })
  }
}

type StreamedScore =
  | {
    readonly ok: true
    readonly rA: number
    readonly rB: number
    readonly blocks: readonly ContentBlock[]
    readonly letters: readonly string[]
    readonly usage?: TokenUsage
  }
  | {
    readonly ok: false
    readonly error: unknown
    readonly blocks: readonly ContentBlock[]
    readonly letters: readonly string[]
    readonly usage?: TokenUsage
  }

/** Translate a terminal finish into a scoring failure, or `undefined` on success. */
function finishFailure(finish: FinishReason): VerifierError | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
      return new VerifierError(finish.failure.message, 'VERIFIER_LLM_FAILED')
    case 'aborted':
      return new VerifierError(finish.failure.message, 'VERIFIER_LLM_FAILED')
    case 'max-tokens':
      return new VerifierError('verifier nested call reached maxTokens', 'VERIFIER_LLM_FAILED')
    case 'tool-calls':
      return new VerifierError('verifier nested call requested a tool', 'VERIFIER_LLM_FAILED')
    default:
      return new VerifierError(
        `verifier nested call ended with unsupported finish "${String((finish as { kind?: unknown }).kind)}"`,
        'VERIFIER_LLM_FAILED',
      )
  }
}

/**
 * Normalize an unknown nested-call failure into {@link VerifierError}.
 * @param error - thrown value from a nested stream or a terminal finish.
 * @returns a `VERIFIER_LLM_FAILED` error, preserving `VerifierError` instances and Error causes.
 */
export function wrapLlmFailure(error: unknown): VerifierError {
  if (error instanceof VerifierError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new VerifierError(message, 'VERIFIER_LLM_FAILED', error instanceof Error ? { cause: error } : undefined)
}

/**
 * Re-throw upstream abort, a raise-class provider cancel, or the controller abort.
 * @param controller - provider-owned cancellation for remaining nested jobs.
 * @param upstream - outer tool or select cancellation signal.
 */
export function throwIfCancelled(controller: AbortController, upstream: AbortSignal | undefined): void {
  if (upstream?.aborted) upstream.throwIfAborted()
  if (!controller.signal.aborted) return
  const reason: unknown = controller.signal.reason
  if (reason instanceof ProviderCancelled) throw wrapLlmFailure(reason.causeError)
  controller.signal.throwIfAborted()
}

function buildJobs(request: VerifierPairsRequest): ScoringJob[] {
  const jobs: ScoringJob[] = []
  for (const [a, b] of request.pairs) {
    const traceA = request.candidates[a]?.text
    const traceB = request.candidates[b]?.text
    if (traceA === undefined || traceB === undefined) {
      throw new VerifierError(`pair ${a},${b} is outside the candidate list`, 'VERIFIER_INVALID_ARGUMENT')
    }
    for (const criterion of request.criteria) {
      for (let repetition = 0; repetition < request.nEvaluations; repetition++) {
        const swap = request.swapOddRepetitions && repetition % 2 === 1
        const slotA = swap ? traceB : traceA
        const slotB = swap ? traceA : traceB
        const sa = swap ? b : a
        const sb = swap ? a : b
        jobs.push({
          pair: [a, b],
          criterion,
          repetition,
          swap,
          prefix: pairKey(sa, sb),
          prompt: buildPrompt(request.problem, slotA, slotB, criterion, request.groundTruthNote),
        })
      }
    }
  }
  return jobs
}

function aggregateOutcomes(
  outcomes: readonly JobOutcome[],
  request: VerifierPairsRequest,
): Map<string, PairwiseScore> {
  const scores = new Map<string, PairwiseScore>()
  for (const pair of request.pairs) {
    const key = pairKey(pair[0], pair[1])
    const jobs = outcomes.filter(outcome => pairKey(outcome.pair[0], outcome.pair[1]) === key)
    const criteria = request.criteria.map((criterion) => {
      const rows = jobs.filter(job => job.criterionId === criterion.id)
      const n = rows.length === 0 ? 1 : rows.length
      return {
        criterionId: criterion.id,
        rA: rows.reduce((sum, row) => sum + row.rA, 0) / n,
        rB: rows.reduce((sum, row) => sum + row.rB, 0) / n,
      }
    })
    const n = jobs.length === 0 ? 1 : jobs.length
    let usage: TokenUsage | undefined
    let calls = 0
    for (const job of jobs) {
      calls += job.calls
      usage = addUsage(usage, job.usage)
    }
    scores.set(key, {
      rA: jobs.reduce((sum, row) => sum + row.rA, 0) / n,
      rB: jobs.reduce((sum, row) => sum + row.rB, 0) / n,
      criteria,
      calls,
      ...usage !== undefined ? { usage } : {},
    })
  }
  return scores
}
