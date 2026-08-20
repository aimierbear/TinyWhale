/**
 * Validated conversation-verifier provider configuration.
 * @module @deepseek-ai/dsh-verifier-conversation/config
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { VerifierError } from '@deepseek-ai/dsh-verifier'

/** Deployment policy for nested scoring calls. */
export interface ConversationVerifierConfig {
  /** Explicit judge provider route; empty inherits the conversation route. Must pair with `judgeModel`. */
  readonly judgeProvider?: string
  /** Explicit judge model id; empty inherits the conversation model. Must pair with `judgeProvider`. */
  readonly judgeModel?: string
  /** Sampling temperature for each nested score call. */
  readonly judgeTemperature?: number
  /** Optional output-token cap. Zero omits `maxTokens` and inherits adapter defaults. */
  readonly maxScoreTokens?: number
  /** Bounded parallel nested calls after the prefix-warming wave. */
  readonly maxConcurrency?: number
  /** Per-attempt deadline for one nested scoring stream. */
  readonly perCallTimeoutMs?: number
  /** Maximum attempts per nested job; `2` is one retry after the first failure. */
  readonly maxAttempts?: number
  /** Failure policy: `raise` fails the whole call, `tie` records 0.5/0.5 for select jobs. */
  readonly onError?: string
}

/** Config after defaults and load-time validation. */
export interface ResolvedConversationConfig {
  readonly judgeProvider: string
  readonly judgeModel: string
  readonly judgeTemperature: number
  readonly maxScoreTokens: number
  readonly maxConcurrency: number
  readonly perCallTimeoutMs: number
  readonly maxAttempts: number
  readonly onError: 'raise' | 'tie'
}

const DEFAULTS: ResolvedConversationConfig = {
  judgeProvider: '',
  judgeModel: '',
  judgeTemperature: 1,
  maxScoreTokens: 0,
  maxConcurrency: 8,
  perCallTimeoutMs: 120_000,
  maxAttempts: 2,
  onError: 'raise',
}

/**
 * Apply defaults and reject a partial judge route or non-positive limits.
 * @param config - plugin config after schemastery defaults.
 * @returns immutable resolved policy.
 * @throws {@link VerifierError} `VERIFIER_TARGET_PARTIAL` when only one of
 *   `judgeProvider`/`judgeModel` is set; `VERIFIER_INVALID_ARGUMENT` for bad limits.
 */
export function resolveConversationConfig(config: ConversationVerifierConfig): ResolvedConversationConfig {
  const resolved: ResolvedConversationConfig = {
    judgeProvider: config.judgeProvider ?? DEFAULTS.judgeProvider,
    judgeModel: config.judgeModel ?? DEFAULTS.judgeModel,
    judgeTemperature: config.judgeTemperature ?? DEFAULTS.judgeTemperature,
    maxScoreTokens: config.maxScoreTokens ?? DEFAULTS.maxScoreTokens,
    maxConcurrency: config.maxConcurrency ?? DEFAULTS.maxConcurrency,
    perCallTimeoutMs: config.perCallTimeoutMs ?? DEFAULTS.perCallTimeoutMs,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    onError: parseOnError(config.onError ?? DEFAULTS.onError),
  }
  const hasProvider = resolved.judgeProvider.length > 0
  const hasModel = resolved.judgeModel.length > 0
  if (hasProvider !== hasModel) {
    throw new VerifierError(
      'judgeProvider and judgeModel must be set together',
      'VERIFIER_TARGET_PARTIAL',
    )
  }
  if (!Number.isFinite(resolved.judgeTemperature)
    || resolved.judgeTemperature < 0
    || resolved.judgeTemperature > 2) {
    throw new VerifierError('judgeTemperature must be a finite number in 0..2', 'VERIFIER_INVALID_ARGUMENT')
  }
  assertNonNegativeInteger('maxScoreTokens', resolved.maxScoreTokens)
  assertPositiveInteger('maxConcurrency', resolved.maxConcurrency)
  assertPositiveInteger('perCallTimeoutMs', resolved.perCallTimeoutMs)
  if (resolved.perCallTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new VerifierError(
      `perCallTimeoutMs must be <= ${MAX_TIMER_DELAY_MS}`,
      'VERIFIER_INVALID_ARGUMENT',
    )
  }
  assertPositiveInteger('maxAttempts', resolved.maxAttempts)
  return resolved
}

function parseOnError(value: string): 'raise' | 'tie' {
  if (value === 'raise' || value === 'tie') return value
  throw new VerifierError('onError must be \'raise\' or \'tie\'', 'VERIFIER_INVALID_ARGUMENT')
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new VerifierError(`${name} must be a positive integer`, 'VERIFIER_INVALID_ARGUMENT')
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new VerifierError(`${name} must be a non-negative integer`, 'VERIFIER_INVALID_ARGUMENT')
  }
}
