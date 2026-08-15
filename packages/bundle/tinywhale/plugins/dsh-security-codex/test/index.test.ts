/**
 * Unit tests for the adapter surface: config resolution, failure mapping,
 * and the background-job handoff render.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mapReviewFailure, ReviewModelError } from '../src/review.js'
import { renderOutcome, resolveConfig } from '../src/index.js'

describe('resolveConfig', () => {
  it('applies defaults and trims empty route fields', () => {
    const resolved = resolveConfig({})
    assert.equal(resolved.provider, undefined)
    assert.equal(resolved.model, undefined)
    assert.equal(resolved.maxFileBytes, 262_144)
    assert.equal(resolved.maxBatches, 12)
    assert.equal(resolved.maxTokens, 16_384)
    assert.equal(resolved.maxFindings, 100)
    assert.equal(resolved.reasoningEffort, 'off')
    assert.equal(resolved.outputDir, undefined)
  })

  it('honors a configured effort', () => {
    const resolved = resolveConfig({ effort: 'max' })
    assert.equal(resolved.reasoningEffort, 'max')
  })

  it('keeps a configured route and output dir', () => {
    const resolved = resolveConfig({
      provider: ' deepseek-official ',
      model: 'deepseek-v4-pro',
      outputDir: '/tmp/reports',
    })
    assert.equal(resolved.provider, 'deepseek-official')
    assert.equal(resolved.model, 'deepseek-v4-pro')
    assert.equal(resolved.outputDir, '/tmp/reports')
  })

  it('rejects a relative outputDir', () => {
    assert.throws(() => resolveConfig({ outputDir: 'reports' }), /absolute path/)
  })

  it('drops blank provider/model so the session route can take over', () => {
    const resolved = resolveConfig({ provider: '  ', model: '' })
    assert.equal(resolved.provider, undefined)
    assert.equal(resolved.model, undefined)
  })
})

describe('mapReviewFailure', () => {
  it('maps cancellation to killed regardless of the error shape', () => {
    const outcome = mapReviewFailure(new Error('whatever'), true)
    assert.equal(outcome.status, 'killed')
  })

  it('maps provider-neutral codes to actionable outputs', () => {
    const cases = [
      ['NO_ADAPTER', 'model route not registered'],
      ['AUTH', 'model credentials rejected'],
      ['MISSING_CREDENTIAL', 'model credentials rejected'],
      ['INVALID_CREDENTIAL', 'model credentials rejected'],
      ['QUOTA', 'model quota exhausted'],
      ['CONTEXT_WINDOW_EXCEEDED', 'batch exceeded the model context window'],
      ['RATE_LIMIT', 'model rate limit'],
      ['EMPTY_RESPONSE', 'model returned an empty response'],
    ] as const
    for (const [code, detail] of cases) {
      const outcome = mapReviewFailure(new ReviewModelError('boom', code), false)
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.detail, detail)
      assert.ok(outcome.output !== undefined && outcome.output.length > 0)
    }
  })

  it('falls back to the error text for unknown failures', () => {
    const outcome = mapReviewFailure(new Error('something broke'), false)
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.detail, 'scan failed')
    assert.ok(outcome.output?.includes('something broke'))
  })
})

describe('renderOutcome', () => {
  it('renders the background-job handoff with the job id', () => {
    const blocks = renderOutcome({}, { kind: 'background', jobId: 'security-scan-7' })
    assert.equal(blocks.length, 1)
    assert.ok(blocks[0]?.text.includes('security-scan-7'))
    assert.ok(blocks[0]?.text.includes('job_output security-scan-7'))
  })
})
