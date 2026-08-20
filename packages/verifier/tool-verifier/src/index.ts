/**
 * Model-facing `verify` tool over `ctx.verifier`. This package owns schema,
 * defaults, argument validation, rendering, and presentation, never nested LLM calls.
 * @module @deepseek-ai/dsh-tool-verifier
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, JsonValue, ToolResult } from '@deepseek-ai/dsh-tools'
import {
  atIndex,
  isBundledCriteriaName,
  loadBundledCriteria,
  normalizeCriteria,
  VerifierError,
} from '@deepseek-ai/dsh-verifier'
import type {
  BundledCriteriaName,
  VerifierCandidate,
  VerifierCompareResult,
  VerifierContext,
  VerifierCriterion,
  VerifierSelectResult,
} from '@deepseek-ai/dsh-verifier'

export const name = 'tool-verifier'
export const inject = ['tools', 'verifier']

/** Default cooperative tool-call timeout, aligned with 12 × 120s nested-call waves. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 1_440_000

/**
 * Build the model-facing description from resolved config so deployment changes
 * never leave hardcoded candidate counts or timeout prose behind.
 * @param config - resolved defaults and input bounds.
 * @returns one-sentence tool description.
 */
export function buildVerifyDescription(config: ResolvedConfig): string {
  const minutes = Math.ceil(config.timeoutMs / 60_000)
  return [
    'Compare or rank candidate trajectories with a pairwise verifier. Scoring issues auxiliary LLM calls through the same conversation model (purpose verification).',
    'Use mode=compare when you have exactly two candidates. select over two candidates repeats ring edges and costs more.',
    `select ranks 2..${config.maxCandidates} candidates with a probabilistic pivot tournament.`,
    'Call cost: select makes (N + k(N-k) + C(k,2)) × criteria × n_evaluations nested calls, where k = min(pivots, N). compare makes criteria × n_evaluations nested calls.',
    `Default n_evaluations is ${config.defaultNEvaluations}. The call is an exclusive barrier: later same-step tool calls wait, up to ${minutes} minutes.`,
    'Default criteria is the bundled terminal_bench rubric (specification, output match, error signals). Pass explicit criteria for any task that is not a terminal-benchmark trajectory. Do not supply both criteriaName and criteria.',
    'Candidate text stays in the model-visible tool-call record and is resent with conversation history until compaction. Paste only the evidence a judge needs.',
    'This tool does not execute candidates, run tests, or inspect files. It only scores the text you provide.',
  ].join(' ')
}

/** Plugin config for defaults and input bounds. */
export interface Config {
  /** Default repeated verifications per criterion when the model omits `n_evaluations`. */
  readonly defaultNEvaluations?: number
  /** Upper bound for a model-requested `n_evaluations`. */
  readonly maxNEvaluations?: number
  /** Default PPT pivot count when the model omits `pivots`. */
  readonly defaultPivots?: number
  /** Maximum candidate count one `select` call accepts. Must be at least 2. */
  readonly maxCandidates?: number
  /** Per-candidate text character cap. */
  readonly maxCandidateChars?: number
  /** Summed candidate-text character cap across one call. */
  readonly maxTotalChars?: number
  /** Cooperative tool-call timeout; later same-step tool calls wait behind this exclusive barrier. */
  readonly timeoutMs?: number
}

export const Config: z<Config> = z.object({
  defaultNEvaluations: z.number().step(1).min(1).default(2),
  maxNEvaluations: z.number().step(1).min(1).default(8),
  defaultPivots: z.number().step(1).min(1).default(2),
  maxCandidates: z.number().step(1).min(2).default(6),
  maxCandidateChars: z.number().step(1).min(1).default(20_000),
  maxTotalChars: z.number().step(1).min(1).default(60_000),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VERIFY_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

/** Canonical select result the model sees. */
export interface VerifySelectOutput {
  kind: 'select'
  selectedId: string | null
  ranking: { candidateId: string; score: number }[]
  margin: number
  nComparisons: number
  criteriaIds: string[]
  calls: number
  usage?: TokenUsage
}

/** Canonical compare result the model sees. */
export interface VerifyCompareOutput {
  kind: 'compare'
  rA: number
  rB: number
  winner: 'A' | 'B' | 'tie'
  criteria: { criterionId: string; rA: number; rB: number }[]
  calls: number
  usage?: TokenUsage
}

/** Canonical `verify` output: one branch per tool mode. */
export type VerifyOutput = VerifySelectOutput | VerifyCompareOutput

const usageSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    inputTokens: { type: 'integer' as const, required: true as const },
    outputTokens: { type: 'integer' as const, required: true as const },
    cacheReadTokens: { type: 'integer' as const },
    cacheWriteTokens: { type: 'integer' as const },
    reasoningTokens: { type: 'integer' as const },
  },
}

