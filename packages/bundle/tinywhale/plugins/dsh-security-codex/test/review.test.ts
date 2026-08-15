/**
 * Unit tests for the in-process review engine, driven by fake model streams
 * and real temp directories. Tests describe behavior: collection bounds,
 * batching, findings parsing, deep-mode verification, cancellation, and
 * summary rendering.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

import {
  buildBatches,
  capUtf8,
  collectFiles,
  mapReviewFailure,
  parseFindings,
  renderSummary,
  ReviewModelError,
  runReview,
  type ReviewEngineOptions,
  type ReviewLimits,
  type ReviewRequest,
  type ReviewStreamFn,
} from '../src/review.js'

const LIMITS: ReviewLimits = {
  maxFileBytes: 4096,
  maxTotalBytes: 64_000,
  batchBytes: 4096,
  maxBatches: 10,
  maxTokens: 1024,
  maxFindings: 50,
}

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-pro' } as const

type Reply =
  | { kind: 'text'; text: string; usage?: TokenUsage; truncated?: boolean }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'aborted'; code?: string; message?: string }

/** A fake chunk stream replaying one reply per call, with text split into deltas. */
function fakeStream(replies: readonly Reply[], onCall?: (options: GenerateOptions) => void): ReviewStreamFn {
  let index = 0
  return async function * (options: GenerateOptions): AsyncIterable<StreamChunk> {
    onCall?.(options)
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    switch (reply.kind) {
      case 'text': {
        const pieces = reply.text.match(/.{1,64}/gs) ?? ['']
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
        if (reply.usage !== undefined) yield { type: 'usage', usage: reply.usage }
        yield { type: 'finish', reason: reply.truncated === true ? { kind: 'max-tokens' } : { kind: 'stop' } }
        return
      }
      case 'error': {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: reply.message, code: reply.code } } }
        return
      }
      case 'aborted': {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: reply.message ?? 'aborted', code: reply.code ?? 'ABORTED' } },
        }
        return
      }
    }
  }
}

function findingText(severity: string, path: string, title: string): string {
  return JSON.stringify({
    findings: [{
      severity,
      title,
      path,
      line: 3,
      description: 'Concrete exploitable weakness.',
      suggestion: 'Fix it.',
    }],
  })
}

async function options(overrides: Partial<ReviewEngineOptions>): Promise<ReviewEngineOptions> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-test-'))
  return {
    stream: fakeStream([]),
    route: { ...ROUTE },
    limits: { ...LIMITS },
    request: { target: dir, mode: 'standard' },
    reportDir: join(dir, 'reports'),
    ...overrides,
  }
}

