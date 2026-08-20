/**
 * Human-facing `/verify` command: run parallel candidate attempts and select
 * the best with the verifier seam, then submit the winner as an ordinary user
 * message. The command is the DSH port of the TurboAgent request pipeline
 * (concurrent candidates -> majority voting / pivot tournament -> best).
 * @module @deepseek-ai/dsh-command-verify
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { VerifierCandidate, VerifierCriterion } from '@deepseek-ai/dsh-verifier'

export const name = 'command-verify'
export const inject = ['commands', 'subagents', 'verifier']

const USAGE = 'Usage: /verify <task description>'

const VERIFY_CRITERIA: readonly VerifierCriterion[] = [{
  id: 'task_success',
  name: 'Task Success',
  description: 'How likely the agent correctly and completely solved the task. '
    + 'The strongest signal is the agent verifying its solution against the '
    + 'task\'s specific requirements. Trajectory length, number of steps, and '
    + 'apparent confidence do not predict correctness.',
}]

const VERIFY_NOTE = 'There is no reference solution available. Judge each trajectory '
  + 'purely on how plausibly it solved the task correctly.'

/** Deployment policy for one `/verify` invocation. */
export interface Config {
  /** Parallel candidate attempts started per invocation. */
  readonly trials?: number
  /** Registered `ctx.subagents` provider name used for each candidate run. */
  readonly provider?: string
  /** Pivot count forwarded to the verifier tournament. */
  readonly pivots?: number
  /** Repeated verifications per directed pair forwarded to the verifier. */
  readonly nVerifications?: number
  /** Ring-pass seed forwarded to the verifier tournament. */
  readonly seed?: number
  /** Skip the tournament when a strict majority of candidates agree verbatim. */
  readonly majorityVoting?: boolean
}

export const Config: z<Config> = z.object({
  trials: z.number().step(1).min(2).max(5).default(3),
  provider: z.string().default('spawn'),
  pivots: z.number().step(1).min(1).default(2),
  nVerifications: z.number().step(1).min(1).max(8).default(1),
  seed: z.number().step(1).min(0).default(0),
  majorityVoting: z.boolean().default(true),
})

type ResolvedConfig = Required<Config>

/** Parse the exact task text after `/verify`. */
function parseTask(rawInput: string): string | undefined {
  const task = rawInput.trim()
  return task.length === 0 ? undefined : task
}

/** Concatenate the text blocks of one candidate output. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

/** Completed candidate text, or undefined when the run failed or produced no output. */
function completedText(result: SubagentResult): string | undefined {
  if (result.stopReason !== 'completed') return undefined
  const text = textOf(result.output)
  return text.length > 0 ? text : undefined
}

/** Find a strict-majority action, or undefined. */
function majorityAction(actions: readonly string[]): { action: string; index: number } | undefined {
  const counts = new Map<string, number>()
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1)
  for (const [action, count] of counts) {
    if (count > actions.length / 2) {
      return { action, index: actions.indexOf(action) }
    }
  }
  return undefined
}

/** Submit the selected winner as an ordinary user message and wake the driver. */
function submitWinner(invocation: CommandInvocation, task: string, winner: VerifierCandidate): void {
  invocation.agent.followup(createUserMessage({
    content: [{
      type: 'text',
      text: `Best verified result for: ${task}\n\n${winner.text}`,
    }],
    source: { kind: 'user' },
  }))
}

/** Append a plugin-sourced chat line without waking the driver. */
function appendChat(invocation: CommandInvocation, text: string): void {
  invocation.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-command-verify' },
  }), { surfaceOp: 'append' })
}

/** Append the invoked command line to the chat surface so the user sees their input immediately. */
function submitStarted(invocation: CommandInvocation, task: string): void {
  appendChat(invocation, `/verify ${task}`)
}

/** Post a verification failure to chat so a failed command never leaves the conversation frozen. */
function submitFailure(invocation: CommandInvocation, task: string, detail: string): void {
  invocation.agent.followup(createUserMessage({
    content: [{
      type: 'text',
      text: `Verification failed for: ${task}\n\n${detail}`,
    }],
    source: { kind: 'user' },
  }))
}

/** Surface a failure in chat and return it as the command result. */
function failVerify(invocation: CommandInvocation, task: string, detail: string): CommandResult {
  submitFailure(invocation, task, detail)
  return { kind: 'error', text: detail }
}

