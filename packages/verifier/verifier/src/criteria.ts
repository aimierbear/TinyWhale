/**
 * Parse bundled or inline verifier criteria into `{ id, name, description }`.
 * Portions derived from llm-as-a-verifier (MIT, https://github.com/llm-as-a-verifier/llm-as-a-verifier)
 * @module @deepseek-ai/dsh-verifier/criteria
 */

import { MEDAGENTBENCH_CRITERIA_MARKDOWN } from './bundled/medagentbench.ts'
import { SWE_BENCH_CRITERIA_MARKDOWN } from './bundled/swe-bench.ts'
import { TERMINAL_BENCH_CRITERIA_MARKDOWN } from './bundled/terminal-bench.ts'
import { VerifierError } from './types.ts'
import type { BundledCriteriaName, VerifierCriterion } from './types.ts'
import { BUNDLED_CRITERIA_NAMES } from './types.ts'

const CRIT_ID = /^(.*?)\s*\{#([A-Za-z0-9_-]+)\}\s*$/
const HTML_COMMENT = /<!--.*?-->/gs

const BUNDLED_MARKDOWN: Record<BundledCriteriaName, string> = {
  terminal_bench: TERMINAL_BENCH_CRITERIA_MARKDOWN,
  swe_bench: SWE_BENCH_CRITERIA_MARKDOWN,
  medagentbench: MEDAGENTBENCH_CRITERIA_MARKDOWN,
}

/** Parsed criteria file: the ground-truth note plus criteria in file order. */
export interface ParsedCriteria {
  readonly groundTruthNote: string
  readonly criteria: readonly VerifierCriterion[]
}

/** Inline criterion before id/name derivation. */
export interface InlineCriterionInput {
  readonly id?: string
  readonly name?: string
  readonly description: string
}

/**
 * Derive a criterion id from free text: lowercase, alnum plus underscores, at most 40 characters.
 * @param text - display name or description.
 * @returns a non-empty slug, or `"criterion"` when nothing remains.
 */
export function slugCriterionId(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const trimmed = slug.slice(0, 40).replace(/_+$/g, '')
  return trimmed.length > 0 ? trimmed : 'criterion'
}

/**
 * Make `id` unique against `seen` by appending `_2`, `_3`, …
 * @param id - requested id.
 * @param seen - ids already used; mutated to include the returned id.
 * @returns a unique id.
 */
export function dedupCriterionId(id: string, seen: Set<string>): string {
  let out = id
  let n = 1
  while (seen.has(out)) {
    n += 1
    out = `${id}_${n}`
  }
  seen.add(out)
  return out
}

/**
 * Parse a criteria markdown file into a ground-truth note and criteria.
 * HTML comments are stripped. `### Name {#id}` pins the id; otherwise the id is slugged from the name.
 * @param markdown - file contents.
 * @param source - label used in error messages.
 * @returns the note (possibly empty) and at least one criterion.
 * @throws {@link VerifierError} `VERIFIER_INVALID_ARGUMENT` when no criteria or a criterion body is empty.
 */
export function parseCriteriaMarkdown(markdown: string, source = 'criteria'): ParsedCriteria {
  const text = markdown.replace(HTML_COMMENT, '')
  const lines = text.split(/\r?\n/)
  let groundTruthNote = ''
  const criteria: VerifierCriterion[] = []
  const seen = new Set<string>()
  let section: 'ground_truth' | 'criteria' | undefined
  let current: { id: string; name: string } | undefined
  let buf: string[] = []

  const flush = (): void => {
    const body = buf.join('\n').trim()
    buf = []
    if (section === 'ground_truth' && groundTruthNote.length === 0) {
      groundTruthNote = body
      return
    }
    if (current !== undefined) {
      criteria.push({ id: current.id, name: current.name, description: body })
      current = undefined
    }
  }

  for (const line of lines) {
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      flush()
      const heading = line.slice(3).trim().toLowerCase()
      if (heading.includes('ground truth')) section = 'ground_truth'
      else if (heading.includes('criteri')) section = 'criteria'
      else section = undefined
    } else if (line.startsWith('### ') && section === 'criteria') {
      flush()
      const heading = line.slice(4).trim()
      const pinned = CRIT_ID.exec(heading)
      const pinnedName = pinned?.[1]
      const pinnedId = pinned?.[2]
      const name = pinnedName === undefined ? heading : pinnedName.trim()
      const rawId = pinnedId === undefined ? slugCriterionId(heading) : pinnedId.trim()
      current = { id: dedupCriterionId(rawId, seen), name }
    } else if (line.startsWith('# ')) {
      continue
    } else {
      buf.push(line)
    }
  }
  flush()

  if (criteria.length === 0) {
    throw new VerifierError(
      `${source} contains no criteria; add a ## Criteria section with ### headings`,
      'VERIFIER_INVALID_ARGUMENT',
    )
  }
  const empty = criteria.filter(criterion => criterion.description.length === 0).map(criterion => criterion.id)
  if (empty.length > 0) {
    throw new VerifierError(
      `${source} has empty instructions for: ${empty.join(', ')}`,
      'VERIFIER_INVALID_ARGUMENT',
    )
  }
  return { groundTruthNote, criteria }
}

/**
 * Normalize inline criteria into canonical `{ id, name, description }` records.
 * @param criteria - non-empty list of name/description objects.
 * @returns criteria in input order with unique ids.
 * @throws {@link VerifierError} `VERIFIER_INVALID_ARGUMENT` when the list or a description is empty.
 */
export function normalizeCriteria(criteria: readonly InlineCriterionInput[]): VerifierCriterion[] {
  if (criteria.length === 0) {
    throw new VerifierError('criteria is empty', 'VERIFIER_INVALID_ARGUMENT')
  }
  const seen = new Set<string>()
  return criteria.map((raw, index) => {
    const description = raw.description.trim()
    if (description.length === 0) {
      throw new VerifierError(`criteria[${index}] is missing a description`, 'VERIFIER_INVALID_ARGUMENT')
    }
    const name = (raw.name?.trim() || raw.id?.trim() || slugCriterionId(description))
    const id = dedupCriterionId(raw.id?.trim() || slugCriterionId(name), seen)
    return { id, name, description }
  })
}

/**
 * Load one bundled criteria file.
 * @param name - `terminal_bench`, `swe_bench`, or `medagentbench`.
 * @returns the file's ground-truth note and criteria.
 */
export function loadBundledCriteria(name: BundledCriteriaName): ParsedCriteria {
  return parseCriteriaMarkdown(BUNDLED_MARKDOWN[name], name)
}

/**
 * True when `name` is a bundled criteria id.
 * @param name - candidate name.
 * @returns whether the name is one of {@link BUNDLED_CRITERIA_NAMES}.
 */
export function isBundledCriteriaName(name: string): name is BundledCriteriaName {
  return (BUNDLED_CRITERIA_NAMES as readonly string[]).includes(name)
}
