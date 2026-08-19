/**
 * The extras bundle's substance is its patch file: the `dsh.bundle.patch`
 * manifest field must name a real, parseable insert list, and the declared
 * dependencies must cover every inserted package name.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as Tinywhale from '../src/index.ts'
import * as TinywhaleInvariant from '../src/invariant.ts'

const EXPECTED_ROWS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'dsh-fractal', name: 'dsh-fractal' },
  { id: 'dsh-security-codex', name: 'dsh-security-codex' },
  { id: 'dsh-market', name: 'dshmarket' },
  { id: 'genui', name: '@omdsh-dev/dsh-genui' },
  { id: 'auto-continue', name: 'dsh-client-auto-continue' },
  { id: 'better-sidebar', name: 'dsh-better-sidebar' },
  { id: 'modlens', name: '@liustack/modlens' },
]

describe('dsh-tinywhale bundle', () => {
  it('declares a parseable extras insert list and depends on every inserted package', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string; name?: string }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.map(row => ({ id: row.id, name: row.name }))).toEqual([...EXPECTED_ROWS])
    for (const row of EXPECTED_ROWS) {
      expect(manifest.dependencies).toHaveProperty(row.name)
    }
  })

  it('pins auto-continue that registers the keyed plugin settings card', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const pinned = manifest.dependencies?.['dsh-client-auto-continue']
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
    const installed = JSON.parse(
      readFileSync(resolve(root, 'node_modules/dsh-client-auto-continue/package.json'), 'utf8'),
    ) as { version: string }
    expect(installed.version).toBe(pinned)
    const client = readFileSync(
      resolve(root, 'node_modules/dsh-client-auto-continue/lib/client.js'),
      'utf8',
    )
    expect(client).toMatch(/name:\s*"settings\.plugin\.item"[\s\S]{0,200}key:\s*SETTINGS_NS/)
  })

  it('registers its explained empty runtime invariant', async () => {
    expect(Object.keys(Tinywhale)).toEqual([])
    expect(TinywhaleInvariant.name).toBe('tinywhale-bundle-invariant')
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(TinywhaleInvariant)
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-tinywhale', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
