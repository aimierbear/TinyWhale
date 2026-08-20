/**
 * Parse a pairwise score tag, with optional token-level logprobs.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier-conversation/extract-score
 */

import { normalizeScaleValue, VALID_TOKENS } from './scale.ts'

/** One extracted letter score. */
export interface ExtractedScore {
  /** Normalized value in `[0, 1]`; `0.5` when parsing fails. */
  readonly value: number
  /** The matched letter when parsing succeeded. */
  readonly token?: string
  /** True when no valid tag was found and the value is the 0.5 fallback. */
  readonly fallback: boolean
}

/**
 * Locate logprobs at the token after the last occurrence of `tag` (or `tag`
 * without its trailing `>`), so fused `>A` tokens still score.
 * @param tokens - model tokens in order.
 * @param positionLogprobs - per-position top-logprob lists.
 * @param tag - e.g. `"<score_A>"`.
 * @returns the logprob list after the tag, or `undefined`.
 */
function findTagLogprobs(
  tokens: readonly string[] | undefined,
  positionLogprobs: readonly (readonly (readonly [string, number])[])[] | undefined,
  tag: string,
): readonly (readonly [string, number])[] | undefined {
  if (tokens === undefined || tokens.length === 0 || positionLogprobs === undefined) return undefined
  for (const suffix of [tag, tag.slice(0, -1)]) {
    let found: readonly (readonly [string, number])[] | undefined
    let textSoFar = ''
    for (const [index, tok] of tokens.entries()) {
      textSoFar += tok
      if (textSoFar.trimEnd().endsWith(suffix) && index + 1 < positionLogprobs.length) {
        found = positionLogprobs[index + 1]
      }
    }
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Expected score over the verifier's token distribution at `tag`, normalized
 * to `[0, 1]`. Without logprobs, parses the last matching text tag.
 * @param text - assembled model text.
 * @param tokens - optional token strings for the logprob path.
 * @param positionLogprobs - optional per-position logprobs.
 * @param tag - `"<score_A>"` or `"<score_B>"`.
 * @returns the normalized score; `0.5` with `fallback: true` when nothing parses.
 */
export function extractScore(
  text: string,
  tokens: readonly string[] | undefined,
  positionLogprobs: readonly (readonly (readonly [string, number])[])[] | undefined,
  tag: string,
): ExtractedScore {
  const tagLp = findTagLogprobs(tokens, positionLogprobs, tag)
  const probs = new Map<number, number>()
  if (tagLp !== undefined) {
    for (const [tokStr, logprob] of tagLp) {
      let tok = tokStr.trim()
      if (tok.startsWith('>')) tok = tok.slice(1).trim()
      const raw = VALID_TOKENS[tok]
      if (raw === undefined) continue
      const p = Math.exp(logprob)
      const previous = probs.get(raw) ?? 0
      if (p > previous) probs.set(raw, p)
    }
  }
  if (probs.size > 0) {
    let total = 0
    let expected = 0
    for (const [value, p] of probs) {
      total += p
      expected += value * p
    }
    return { value: normalizeScaleValue(expected / total), fallback: false }
  }

  const tagName = tag.replaceAll(/[<>]/g, '')
  const pattern = new RegExp(`<${tagName}>\\s*(.+?)\\s*</${tagName}>`, 'gi')
  const matches = [...(text.matchAll(pattern))]
  const match = matches.at(-1)
  const captured = match?.[1]
  if (captured !== undefined) {
    const tok = captured.trim()
    const raw = VALID_TOKENS[tok] ?? VALID_TOKENS[tok.toLowerCase()]
    if (raw !== undefined) return { value: normalizeScaleValue(raw), token: tok, fallback: false }
  }
  return { value: 0.5, fallback: true }
}
