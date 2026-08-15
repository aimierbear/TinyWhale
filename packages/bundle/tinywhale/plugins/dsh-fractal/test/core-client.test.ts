import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CoreClient, CoreClientError } from '../src/core-client.js'

const fixtures = new URL('./fixtures/', import.meta.url)
const actionBin = new URL('mock-action.mjs', fixtures).pathname
const capabilityBin = new URL('mock-capability.mjs', fixtures).pathname

test('CoreClient exchanges one strict JSON object with both binaries', async () => {
  await Promise.all([chmod(actionBin, 0o755), chmod(capabilityBin, 0o755)])
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-core-'))
  const client = new CoreClient({ actionBin, capabilityBin, maxOutputBytes: 64_000, timeoutMs: 2_000 })
  assert.equal((await client.action('begin_change_scope', { cwd }, { cwd })).scope_id, 'scope_mock')
  assert.equal((await client.capability('query_dependencies', { project: cwd, file_path: 'src/a.ts' }, { cwd })).status, 'ok')
})

test('CoreClient fails closed for a missing binary and malformed output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fractal-core-'))
  const missing = new CoreClient({
    actionBin: join(cwd, 'missing'),
    capabilityBin: join(cwd, 'missing'),
    maxOutputBytes: 64_000,
    timeoutMs: 2_000,
  })
  await assert.rejects(
    missing.capability('scan_dependencies', { project: cwd }, { cwd }),
    (error: unknown) => error instanceof CoreClientError && error.code === 'binary_unavailable',
  )

  const malformed = join(cwd, 'malformed.mjs')
  await writeFile(malformed, '#!/usr/bin/env node\nconsole.log("not-json")\n', 'utf8')
  await chmod(malformed, 0o755)
  const invalid = new CoreClient({ actionBin: malformed, capabilityBin: malformed, maxOutputBytes: 64_000, timeoutMs: 2_000 })
  await assert.rejects(
    invalid.capability('scan_dependencies', { project: cwd }, { cwd }),
    (error: unknown) => error instanceof CoreClientError && error.code === 'invalid_output',
  )
})
