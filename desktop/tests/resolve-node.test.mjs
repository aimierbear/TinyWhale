import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isElectronBinary, resolveNodeExecutable } from '../src/resolve-node.mjs'

test('isElectronBinary recognizes Electron paths and rejects Node', () => {
  assert.equal(isElectronBinary('/usr/local/bin/node'), false)
  assert.equal(isElectronBinary('/usr/local/bin/electron'), true)
  assert.equal(isElectronBinary('/tmp/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), true)
  assert.equal(isElectronBinary('/Applications/TinyWhale.app/Contents/MacOS/TinyWhale'), true)
  assert.equal(isElectronBinary('/usr/local/bin/node', { electron: '43.0.0' }, '/usr/local/bin/node'), true)
})

test('resolveNodeExecutable prefers TINYWHALE_NODE_EXECUTABLE over Electron execPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-node-'))
  const nodePath = join(dir, 'node')
  writeFileSync(nodePath, '')
  const resolved = resolveNodeExecutable(
    { TINYWHALE_NODE_EXECUTABLE: nodePath, PATH: '' },
    '/Applications/TinyWhale.app/Contents/MacOS/TinyWhale',
  )
  assert.equal(resolved, nodePath)
})

test('resolveNodeExecutable refuses to return Electron as Node', () => {
  assert.throws(
    () => resolveNodeExecutable({ PATH: '' }, '/usr/local/bin/electron'),
    /Cannot find a real Node/,
  )
  assert.throws(
    () => resolveNodeExecutable({ PATH: '' }, '/Applications/TinyWhale.app/Contents/MacOS/TinyWhale'),
    /Cannot find a real Node/,
  )
})

test('resolveNodeExecutable accepts the current Node when not Electron', () => {
  const resolved = resolveNodeExecutable({ PATH: '' }, process.execPath)
  assert.equal(resolved, process.execPath)
})