/**
 * Truncate `problem` to 80 characters for the pending-card title.
 * @param problem - full task text.
 * @returns at most 80 characters.
 */
export function truncateProblem(problem: string): string {
  return problem.length <= 80 ? problem : problem.slice(0, 80)
}

/**
 * Render a short prose summary for a verify result. Covers all-equal select and compare ties.
 * @param value - canonical tool output.
 * @returns model-facing and card summary text.
 */
export function formatVerifyOutput(value: VerifyOutput): string {
  if (value.kind === 'select') {
    if (value.selectedId === null) {
      return `No candidate was selected; every candidate score is equal after ${value.nComparisons} comparisons (${value.calls} nested calls).`
    }
    return `Selected ${value.selectedId} with margin ${formatScore(value.margin)} after ${value.nComparisons} comparisons (${value.calls} nested calls).`
  }
  const criterionLines = value.criteria
    .map(row => `${row.criterionId}: A=${formatScore(row.rA)} B=${formatScore(row.rB)}`)
    .join('; ')
  if (value.winner === 'tie') {
    return `Tie (A=${formatScore(value.rA)}, B=${formatScore(value.rB)}) across ${value.calls} nested calls. ${criterionLines}`
  }
  return `Winner ${value.winner} (A=${formatScore(value.rA)}, B=${formatScore(value.rB)}) across ${value.calls} nested calls. ${criterionLines}`
}

/**
 * Pending-call card: mode plus truncated problem; raw input is candidate ids and count.
 * @param args - schema-validated arguments.
 * @returns a generic card view.
 */
export function presentVerifyCall(args: { mode?: string; problem: string; candidates: { id: string }[] }): GenericCallView {
  const mode = args.mode ?? 'select'
  return {
    card: 'generic',
    title: `verify ${mode}: ${truncateProblem(args.problem)}`,
    kind: 'other',
    rawInput: { ids: args.candidates.map(candidate => candidate.id), count: args.candidates.length },
  }
}

/**
 * Completed-call card using the same summary as the model result.
 * @param _args - unused; presentation is a function of the result.
 * @param result - registry result; `value` is the canonical output on success.
 * @returns a generic card, or undefined when the result is an error.
 */
export function presentVerifyResult(_args: unknown, result: ToolResult): GenericResultView | undefined {
  if (result.isError) return undefined
  const meta = result.meta as {
    readonly kind?: string
    readonly selectedId?: string | null
    readonly winner?: string
  } | undefined
  const title = meta?.kind === 'select'
    ? `verify select: ${meta.selectedId ?? 'tie'}`
    : meta?.kind === 'compare'
      ? `verify compare: ${meta.winner ?? 'tie'}`
      : 'verify'
  return {
    card: 'generic',
    title,
    content: result.content,
  }
}

/**
 * Compact replayable card fields. Never includes candidate text.
 * @param _args - unused.
 * @param value - canonical output.
 * @returns JSON-safe presentation metadata.
 */
export function presentationMetaFromValue(_args: unknown, value: VerifyOutput): JsonValue {
  if (value.kind === 'select') {
    return {
      kind: 'select',
      selectedId: value.selectedId,
      ranking: value.ranking.map(row => ({ candidateId: row.candidateId, score: row.score })),
      calls: value.calls,
    }
  }
  return {
    kind: 'compare',
    winner: value.winner,
    calls: value.calls,
  }
}

/**
 * Map a select seam result to the model-facing output, nulling `selectedId` on an all-equal ranking.
 * @param result - PPT result from `ctx.verifier.select`.
 * @returns canonical select output.
 */
