import { describe, expect, it } from 'vitest'
import { addUsage } from '../src/usage.ts'

describe('addUsage', () => {
  it('returns the defined side when the other is missing', () => {
    const usage = { inputTokens: 1, outputTokens: 2 }
    expect(addUsage(undefined, usage)).toEqual(usage)
    expect(addUsage(usage, undefined)).toEqual(usage)
    expect(addUsage(undefined, undefined)).toBeUndefined()
  })

  it('sums required fields and optional cache counts', () => {
    expect(addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, reasoningTokens: 1 },
      { inputTokens: 4, outputTokens: 5, cacheWriteTokens: 6 },
    )).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 6,
      reasoningTokens: 1,
    })
  })
})
