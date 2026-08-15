import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePnpmExecutable } from '../src/plugin.ts'

describe('resolvePnpmExecutable', () => {
  it('prefers TINYWHALE_PNPM when that file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-'))
    const pnpm = join(dir, 'pnpm')
    writeFileSync(pnpm, '')
    expect(resolvePnpmExecutable({ TINYWHALE_PNPM: pnpm })).toBe(pnpm)
  })

  it('ignores TINYWHALE_PNPM when the path is missing', () => {
    expect(resolvePnpmExecutable({ TINYWHALE_PNPM: join(tmpdir(), 'no-such-pnpm') })).toBeUndefined()
  })

  it('accepts an empty environment', () => {
    const found = resolvePnpmExecutable({})
    if (found !== undefined) expect(found.endsWith('pnpm')).toBe(true)
  })
})