describe('collectFiles', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-collect-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('collects nested text files with repository-relative paths and skips dot/node_modules/binary/large files', async () => {
    await mkdir(join(dir, 'src', 'nested'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'src', 'b.ts'), 'const b = 2\n')
    await writeFile(join(dir, 'src', 'nested', 'c.ts'), 'const c = 3\n')
    await writeFile(join(dir, 'node_modules', 'pkg', 'skip.ts'), 'skip\n')
    await writeFile(join(dir, '.git', 'config'), 'skip\n')
    await writeFile(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(dir, 'big.ts'), 'x'.repeat(LIMITS.maxFileBytes + 1))
    const result = await collectFiles({ target: dir, mode: 'standard' }, LIMITS)
    assert.deepEqual(result.files.map(f => f.rel), ['a.ts', 'src/b.ts', 'src/nested/c.ts'])
    assert.equal(result.filesSkipped, 2)
  })

  it('restricts collection to the requested paths', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'src', 'b.ts'), 'const b = 2\n')
    const result = await collectFiles({ target: dir, mode: 'standard', paths: ['src'] }, LIMITS)
    assert.deepEqual(result.files.map(f => f.rel), ['src/b.ts'])
  })

  it('accepts a single file path', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'b.ts'), 'const b = 2\n')
    const result = await collectFiles({ target: dir, mode: 'standard', paths: ['a.ts'] }, LIMITS)
    assert.deepEqual(result.files.map(f => f.rel), ['a.ts'])
  })

  it('stops accepting files past the total byte budget', async () => {
    await writeFile(join(dir, 'a.ts'), 'x'.repeat(3000))
    await writeFile(join(dir, 'b.ts'), 'y'.repeat(3000))
    const result = await collectFiles({ target: dir, mode: 'standard' }, { ...LIMITS, maxTotalBytes: 4000 })
    assert.deepEqual(result.files.map(f => f.rel), ['a.ts'])
    assert.equal(result.filesSkipped, 1)
  })

  it('rejects a symlinked file in an explicit path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-collect-out-'))
    try {
      await writeFile(join(outside, 'secret.ts'), 'secret\n')
      await symlink(join(outside, 'secret.ts'), join(dir, 'link.ts'))
      await assert.rejects(
        collectFiles({ target: dir, mode: 'standard', paths: ['link.ts'] }, LIMITS),
        /symlink/,
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a path that resolves outside the repository through an intermediate symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-collect-out-'))
    try {
      await mkdir(join(outside, 'sub'), { recursive: true })
      await writeFile(join(outside, 'sub', 'leak.ts'), 'leak\n')
      await symlink(join(outside, 'sub'), join(dir, 'linked'))
      await assert.rejects(
        collectFiles({ target: dir, mode: 'standard', paths: ['linked/leak.ts'] }, LIMITS),
        /outside/,
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips symlinked entries during the whole-repository walk', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-collect-out-'))
    try {
      await writeFile(join(outside, 'secret.ts'), 'secret\n')
      await symlink(join(outside, 'secret.ts'), join(dir, 'link.ts'))
      await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
      const result = await collectFiles({ target: dir, mode: 'standard' }, LIMITS)
      assert.deepEqual(result.files.map(f => f.rel), ['a.ts'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('buildBatches', () => {
  it('packs files under the byte budget and truncates an oversized file', () => {
    const files = [
      { rel: 'a.ts', content: Buffer.from('a'.repeat(1000)) },
      { rel: 'b.ts', content: Buffer.from('b'.repeat(1000)) },
      { rel: 'big.ts', content: Buffer.from('c'.repeat(4000)) },
      { rel: 'd.ts', content: Buffer.from('d'.repeat(1000)) },
    ]
    const batches = buildBatches(files, 2200)
    assert.ok(batches.length >= 3)
    const big = batches.find(batch => batch.includes('big.ts'))
    assert.ok(big !== undefined && big.includes('file truncated to fit the batch budget'))
    for (const batch of batches) assert.ok(Buffer.byteLength(batch, 'utf8') <= 2200)
  })

  it('returns one batch for a single small file', () => {
    const batches = buildBatches([{ rel: 'a.ts', content: Buffer.from('const a = 1\n') }], 4096)
    assert.equal(batches.length, 1)
    assert.ok(batches[0]?.includes('### a.ts'))
  })
})

describe('parseFindings', () => {
  it('parses a fenced JSON object', () => {
    const findings = parseFindings(`Here:\n\`\`\`json\n${findingText('high', 'a.ts', 'SQL injection')}\n\`\`\``, 50)
    assert.equal(findings?.length, 1)
    assert.equal(findings?.[0]?.severity, 'high')
    assert.equal(findings?.[0]?.path, 'a.ts')
    assert.equal(findings?.[0]?.line, 3)
  })

  it('parses a bare object and a bare array', () => {
    assert.equal(parseFindings(findingText('medium', 'b.ts', 'XSS'), 50)?.length, 1)
    const bare = JSON.stringify([{ severity: 'low', title: 'T', path: 'c.ts', description: 'D' }])
    assert.equal(parseFindings(bare, 50)?.[0]?.severity, 'low')
  })

  it('returns undefined for garbage and drops invalid entries', () => {
    assert.equal(parseFindings('no json here at all', 50), undefined)
    assert.equal(parseFindings('{"findings": [}', 50), undefined)
    const mixed = JSON.stringify({
      findings: [
        { severity: 'high', title: 'ok', path: 'a.ts', description: 'fine' },
        { severity: 'catastrophic', title: 'bad', path: 'b.ts', description: 'drop' },
        { severity: 'low', title: '', path: 'c.ts', description: 'drop' },
        { severity: 'low', title: 'keep', path: 'd.ts', description: 'fine', line: 'not-a-number' },
        { severity: 'low', title: 'keep2', path: 'e.ts', description: 'fine', line: 7 },
      ],
    })
    const parsed = parseFindings(mixed, 50)
    assert.deepEqual(parsed?.map(f => f.title), ['ok', 'keep2'])
  })

  it('caps the accepted findings count', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      severity: 'low',
      title: `t${i}`,
      path: `p${i}.ts`,
      description: 'd',
    }))
    const parsed = parseFindings(JSON.stringify({ findings: entries }), 3)
    assert.equal(parsed?.length, 3)
  })

  it('drops findings whose path is absolute or escapes the repository', () => {
    const text = JSON.stringify({
      findings: [
        { severity: 'high', title: 'a', path: '/etc/passwd', description: 'drop' },
        { severity: 'high', title: 'b', path: '../secret.ts', description: 'drop' },
        { severity: 'high', title: 'c', path: 'src\\win.ts', description: 'drop' },
        { severity: 'low', title: 'keep', path: 'src/ok.ts', description: 'keep' },
      ],
    })
    const parsed = parseFindings(text, 50)
    assert.deepEqual(parsed?.map(f => f.title), ['keep'])
  })
})

describe('runReview', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-review-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reviews batches, aggregates findings, sums tokens, and writes a report', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'src', 'b.ts'), 'const b = 2\n')
    const opts = await options({
      request: { target: dir, mode: 'standard' },
      limits: { ...LIMITS, batchBytes: 64 },
      stream: fakeStream([
        { kind: 'text', text: findingText('high', 'a.ts', 'Injection'), usage: { inputTokens: 100, outputTokens: 20 } },
        { kind: 'text', text: findingText('low', 'src/b.ts', 'Info'), usage: { inputTokens: 80, outputTokens: 10 } },
      ]),
    })
    const result = await runReview(opts)
    assert.equal(result.findings.length, 2)
    assert.equal(result.findings[0]?.severity, 'high')
    assert.equal(result.filesReviewed, 2)
    assert.equal(result.callsMade, 2)
    assert.equal(result.unparseableBatches, 0)
    assert.equal(result.tokens.inputTokens, 180)
    assert.equal(result.tokens.outputTokens, 30)
    const report = await readFile(result.reportPath, 'utf8')
    assert.ok(report.includes('[high] Injection'))
    assert.ok(report.includes('deepseek-official / deepseek-v4-pro'))
  })

  it('reports an empty scan without calling the model', async () => {
    const opts = await options({
      request: { target: dir, mode: 'standard' },
      stream: fakeStream([]),
    })
    const result = await runReview(opts)
    assert.equal(result.findings.length, 0)
    assert.equal(result.callsMade, 0)
    const report = await readFile(result.reportPath, 'utf8')
    assert.ok(report.includes('No security findings'))
  })

  it('throws a ReviewModelError carrying the provider code when a call fails', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    const opts = await options({
      request: { target: dir, mode: 'standard' },
      stream: fakeStream([{ kind: 'error', code: 'AUTH', message: 'bad key' }]),
    })
    await assert.rejects(runReview(opts), (error: unknown) => error instanceof ReviewModelError && error.code === 'AUTH')
  })

  it('counts unparseable batches and keeps findings from parseable ones', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'b.ts'), 'const b = 2\n')
    const opts = await options({
      request: { target: dir, mode: 'standard' },
      limits: { ...LIMITS, batchBytes: 64 },
      stream: fakeStream([
        { kind: 'text', text: 'no findings json in this reply' },
        { kind: 'text', text: findingText('medium', 'b.ts', 'CSRF') },
      ]),
    })
    const result = await runReview(opts)
    assert.equal(result.unparseableBatches, 1)
    assert.equal(result.findings.length, 1)
  })

  it('marks max-token finishes as truncated', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    const opts = await options({
      request: { target: dir, mode: 'standard' },
      stream: fakeStream([{ kind: 'text', text: findingText('low', 'a.ts', 'T'), truncated: true }]),
    })
    const result = await runReview(opts)
    assert.equal(result.truncatedBatches, 1)
  })

  it('deep mode verifies first-pass findings and keeps them when verification is unparseable', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    const opts = await options({
      request: { target: dir, mode: 'deep' },
      stream: fakeStream([
        { kind: 'text', text: findingText('high', 'a.ts', 'First') },
        { kind: 'text', text: JSON.stringify({ findings: [{ severity: 'medium', title: 'Confirmed', path: 'a.ts', description: 'kept' }] }) },
      ]),
    })
    const result = await runReview(opts)
    assert.equal(result.callsMade, 2)
    assert.deepEqual(result.findings.map(f => f.title), ['Confirmed'])
  })

  it('deep mode drops a batch without first-pass findings from verification', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'b.ts'), 'const b = 2\n')
    const opts = await options({
      request: { target: dir, mode: 'deep' },
      limits: { ...LIMITS, batchBytes: 64 },
      stream: fakeStream([
        { kind: 'text', text: '{"findings": []}' },
        { kind: 'text', text: findingText('low', 'b.ts', 'Kept') },
        { kind: 'text', text: JSON.stringify({ findings: [{ severity: 'low', title: 'Kept', path: 'b.ts', description: 'verified' }] }) },
      ]),
    })
    const result = await runReview(opts)
    assert.equal(result.callsMade, 3)
    assert.deepEqual(result.findings.map(f => f.title), ['Kept'])
  })

  it('aborting between batches propagates the signal reason and maps to killed', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 1\n')
    await writeFile(join(dir, 'b.ts'), 'const b = 2\n')
    const controller = new AbortController()
    const opts = await options({
      request: { target: dir, mode: 'standard' },
      limits: { ...LIMITS, batchBytes: 64 },
      signal: controller.signal,
      stream: fakeStream(
        [{ kind: 'text', text: '{"findings": []}' }, { kind: 'text', text: '{"findings": []}' }],
        () => controller.abort(new Error('user cancelled')),
      ),
    })
    const error = await runReview(opts).then(() => undefined, (caught: unknown) => caught)
    assert.ok(error instanceof Error && error.message === 'user cancelled')
    assert.equal(mapReviewFailure(error, true).status, 'killed')
  })
})

