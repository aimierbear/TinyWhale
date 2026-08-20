/**
 * Aggregate optional {@link TokenUsage} records from nested verifier calls.
 * @module @deepseek-ai/dsh-verifier/usage
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * Sum two optional usage records. Omitted optional fields stay omitted when
 * both sides lack them or the summed optional count is zero.
 * @param left - first usage, if any.
 * @param right - second usage, if any.
 * @returns the summed usage, or `undefined` when both sides are missing.
 */
export function addUsage(left?: TokenUsage, right?: TokenUsage): TokenUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  const cacheRead = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0)
  const cacheWrite = (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0)
  const reasoning = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    ...reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}
