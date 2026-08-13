import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  findOnPath,
  harnessUrl,
  isHttpReady,
  resolveHarnessLaunch,
  waitForHttp,
} from '../src/harness.mjs'

function listen(handler) {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected tcp address')
      }
      resolve({ server, port: address.port, url: harnessUrl(address.port) })
    })
  })
}

test('isHttpReady is true only for HTTP 2xx', async () => {
  const ok = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
  })
  const fail = await listen((_request, response) => {
    response.writeHead(503)
    response.end()
  })
  try {
    assert.equal(await isHttpReady(ok.url), true)
    assert.equal(await isHttpReady(fail.url), false)
    assert.equal(await isHttpReady(harnessUrl(1)), false)
  } finally {
    ok.server.close()
    fail.server.close()
  }
})

test('waitForHttp resolves after the server starts', async () => {
  const pending = await listen((_request, response) => {
    response.writeHead(200)
    response.end('ready')
  })
  try {
    await waitForHttp(pending.url, { timeoutMs: 2_000, intervalMs: 20 })
  } finally {
    pending.server.close()
  }
})

test('waitForHttp times out when nothing listens', async () => {
  await assert.rejects(
    waitForHttp(harnessUrl(1), { timeoutMs: 80, intervalMs: 20 }),
    /Timed out/,
  )
})

test('findOnPath locates the current node binary directory', () => {
  const found = findOnPath('node')
  assert.ok(found, 'expected node on PATH')
  assert.match(found, /node(\.exe)?$/)
})

test('resolveHarnessLaunch uses TINYWHALE_DSH_BIN first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-dsh-'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, '')
  const launch = resolveHarnessLaunch({
    env: { TINYWHALE_DSH_BIN: bin, PATH: '' },
    repoRoot: dir,
  })
  assert.equal(launch.command, bin)
  assert.deepEqual(launch.args, [])
})

test('resolveHarnessLaunch falls back to apps/cli source with a real Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-src-'))
  const sourceBin = join(dir, 'apps/cli/src/bin.ts')
  mkdirSync(dirname(sourceBin), { recursive: true })
  writeFileSync(sourceBin, '')
  const nodePath = join(dir, 'node')
  writeFileSync(nodePath, '')
  const launch = resolveHarnessLaunch({
    env: { PATH: '', TINYWHALE_NODE_EXECUTABLE: nodePath },
    repoRoot: dir,
  })
  assert.equal(launch.command, nodePath)
  assert.deepEqual(launch.args, ['--import', 'tsx/esm', sourceBin])
  assert.equal(launch.cwd, dir)
})
