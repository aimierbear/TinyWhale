import { describe, expect, it } from 'vitest'
import { extractScore } from '../src/extract-score.ts'

describe('extractScore text fallback', () => {
  it('uses the last tag and accepts mixed case', () => {
    const text = '<score_A> T </score_A>\n<score_A> B </score_A>'
    expect(extractScore(text, undefined, undefined, '<score_A>')).toMatchObject({
      value: extractScore('<score_A> B </score_A>', undefined, undefined, '<score_A>').value,
      fallback: false,
      token: 'B',
    })
    expect(extractScore('<score_B> t </score_B>', undefined, undefined, '<score_B>').fallback).toBe(false)
  })

  it('ignores empty token lists and unmatched suffixes', () => {
    expect(extractScore('x', [], [[]], '<score_A>')).toEqual({ value: 0.5, fallback: true })
    expect(extractScore('x', ['nope'], [[]], '<score_A>')).toEqual({ value: 0.5, fallback: true })
  })

  it('returns 0.5 when no tag or token is valid', () => {
    expect(extractScore('no tags', undefined, undefined, '<score_A>')).toEqual({ value: 0.5, fallback: true })
    expect(extractScore('<score_A> Z </score_A>', undefined, undefined, '<score_A>'))
      .toEqual({ value: 0.5, fallback: true })
  })
})

describe('extractScore logprobs', () => {
  it('reads the last tag and fused >A tokens', () => {
    const tokens = ['<score_A>', 'A']
    const positionLogprobs = [
      [],
      [['A', Math.log(0.8)] as const, ['B', Math.log(0.2)] as const],
    ]
    const result = extractScore('ignored', tokens, positionLogprobs, '<score_A>')
    expect(result.fallback).toBe(false)
    expect(result.value).toBeGreaterThan(0.9)

    const fused = extractScore('ignored', ['<score_A'], [
      [],
      [['>A', Math.log(1)] as const],
    ], '<score_A>')
    expect(fused.fallback).toBe(false)
    expect(fused.value).toBe(1)
  })

  it('keeps the higher probability when the same letter appears twice', () => {
    const result = extractScore('ignored', ['<score_A>', 'A'], [
      [],
      [['A', Math.log(0.2)] as const, ['A', Math.log(0.9)] as const, ['Z', Math.log(0.1)] as const],
    ], '<score_A>')
    expect(result.fallback).toBe(false)
    expect(result.value).toBe(1)
  })
})