describe('renderSummary and capUtf8', () => {
  it('renders counts, route, and report path; empty results say so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-summary-'))
    try {
      const result = {
        findings: [
          { severity: 'high' as const, title: 'A', path: 'a.ts', description: 'd' },
          { severity: 'critical' as const, title: 'B', path: 'b.ts', description: 'd' },
        ],
        filesReviewed: 3,
        filesSkipped: 1,
        callsMade: 2,
        unparseableBatches: 0,
        truncatedBatches: 0,
        tokens: { inputTokens: 10, outputTokens: 2 },
        reportPath: join(dir, 'reports', 'report.md'),
      }
      const text = renderSummary(result, { ...ROUTE })
      assert.ok(text.includes('2 total (1 critical, 1 high, 0 medium, 0 low)'))
      assert.ok(text.includes('deepseek-official / deepseek-v4-pro'))
      assert.ok(text.includes('Top findings:'))
      const empty = renderSummary({ ...result, findings: [] }, { ...ROUTE })
      assert.ok(empty.includes('No security findings'))
      const unparseable = renderSummary({ ...result, findings: [], unparseableBatches: 1 }, { ...ROUTE })
      assert.ok(unparseable.includes('no parseable findings'))
      assert.ok(!unparseable.includes('No security findings'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caps the top-finding list at ten entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-summary-'))
    try {
      const findings = Array.from({ length: 20 }, (_, i) => ({
        severity: 'low' as const,
        title: `t${i}`,
        path: `p${i}.ts`,
        description: 'd',
      }))
      const text = renderSummary({
        findings,
        filesReviewed: 1,
        filesSkipped: 0,
        callsMade: 1,
        unparseableBatches: 0,
        truncatedBatches: 0,
        tokens: { inputTokens: 0, outputTokens: 0 },
        reportPath: join(dir, 'report.md'),
      }, { ...ROUTE })
      assert.ok(text.includes('- [low] p0.ts — t0'))
      assert.ok(!text.includes('- [low] p10.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('capUtf8 never splits a multibyte character', () => {
    const text = '中'.repeat(100)
    const capped = capUtf8(text, 30)
    assert.ok(Buffer.byteLength(capped, 'utf8') <= 30)
    assert.ok(!capped.slice(0, -1).endsWith('\ufffd'))
  })
})
