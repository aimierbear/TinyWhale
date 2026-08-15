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
  isTinyWhaleCheckout,
  isTinyWhaleUpdateReady,
  resolveHarnessLaunch,
  resolveRepoRoot,
  shouldAttachToReadyOrigin,
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

test('resolveRepoRoot honors TINYWHALE_REPO when it is a checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-repo-'))
  writeFileSync(join(dir, 'TINYWHALE.md'), '# TinyWhale\n')
  const sourceBin = join(dir, 'apps/cli/src/bin.ts')
  mkdirSync(dirname(sourceBin), { recursive: true })
  writeFileSync(sourceBin, '')
  assert.equal(resolveRepoRoot({ env: { TINYWHALE_REPO: dir } }), dir)
  assert.notEqual(resolveRepoRoot({ env: { TINYWHALE_REPO: tmpdir() } }), tmpdir())
})

test('resolveRepoRoot reads a tinywhale-checkout stamp from process.resourcesPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-stamp-'))
  writeFileSync(join(dir, 'TINYWHALE.md'), '# TinyWhale\n')
  const sourceBin = join(dir, 'apps/cli/src/bin.ts')
  mkdirSync(dirname(sourceBin), { recursive: true })
  writeFileSync(sourceBin, '')
  const resources = mkdtempSync(join(tmpdir(), 'tinywhale-res-'))
  writeFileSync(join(resources, 'tinywhale-checkout.json'), `${JSON.stringify({ repoRoot: dir })}\n`)
  const previous = process.resourcesPath
  process.resourcesPath = resources
  try {
    assert.equal(resolveRepoRoot({ env: {} }), dir)
  } finally {
    if (previous === undefined) delete process.resourcesPath
    else process.resourcesPath = previous
  }
})

test('shouldAttachToReadyOrigin refuses a random server for checkout and packaged apps', () => {
  assert.equal(shouldAttachToReadyOrigin({
    attachOnly: false, checkout: false, packaged: true, tinywhaleReady: false,
  }), false)
  assert.equal(shouldAttachToReadyOrigin({
    attachOnly: false, checkout: true, packaged: false, tinywhaleReady: false,
  }), false)
  assert.equal(shouldAttachToReadyOrigin({
    attachOnly: false, checkout: false, packaged: true, tinywhaleReady: true,
  }), true)
  assert.equal(shouldAttachToReadyOrigin({
    attachOnly: true, checkout: false, packaged: true, tinywhaleReady: false,
  }), true)
})

test('resolveHarnessLaunch uses a packaged runtime when there is no checkout', () => {
  const resources = mkdtempSync(join(tmpdir(), 'tinywhale-pkg-res-'))
  writeFileSync(join(resources, 'tinywhale-packaged.json'), `${JSON.stringify({ mode: 'packaged' })}\n`)
  const runtime = join(resources, 'runtime')
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  mkdirSync(join(runtime, 'node', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'bin', 'dsh'), '')
  writeFileSync(join(runtime, 'node', 'bin', 'node'), '')
  const home = mkdtempSync(join(tmpdir(), 'tinywhale-pkg-home-'))
  const launch = resolveHarnessLaunch({
    env: { PATH: '' },
    repoRoot: home,
    home,
    runtimeRoot: runtime,
  })
  assert.equal(launch.command, join(runtime, 'bin', 'dsh'))
  assert.deepEqual(launch.args, [])
  assert.equal(launch.cwd, home)
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

test('resolveHarnessLaunch prefers checkout source over PATH dsh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-prefer-'))
  writeFileSync(join(dir, 'TINYWHALE.md'), '# TinyWhale\n')
  const sourceBin = join(dir, 'apps/cli/src/bin.ts')
  mkdirSync(dirname(sourceBin), { recursive: true })
  writeFileSync(sourceBin, '')
  const pathDir = mkdtempSync(join(tmpdir(), 'tinywhale-path-'))
  const pathDsh = join(pathDir, 'dsh')
  writeFileSync(pathDsh, '')
  const nodePath = join(dir, 'node')
  writeFileSync(nodePath, '')
  const launch = resolveHarnessLaunch({
    env: { PATH: pathDir, TINYWHALE_NODE_EXECUTABLE: nodePath },
    repoRoot: dir,
    home: dir,
  })
  assert.equal(launch.command, nodePath)
  assert.deepEqual(launch.args, ['--import', 'tsx/esm', sourceBin])
})

test('isTinyWhaleCheckout requires the marker and source CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tinywhale-marker-'))
  assert.equal(isTinyWhaleCheckout(dir), false)
  writeFileSync(join(dir, 'TINYWHALE.md'), '# TinyWhale\n')
  assert.equal(isTinyWhaleCheckout(dir), false)
  const sourceBin = join(dir, 'apps/cli/src/bin.ts')
  mkdirSync(dirname(sourceBin), { recursive: true })
  writeFileSync(sourceBin, '')
  assert.equal(isTinyWhaleCheckout(dir), true)
})

test('isTinyWhaleUpdateReady is true only for the TinyWhale status channel', async () => {
  const ready = await listen((request, response) => {
    if (request.method === 'POST' && request.url === '/tinywhale/status') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: 'tinywhale-probe',
        result: { ok: true, value: { available: true } },
      }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  const missing = await listen((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  try {
    assert.equal(await isTinyWhaleUpdateReady(ready.url), true)
    assert.equal(await isTinyWhaleUpdateReady(missing.url), false)
  } finally {
    ready.server.close()
    missing.server.close()
  }
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
    home: dir,
  })
  assert.equal(launch.command, nodePath)
  assert.deepEqual(launch.args, ['--import', 'tsx/esm', sourceBin])
  assert.equal(launch.cwd, dir)
})