export function toSelectOutput(result: VerifierSelectResult): VerifySelectOutput {
  const scores = result.ranking.map(row => row.score)
  const top = scores[0]
  const allEqual = top !== undefined && scores.every(score => score === top)
  const second = scores[1]
  return {
    kind: 'select',
    selectedId: allEqual ? null : result.selectedId,
    ranking: result.ranking.map(row => ({ candidateId: row.candidateId, score: row.score })),
    margin: top === undefined || second === undefined || allEqual ? 0 : top - second,
    nComparisons: result.nComparisons,
    criteriaIds: [...result.criteriaIds],
    calls: result.calls,
    ...result.usage !== undefined ? { usage: result.usage } : {},
  }
}

/**
 * Map a compare seam result to the model-facing output, including the A/B/tie winner.
 * @param result - directed rewards from `ctx.verifier.compare`.
 * @returns canonical compare output.
 */
export function toCompareOutput(result: VerifierCompareResult): VerifyCompareOutput {
  const winner = result.rA > result.rB ? 'A' : result.rB > result.rA ? 'B' : 'tie'
  return {
    kind: 'compare',
    rA: result.rA,
    rB: result.rB,
    winner,
    criteria: result.criteria.map(row => ({
      criterionId: row.criterionId,
      rA: row.rA,
      rB: row.rB,
    })),
    calls: result.calls,
    ...result.usage !== undefined ? { usage: result.usage } : {},
  }
}