/** Surface invocation cancellation without waking the driver. */
function cancelledVerify(invocation: CommandInvocation, task: string): CommandResult {
  appendChat(invocation, `Verification failed for: ${task}\n\nThe verification was cancelled.`)
  return { kind: 'error', text: 'Verification cancelled.' }
}

/** Read abort after an await; a direct `.aborted` check is narrowed to false. */
function invocationAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Run one `/verify` invocation through candidate generation and selection. */
async function executeVerify(
  ctx: Context,
  config: ResolvedConfig,
  invocation: CommandInvocation,
  task: string,
): Promise<CommandResult> {
  submitStarted(invocation, task)

  const runs: SubagentRun[] = []
  try {
    const startResults = await Promise.allSettled(
      Array.from({ length: config.trials }, (_, index) => ctx.subagents.start(config.provider, {
        label: `verify candidate ${index + 1}`,
        prompt: [{ type: 'text', text: task }],
        parent: invocation.agent,
        signal: invocation.signal,
      })),
    )
    if (invocationAborted(invocation.signal)) return cancelledVerify(invocation, task)
    for (const started of startResults) {
      if (started.status === 'fulfilled') runs.push(started.value)
    }
    if (runs.length === 0) {
      return failVerify(invocation, task, `All ${config.trials} candidate attempts failed to start.`)
    }

    const settled = await Promise.allSettled(runs.map(run => run.result))
    if (invocationAborted(invocation.signal)) return cancelledVerify(invocation, task)
    const results: SubagentResult[] = settled.map((outcome) => {
      if (outcome.status === 'fulfilled') return outcome.value
      return {
        output: [],
        stopReason: 'error',
        diagnostic: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      }
    })
    const candidates: VerifierCandidate[] = []
    for (const [index, result] of results.entries()) {
      const text = completedText(result)
      if (text !== undefined) candidates.push({ id: `trial-${index + 1}`, text })
    }
    if (candidates.length === 0) {
      return failVerify(invocation, task, `All ${config.trials} candidate attempts failed.`)
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- candidates.length > 0
    const first = candidates[0]!
    if (candidates.length === 1) {
      submitWinner(invocation, task, first)
      return { kind: 'success', text: 'Only one candidate attempt settled; submitted its result.' }
    }

    const actions = candidates.map(candidate => candidate.text)
    let winner = first
    let usedMajority = false
    if (config.majorityVoting) {
      const majority = majorityAction(actions)
      if (majority !== undefined) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- majority.index is in-range for the 1:1 mapped candidates
        winner = candidates[majority.index]!
        usedMajority = true
      }
    }
    if (!usedMajority) {
      const selection = await ctx.verifier.select(invocation.agent, {
        problem: task,
        candidates,
        criteria: VERIFY_CRITERIA,
        groundTruthNote: VERIFY_NOTE,
        nEvaluations: config.nVerifications,
        pivots: config.pivots,
        seed: config.seed,
      }, invocation.signal)
      if (invocationAborted(invocation.signal)) return cancelledVerify(invocation, task)
      winner = candidates.find(candidate => candidate.id === selection.selectedId) ?? winner
    }

    submitWinner(invocation, task, winner)
    return {
      kind: 'success',
      text: `Selected best of ${candidates.length} candidate attempts via ${usedMajority ? 'majority voting' : 'verifier tournament'}; submitted the winner to the conversation.`,
    }
  } catch (error: unknown) {
    if (invocationAborted(invocation.signal)) return cancelledVerify(invocation, task)
    return failVerify(invocation, task, error instanceof Error ? error.message : String(error))
  } finally {
    await Promise.allSettled(runs.map(run => run.dispose()))
  }
}

/**
 * Register `/verify` for the human command plane.
 * @param ctx - context carrying commands, subagents, and verifier services.
 * @param config - deployment policy; schemastery fills omitted defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): CommandResult | Promise<CommandResult> => {
    const task = parseTask(invocation.rawInput)
    if (task === undefined) return { kind: 'error', text: USAGE }
    const operation = executeVerify(ctx, resolved, invocation, task)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'verify',
      description: 'Run parallel candidate attempts and select the best verified result',
      input: { hint: '<task description>' },
      background: true,
      handler,
    })
  }, 'command-verify lifecycle')
}
