import { describe, expect, it } from 'vitest'
import {
  dedupCriterionId,
  isBundledCriteriaName,
  loadBundledCriteria,
  normalizeCriteria,
  parseCriteriaMarkdown,
  slugCriterionId,
} from '../src/criteria.ts'
import { VerifierError } from '../src/types.ts'

describe('slug and dedup', () => {
  it('slugs names and falls back to criterion', () => {
    expect(slugCriterionId('Root Cause Analysis')).toBe('root_cause_analysis')
    expect(slugCriterionId('!!!')).toBe('criterion')
    expect(slugCriterionId('a'.repeat(50)).length).toBeLessThanOrEqual(40)
  })

  it('appends _2 when an id is reused', () => {
    const seen = new Set<string>(['spec'])
    expect(dedupCriterionId('spec', seen)).toBe('spec_2')
    expect(dedupCriterionId('spec', seen)).toBe('spec_3')
  })
})

describe('parseCriteriaMarkdown', () => {
  it('ignores unrelated ## headings', () => {
    const parsed = parseCriteriaMarkdown(`## Notes

Ignore.

## Criteria

### Only
Body.
`)
    expect(parsed.groundTruthNote).toBe('')
    expect(parsed.criteria).toEqual([{ id: 'only', name: 'Only', description: 'Body.' }])
  })

  it('reads a pinned id, strips comments, and captures the ground-truth note', () => {
    const parsed = parseCriteriaMarkdown(`# Title

<!-- author note -->

## Ground Truth Note

Do not trust the agent.

## Criteria

### Specification Adherence {#specification}

Check the paths.

### Other
Body.
`)
    expect(parsed.groundTruthNote).toBe('Do not trust the agent.')
    expect(parsed.criteria).toEqual([
      { id: 'specification', name: 'Specification Adherence', description: 'Check the paths.' },
      { id: 'other', name: 'Other', description: 'Body.' },
    ])
  })

  it('rejects a file with no criteria or an empty body', () => {
    expect(() => parseCriteriaMarkdown('# Only a title\n')).toThrow(VerifierError)
    expect(() => parseCriteriaMarkdown('## Criteria\n### Empty\n')).toThrow(/empty instructions/)
  })
})

describe('normalizeCriteria', () => {
  it('derives ids from names or descriptions', () => {
    expect(normalizeCriteria([{ name: 'Fit', description: 'Did it fit?' }])).toEqual([
      { id: 'fit', name: 'Fit', description: 'Did it fit?' },
    ])
    expect(normalizeCriteria([{ id: 'explicit', description: 'Did it fit?' }])).toEqual([
      { id: 'explicit', name: 'explicit', description: 'Did it fit?' },
    ])
    expect(normalizeCriteria([{ description: 'Did it fit?' }])).toEqual([
      { id: 'did_it_fit', name: 'did_it_fit', description: 'Did it fit?' },
    ])
  })

  it('rejects an empty list or empty description', () => {
    expect(() => normalizeCriteria([])).toThrow(VerifierError)
    expect(() => normalizeCriteria([{ name: 'x', description: '  ' }])).toThrow(VerifierError)
  })
})

describe('bundled criteria', () => {
  it('loads the three shipped files with their pinned ids', () => {
    expect(isBundledCriteriaName('terminal_bench')).toBe(true)
    expect(isBundledCriteriaName('nope')).toBe(false)
    expect(loadBundledCriteria('terminal_bench').criteria.map(row => row.id))
      .toEqual(['specification', 'output_match', 'error_signals'])
    expect(loadBundledCriteria('swe_bench').criteria.map(row => row.id))
      .toEqual(['root_cause', 'code_review', 'verification'])
    expect(loadBundledCriteria('medagentbench').criteria.map(row => row.id))
      .toEqual(['query', 'consistency', 'structure'])
    expect(loadBundledCriteria('terminal_bench').groundTruthNote).toContain('TERMINAL OUTPUT')
  })
})
