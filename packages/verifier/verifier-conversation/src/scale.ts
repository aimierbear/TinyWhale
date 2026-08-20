/**
 * A-T twenty-letter score scale and [0, 1] normalization.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier-conversation/scale
 */

/** Number of letters on the scale. */
export const GRANULARITY = 20

/** Letter A (best) through T (worst) mapped to raw 20..1, including lowercase. */
export const VALID_TOKENS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries([
    ...Array.from({ length: GRANULARITY }, (_, index) => [String.fromCharCode(65 + index), GRANULARITY - index] as const),
    ...Array.from({ length: GRANULARITY }, (_, index) => [String.fromCharCode(97 + index), GRANULARITY - index] as const),
  ]),
)

const MIN_VALUE = 1
const MAX_VALUE = GRANULARITY

/** Upstream scale description copied into the pairwise prompt. */
export const SCALE_DESCRIPTION = [
  'Rate how likely the agent correctly solved the task on a ',
  '20-point scale using letters A through T:\n',
  '  A = clearly and completely succeeded with verified output (best)\n',
  '  B-D = succeeded with only minor issues\n',
  '  E-G = above average, mostly correct with some issues\n',
  '  H-J = uncertain, leans toward success\n',
  '  K-M = uncertain, leans toward failure\n',
  '  N-P = below average, significant issues remain\n',
  '  Q-S = failed with some partial progress\n',
  '  T = clearly and completely failed (worst)',
].join('')

/** Placeholder shown in the score-tag format lines. */
export const SCORE_FORMAT = 'LETTER_A_TO_T'

/**
 * Normalize a raw 1..20 scale value to `[0, 1]`.
 * @param raw - letter value from {@link VALID_TOKENS}.
 * @returns 1 for A, 0 for T, or 0.5 if the range is degenerate.
 */
export function normalizeScaleValue(raw: number): number {
  return (raw - MIN_VALUE) / (MAX_VALUE - MIN_VALUE)
}
