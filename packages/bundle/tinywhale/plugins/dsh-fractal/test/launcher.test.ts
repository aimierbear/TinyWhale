import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('fractal launchers fail loud when FRACTAL_PYTHON is set but missing', () => {
  const launcher = fileURLToPath(new URL('../core/bin/fractal-action', import.meta.url))
  const result = spawnSync(launcher, ['--help'], {
    env: { ...process.env, FRACTAL_PYTHON: '/no/such/python' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 127)
  assert.match(result.stderr, /FRACTAL_PYTHON/)
})

test('packaged launchers do not fall through to system python3', () => {
  const launcher = fileURLToPath(new URL('../core/bin/fractal-action', import.meta.url))
  const env = { ...process.env, TINYWHALE_PACKAGED: '1' }
  delete env.FRACTAL_PYTHON
  delete env.TINYWHALE_PYTHON
  const result = spawnSync(launcher, ['--help'], { env, encoding: 'utf8' })
  assert.equal(result.status, 127)
  assert.match(result.stderr, /packaged TinyWhale is missing FRACTAL_PYTHON/)
})
