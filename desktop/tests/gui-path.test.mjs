import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { enrichPath, envWithGuiPath, guiPathExtras, knownDshBin } from '../src/gui-path.mjs'

test('guiPathExtras only returns directories that exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'tinywhale-home-'))
  mkdirSync(join(home, '.hermes/node/bin'), { recursive: true })
  const extras = guiPathExtras(home)
  assert.ok(extras.includes(join(home, '.hermes/node/bin')))
  assert.ok(!extras.includes(join(home, '.nvm/current/bin')))
})

test('enrichPath prepends extras and keeps the existing PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'tinywhale-home-'))
  mkdirSync(join(home, '.hermes/node/bin'), { recursive: true })
  const path = enrichPath({ PATH: '/usr/bin:/bin' }, home)
  assert.ok(path.startsWith(join(home, '.hermes/node/bin')))
  assert.match(path, /\/usr\/bin/)
})

test('envWithGuiPath returns a new env object', () => {
  const home = mkdtempSync(join(tmpdir(), 'tinywhale-home-'))
  const env = { PATH: '/bin', HOME: home }
  const next = envWithGuiPath(env, home)
  assert.notEqual(next, env)
  assert.equal(env.PATH, '/bin')
  assert.ok(next.PATH.includes('/bin'))
})

test('knownDshBin finds the hermes install when present', () => {
  const home = mkdtempSync(join(tmpdir(), 'tinywhale-home-'))
  const bin = join(home, '.hermes/node/bin/dsh')
  mkdirSync(join(home, '.hermes/node/bin'), { recursive: true })
  writeFileSync(bin, '')
  assert.equal(knownDshBin(home), bin)
})
