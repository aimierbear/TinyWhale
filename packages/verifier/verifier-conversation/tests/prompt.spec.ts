import { describe, expect, it } from 'vitest'
import { buildPrompt, UNTRUSTED_DATA_SENTENCE } from '../src/prompt.ts'

const criterion = { id: 'fit', name: 'Fit', description: 'Did the change fit the spec?' }

describe('buildPrompt', () => {
  it('inserts the untrusted-data sentence after the opening line and before the ground-truth note', () => {
    const prompt = buildPrompt('the task', 'trace A', 'trace B', criterion, 'NOTE')
    const openingEnd = prompt.indexOf('stated at the end.')
    const untrustedAt = prompt.indexOf(UNTRUSTED_DATA_SENTENCE)
    const noteAt = prompt.indexOf('NOTE')
    const criterionAt = prompt.indexOf('**Evaluation Guideline — Fit:**')
    expect(openingEnd).toBeGreaterThan(-1)
    expect(untrustedAt).toBeGreaterThan(openingEnd)
    expect(noteAt).toBeGreaterThan(untrustedAt)
    expect(criterionAt).toBeGreaterThan(noteAt)
    expect(prompt).toContain('**Trajectory A:**\ntrace A')
    expect(prompt).toContain('<score_A> LETTER_A_TO_T </score_A>')
    expect(prompt.endsWith('Begin your analysis now.')).toBe(true)
  })
})