/**
 * Register the `verify` tool.
 * @param ctx - context exposing the tool registry and verifier service.
 * @param config - bounds and defaults after schemastery.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('defaultNEvaluations', resolved.defaultNEvaluations)
  assertPositiveInteger('maxNEvaluations', resolved.maxNEvaluations)
  assertPositiveInteger('defaultPivots', resolved.defaultPivots)
  assertAtLeastTwo('maxCandidates', resolved.maxCandidates)
  assertPositiveInteger('maxCandidateChars', resolved.maxCandidateChars)
  assertPositiveInteger('maxTotalChars', resolved.maxTotalChars)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertNotAbove('timeoutMs', resolved.timeoutMs, MAX_TIMER_DELAY_MS)
  if (resolved.defaultNEvaluations > resolved.maxNEvaluations) {
    throw new Error('tool-verifier: defaultNEvaluations must be <= maxNEvaluations')
  }
  ctx.tools.register(defineTool({
    name: 'verify',
    description: buildVerifyDescription(resolved),
    timeoutMs: resolved.timeoutMs,
    parameters: {
      mode: {
        type: 'string',
        enum: ['select', 'compare'],
        description: `select ranks 2..${resolved.maxCandidates} candidates; compare scores exactly two in fixed A/B order. Default select.`,
      },
      problem: {
        type: 'string',
        required: true,
        description: 'Task description shown to the judge.',
      },
      candidates: {
        type: 'array',
        required: true,
        description: `Candidate trajectories. select: 2..${resolved.maxCandidates}; compare: exactly 2.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable candidate id unique in this call.' },
            text: { type: 'string', required: true, description: 'Evidence the judge should score; keep it short.' },
          },
        },
      },
      criteriaName: {
        type: 'string',
        enum: ['terminal_bench', 'swe_bench', 'medagentbench'],
        description: 'Bundled criteria file. Default terminal_bench when criteria is omitted.',
      },
      criteria: {
        type: 'array',
        description: 'Inline criteria. Do not also pass criteriaName.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Criterion display name.' },
            description: { type: 'string', required: true, description: 'Judge instruction for this criterion.' },
          },
        },
      },
      ground_truth_note: {
        type: 'string',
        description: 'Note the judge always sees. Defaults to the bundled file note.',
      },
      n_evaluations: {
        type: 'integer',
        description: `Repeated verifications per criterion. Default ${resolved.defaultNEvaluations}, max ${resolved.maxNEvaluations}.`,
      },
      pivots: {
        type: 'integer',
        description: 'PPT pivot count for select. Default 2; clamped to the candidate count.',
      },
      seed: {
        type: 'integer',
        description: 'DSH-internal ring seed. Default 0.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              kind: { type: 'string' as const, const: 'select' as const, required: true as const },
              selectedId: {
                required: true as const,
                oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const,
              },
              ranking: {
                type: 'array' as const,
                required: true as const,
                items: {
                  type: 'object' as const,
                  additionalProperties: false as const,
                  properties: {
                    candidateId: { type: 'string' as const, required: true as const },
                    score: { type: 'number' as const, required: true as const },
                  },
                },
              },
              margin: { type: 'number' as const, required: true as const },
              nComparisons: { type: 'integer' as const, required: true as const },
              criteriaIds: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
              calls: { type: 'integer' as const, required: true as const },
              usage: usageSchema,
            },
          },
          {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              kind: { type: 'string' as const, const: 'compare' as const, required: true as const },
              rA: { type: 'number' as const, required: true as const },
              rB: { type: 'number' as const, required: true as const },
              winner: { type: 'string' as const, enum: ['A', 'B', 'tie'] as const, required: true as const },
              criteria: {
                type: 'array' as const,
                required: true as const,
                items: {
                  type: 'object' as const,
                  additionalProperties: false as const,
                  properties: {
                    criterionId: { type: 'string' as const, required: true as const },
                    rA: { type: 'number' as const, required: true as const },
                    rB: { type: 'number' as const, required: true as const },
                  },
                },
              },
              calls: { type: 'integer' as const, required: true as const },
              usage: usageSchema,
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: formatVerifyOutput(value) }],
      presentationMeta: (args, value) => presentationMetaFromValue(args, value),
    },
    presentCall: presentVerifyCall,
    presentResult: presentVerifyResult,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new VerifierError('verify requires an owning agent session', 'VERIFIER_NO_AGENT')
      }
      const parsed = parseVerifyArgs(args, resolved)
      const agent = exec.agent as VerifierContext
      if (parsed.mode === 'compare') {
        const result = await ctx.verifier.compare(agent, {
          problem: parsed.problem,
          candidates: [atIndex(parsed.candidates, 0), atIndex(parsed.candidates, 1)],
          criteria: parsed.criteria,
          groundTruthNote: parsed.groundTruthNote,
          nEvaluations: parsed.nEvaluations,
        }, exec.signal)
        return toCompareOutput(result)
      }
      const result = await ctx.verifier.select(agent, {
        problem: parsed.problem,
        candidates: parsed.candidates,
        criteria: parsed.criteria,
        groundTruthNote: parsed.groundTruthNote,
        nEvaluations: parsed.nEvaluations,
        pivots: parsed.pivots,
        seed: parsed.seed,
      }, exec.signal)
      return toSelectOutput(result)
    },
  }))
}

/** Resolved verify arguments after consumer-owned validation. */
export interface ParsedVerifyArgs {
  readonly mode: 'select' | 'compare'
  readonly problem: string
  readonly candidates: readonly VerifierCandidate[]
  readonly criteria: readonly VerifierCriterion[]
  readonly groundTruthNote: string
  readonly nEvaluations: number
  readonly pivots: number
  readonly seed: number
}

/**
 * Validate constraints the schema DSL cannot express and resolve defaults.
 * @param args - schema-validated arguments.
 * @param config - consumer bounds.
 * @returns resolved select/compare inputs.
 */
