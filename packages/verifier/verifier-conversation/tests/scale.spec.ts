import { describe, expect, it } from 'vitest'
import { GRANULARITY, normalizeScaleValue, VALID_TOKENS } from '../src/scale.ts'

describe('scale', () => {
  it('maps A to 1 and T to 0', () => {
    expect(GRANULARITY).toBe(20)
    expect(VALID_TOKENS.A).toBe(20)
    expect(VALID_TOKENS.T).toBe(1)
    expect(VALID_TOKENS.a).toBe(20)
    expect(normalizeScaleValue(20)).toBe(1)
    expect(normalizeScaleValue(1)).toBe(0)
    expect(normalizeScaleValue(10.5)).toBeCloseTo(0.5, 10)
  })
})
