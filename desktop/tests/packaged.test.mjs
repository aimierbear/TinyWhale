import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  envForPackagedRuntime,
  isTranslocatedApp,
  packagedPathExtras,
  readPackagedStamp,
  resolvePackagedRuntimeRoot,
} from '../src/packaged.mjs'

function fakeRuntime() {
  const resources = mkdtempSync(join(tmpdir(), 'tinywhale-packaged-'))
  writeFileSync(join(resources, 'tinywhale-packaged.json'), `${JSON.stringify({
    mode: 'packaged',
    version: '0.1.0',
    releaseUrl: 'https://example.test/releases',
  })}\n`)
  const runtime = join(resources, 'runtime')
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  mkdirSync(join(runtime, 'node', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'bin', 'dsh'), '')
  writeFileSync(join(runtime, 'node', 'bin', 'node'), '')
  return { resources, runtime }
}

test('readPackagedStamp requires mode packaged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-stamp-'))
  assert.equal(readPackagedStamp(dir), undefined)
  writeFileSync(join(dir, 'tinywhale-packaged.json'), '{"mode":"dev"}\n')
  assert.equal(readPackagedStamp(dir), undefined)
  writeFileSync(join(dir, 'tinywhale-packaged.json'), '{"mode":"packaged","version":"1.0.0"}\n')
  assert.deepEqual(readPackagedStamp(dir), { version: '1.0.0', releaseUrl: undefined })
})

test('resolvePackagedRuntimeRoot needs the bundled dsh and node', () => {
  const { resources, runtime } = fakeRuntime()
  assert.equal(resolvePackagedRuntimeRoot(resources), runtime)
})

test('resolvePackagedRuntimeRoot does not require the JSON stamp', () => {
  const resources = mkdtempSync(join(tmpdir(), 'tinywhale-bins-only-'))
  const runtime = join(resources, 'runtime')
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  mkdirSync(join(runtime, 'node', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'bin', 'dsh'), '')
  writeFileSync(join(runtime, 'node', 'bin', 'node'), '')
  assert.equal(resolvePackagedRuntimeRoot(resources), runtime)
})

test('isTranslocatedApp detects Gatekeeper and DMG copies, not Applications on Macintosh HD', () => {
  assert.equal(isTranslocatedApp('/Applications/TinyWhale.app/Contents/MacOS/TinyWhale'), false)
  assert.equal(
    isTranslocatedApp('/Volumes/Macintosh HD/Applications/TinyWhale.app/Contents/MacOS/TinyWhale'),
    false,
  )
  assert.equal(
    isTranslocatedApp('/private/var/folders/xx/AppTranslocation/abc/d/TinyWhale.app/Contents/MacOS/TinyWhale'),
    true,
  )
  assert.equal(isTranslocatedApp('/Volumes/TinyWhale/TinyWhale.app/Contents/MacOS/TinyWhale'), true)
})

test('envForPackagedRuntime prepends runtime bins and reads the stamp beside the runtime', () => {
  const { resources, runtime } = fakeRuntime()
  writeFileSync(join(runtime, 'packaged.json'), `${JSON.stringify({
    mode: 'packaged',
    version: '0.1.0',
    releaseUrl: 'https://example.test/releases',
  })}\n`)
  const env = envForPackagedRuntime(runtime, { PATH: '/usr/bin' })
  assert.equal(env.TINYWHALE_PACKAGED, '1')
  assert.equal(env.TINYWHALE_VERSION, '0.1.0')
  assert.equal(env.TINYWHALE_RELEASE_URL, 'https://example.test/releases')
  assert.ok(env.PATH.startsWith(join(runtime, 'bin')))
  assert.equal(env.TINYWHALE_DSH_BIN, join(runtime, 'bin', 'dsh'))
  assert.deepEqual(packagedPathExtras(runtime), [join(runtime, 'bin'), join(runtime, 'node', 'bin')])
  assert.equal(resources.length > 0, true)
})
