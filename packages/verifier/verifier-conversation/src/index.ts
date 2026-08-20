/**
 * Conversation-model verifier provider plugin. Registers into `ctx.verifier`
 * and scores directed pairs through `ctx.llm` with conversation-target inheritance.
 * @module @deepseek-ai/dsh-verifier-conversation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveConversationConfig } from './config.ts'
import type { ConversationVerifierConfig } from './config.ts'
import { ConversationVerifierProvider } from './provider.ts'

export const name = 'verifier-conversation'
export const inject = ['verifier', 'llm']

export type { ConversationVerifierConfig, ResolvedConversationConfig } from './config.ts'
export { resolveConversationConfig } from './config.ts'
export {
  ConversationVerifierProvider,
  ProviderCancelled,
  resolveJudgeTarget,
  throwIfCancelled,
  VERIFIER_CALL_TIMEOUT_CODE,
  wrapLlmFailure,
} from './provider.ts'
export { buildPrompt, UNTRUSTED_DATA_SENTENCE } from './prompt.ts'
export { extractScore } from './extract-score.ts'
export type { ExtractedScore } from './extract-score.ts'
export {
  GRANULARITY,
  SCALE_DESCRIPTION,
  SCORE_FORMAT,
  VALID_TOKENS,
  normalizeScaleValue,
} from './scale.ts'

/** Plugin config: optional pinned judge route plus nested-call policy. */
export type Config = ConversationVerifierConfig

export const Config: z<Config> = z.object({
  judgeProvider: z.string().default(''),
  judgeModel: z.string().default(''),
  judgeTemperature: z.number().min(0).max(2).default(1),
  maxScoreTokens: z.number().step(1).min(0).default(0),
  maxConcurrency: z.number().step(1).min(1).default(8),
  perCallTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxAttempts: z.number().step(1).min(1).default(2),
  onError: z.string().default('raise'),
})

/**
 * Validate config and register the conversation provider on `ctx.verifier`.
 * @param ctx - context exposing `verifier` and `llm`.
 * @param config - plugin configuration after schemastery defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConversationConfig(config)
  ctx.verifier.registerProvider(new ConversationVerifierProvider(ctx, resolved))
}