export function parseVerifyArgs(
  args: {
    mode?: string
    problem: string
    candidates: { id: string; text: string }[]
    criteriaName?: string
    criteria?: { name: string; description: string }[]
    ground_truth_note?: string
    n_evaluations?: number
    pivots?: number
    seed?: number
  },
  config: ResolvedConfig,
): ParsedVerifyArgs {
  const mode = args.mode ?? 'select'
  if (mode !== 'select' && mode !== 'compare') {
    throw new VerifierError('mode must be select or compare', 'VERIFIER_INVALID_ARGUMENT')
  }
  const problem = args.problem.trim()
  if (problem.length === 0) {
    throw new VerifierError('problem must be a non-empty string', 'VERIFIER_INVALID_ARGUMENT')
  }
  if (args.criteriaName !== undefined && args.criteria !== undefined) {
    throw new VerifierError('pass criteriaName or criteria, not both', 'VERIFIER_INVALID_ARGUMENT')
  }
  let criteria: readonly VerifierCriterion[]
  let bundledNote = ''
  if (args.criteria !== undefined) {
    criteria = normalizeCriteria(args.criteria)
  } else {
    const name: BundledCriteriaName = args.criteriaName === undefined
      ? 'terminal_bench'
      : isBundledCriteriaName(args.criteriaName)
        ? args.criteriaName
        : (() => {
          throw new VerifierError(
            `unknown criteriaName "${args.criteriaName}"`,
            'VERIFIER_INVALID_ARGUMENT',
          )
        })()
    const parsed = loadBundledCriteria(name)
    criteria = parsed.criteria
    bundledNote = parsed.groundTruthNote
  }
  const candidates = parseCandidates(args.candidates, mode, config)
  const nEvaluations = args.n_evaluations ?? config.defaultNEvaluations
  if (!Number.isInteger(nEvaluations) || nEvaluations < 1 || nEvaluations > config.maxNEvaluations) {
    throw new VerifierError(
      `n_evaluations must be an integer in 1..${config.maxNEvaluations}`,
      'VERIFIER_INVALID_ARGUMENT',
    )
  }
  const rawPivots = args.pivots ?? config.defaultPivots
  if (!Number.isInteger(rawPivots) || rawPivots < 1) {
    throw new VerifierError('pivots must be a positive integer', 'VERIFIER_INVALID_ARGUMENT')
  }
  const seed = args.seed ?? 0
  if (!Number.isInteger(seed)) {
    throw new VerifierError('seed must be an integer', 'VERIFIER_INVALID_ARGUMENT')
  }
  return {
    mode,
    problem,
    candidates,
    criteria,
    groundTruthNote: args.ground_truth_note ?? bundledNote,
    nEvaluations,
    pivots: Math.min(rawPivots, candidates.length),
    seed,
  }
}

function parseCandidates(
  raw: { id: string; text: string }[],
  mode: 'select' | 'compare',
  config: ResolvedConfig,
): VerifierCandidate[] {
  if (mode === 'compare' && raw.length !== 2) {
    throw new VerifierError('compare requires exactly two candidates', 'VERIFIER_INVALID_ARGUMENT')
  }
  if (mode === 'select' && (raw.length < 2 || raw.length > config.maxCandidates)) {
    throw new VerifierError(
      `select requires 2..${config.maxCandidates} candidates`,
      'VERIFIER_INVALID_ARGUMENT',
    )
  }
  const seen = new Set<string>()
  let total = 0
  const candidates: VerifierCandidate[] = []
  for (const item of raw) {
    const id = item.id.trim()
    const text = item.text
    if (id.length === 0) {
      throw new VerifierError('candidate id must be a non-empty string', 'VERIFIER_INVALID_ARGUMENT')
    }
    if (seen.has(id)) {
      throw new VerifierError(`duplicate candidate id ${JSON.stringify(id)}`, 'VERIFIER_INVALID_ARGUMENT')
    }
    if (text.trim().length === 0) {
      throw new VerifierError(`candidate ${JSON.stringify(id)} text is empty`, 'VERIFIER_INVALID_ARGUMENT')
    }
    if (text.length > config.maxCandidateChars) {
      throw new VerifierError(
        `candidate ${JSON.stringify(id)} exceeds maxCandidateChars ${config.maxCandidateChars}`,
        'VERIFIER_INVALID_ARGUMENT',
      )
    }
    seen.add(id)
    total += text.length
    candidates.push({ id, text })
  }
  if (total > config.maxTotalChars) {
    throw new VerifierError(
      `candidate text totals ${total} characters, exceeding maxTotalChars ${config.maxTotalChars}`,
      'VERIFIER_INVALID_ARGUMENT',
    )
  }
  return candidates
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-verifier: ${name} must be a positive integer`)
  }
}

function assertAtLeastTwo(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`tool-verifier: ${name} must be an integer >= 2`)
  }
}

function assertNotAbove(name: string, value: number, max: number): void {
  if (value > max) {
    throw new Error(`tool-verifier: ${name} must be <= ${max}`)
  }
}
