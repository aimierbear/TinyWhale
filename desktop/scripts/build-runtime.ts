/**
 * Assemble the TinyWhale desktop runtime: deploy the web closure, materialize
 * links, and vendor Node / pnpm / Git / CPython for a machine with no toolchain.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { chmod, cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const root = resolve(desktopRoot, '..')
const STAGE = resolve(desktopRoot, '.runtime-stage', 'dsh')
const RUNTIME = resolve(desktopRoot, 'runtime')
const CACHE = resolve(desktopRoot, '.runtime-cache')
const LOCK = resolve(here, 'runtime-lock.json')
const DEPLOY_ROOT = 'tinywhale-desktop-runtime'

interface ArtifactLock {
  version: string
  url: string
  sha256: string
  strip: number
}

interface RuntimeLock {
  node: ArtifactLock
  pnpm: ArtifactLock
  python: ArtifactLock
  git: ArtifactLock
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function run(label: string, command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    console.log(`build-runtime: ${label}: ${[command, ...args].join(' ')}`)
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', error => {
      reject(new Error(`build-runtime: ${label} failed to spawn: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`build-runtime: ${label} failed (${code === null ? signal : code})`))
    })
  })
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeStagedLinks(nodeModules: string): Promise<void> {
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const source = await realpath(remaining)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(source, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

async function download(url: string, destination: string, sha256: string): Promise<void> {
  if (existsSync(destination)) {
    const actual = createHash('sha256').update(readFileSync(destination)).digest('hex')
    if (actual === sha256) return
    rmSync(destination)
  }
  await mkdir(dirname(destination), { recursive: true })
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`build-runtime: download ${url} failed: HTTP ${String(response.status)}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
  const actual = createHash('sha256').update(readFileSync(destination)).digest('hex')
  if (actual !== sha256) {
    rmSync(destination)
    throw new Error(`build-runtime: sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`)
  }
}

function extractTar(archive: string, destination: string, strip: number): Promise<void> {
  mkdirSync(destination, { recursive: true })
  const args = ['-xzf', archive, '-C', destination]
  if (strip > 0) args.push('--strip-components', String(strip))
  return run(`extract ${archive}`, 'tar', args)
}

function writeWrapper(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

function dshWrapper(): string {
  return `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export PATH="$ROOT/bin:$ROOT/node/bin:$ROOT/git/bin:\${PATH:-}"
export TINYWHALE_PACKAGED=1
export TINYWHALE_NODE_EXECUTABLE="$ROOT/node/bin/node"
export TINYWHALE_PNPM="$ROOT/bin/pnpm"
if [ -x "$ROOT/python/bin/python3" ]; then
  export FRACTAL_PYTHON="$ROOT/python/bin/python3"
  export TINYWHALE_PYTHON="$ROOT/python/bin/python3"
fi
for HELPER in \
  "$ROOT/dsh/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper" \
  "$ROOT/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
do
  if [ -x "$HELPER" ]; then
    export DSH_NODE_PTY_SPAWN_HELPER="$HELPER"
    break
  fi
done
exec "$ROOT/node/bin/node" "$ROOT/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
`
}

function pnpmWrapper(): string {
  return `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
exec "$ROOT/node/bin/node" "$ROOT/pnpm/bin/pnpm.cjs" "$@"
`
}

function spawnHelperPaths(): string[] {
  return [
    join(RUNTIME, 'dsh', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    join(
      RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local',
      'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper',
    ),
  ]
}

async function chmodSpawnHelpers(): Promise<void> {
  const found: string[] = []
  for (const helper of spawnHelperPaths()) {
    if (!existsSync(helper)) continue
    await chmod(helper, 0o755)
    found.push(helper)
  }
  if (process.platform === 'darwin' && found.length === 0) {
    throw new Error('build-runtime: no node-pty spawn-helper found after deploy; PTY terminals will fail on a read-only .app')
  }
}

function writePackagedStamp(): void {
  const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version as string
  const stamp = `${JSON.stringify({
    mode: 'packaged',
    version,
    releaseUrl: 'https://github.com/aimierbear/TinyWhale/releases',
  }, null, 2)}\n`
  writeFileSync(join(RUNTIME, 'packaged.json'), stamp)
}

async function assertRuntime(): Promise<void> {
  const missing: string[] = []
  const required = [
    join(RUNTIME, 'bin', 'dsh'),
    join(RUNTIME, 'bin', 'pnpm'),
    join(RUNTIME, 'node', 'bin', 'node'),
    join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
    join(RUNTIME, 'dsh', 'node_modules', 'dsh-fractal', 'core', 'bin', 'fractal-action'),
    join(RUNTIME, 'packaged.json'),
  ]
  for (const file of required) {
    if (!existsSync(file)) missing.push(file)
  }
  if (missing.length > 0) {
    throw new Error(`build-runtime: missing required files:\n${missing.map(file => `  ${file}`).join('\n')}`)
  }
  const node = join(RUNTIME, 'node', 'bin', 'node')
  const dsh = join(RUNTIME, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(node) && existsSync(dsh)) {
    await run('bundled dsh --help', node, [dsh, '--help'])
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'skip-build': { type: 'boolean', default: false },
      'skip-download': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: pnpm exec tsx desktop/scripts/build-runtime.ts [--skip-build] [--skip-download]')
    return
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`build-runtime: only darwin-arm64 is supported, got ${process.platform}-${process.arch}`)
  }
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as RuntimeLock
  await run('runtime closure', pnpmBin(), [
    'exec', 'tsx', 'scripts/verify-runtime-closure.ts', '--manifest', 'desktop/runtime-root/package.json',
  ])
  if (!values['skip-build']) {
    await run('build', pnpmBin(), ['run', 'build'])
  }
  if (STAGE === root || root.startsWith(STAGE + sep)) {
    throw new Error(`build-runtime: refusing to clear ${STAGE}`)
  }
  await rm(STAGE, { recursive: true, force: true })
  const previousNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    await run('deploy', pnpmBin(), [
      '--filter', DEPLOY_ROOT, 'deploy', '--legacy', '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      // dsh-tinywhale pins @omdsh-dev/dsh-genui at a GitHub commit.
      '--config.blockExoticSubdeps=false',
      '--ignore-scripts',
      STAGE,
    ])
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
  await materializeStagedLinks(join(STAGE, 'node_modules'))
  await rm(RUNTIME, { recursive: true, force: true })
  await mkdir(join(RUNTIME, 'dsh'), { recursive: true })
  await cp(STAGE, join(RUNTIME, 'dsh'), { recursive: true })

  if (!values['skip-download']) {
    await mkdir(CACHE, { recursive: true })
    const nodeTar = join(CACHE, 'node.tar.gz')
    const pnpmTar = join(CACHE, 'pnpm.tgz')
    const pythonTar = join(CACHE, 'python.tar.gz')
    const gitTar = join(CACHE, 'git.tar.gz')
    await download(lock.node.url, nodeTar, lock.node.sha256)
    await download(lock.pnpm.url, pnpmTar, lock.pnpm.sha256)
    await download(lock.python.url, pythonTar, lock.python.sha256)
    await download(lock.git.url, gitTar, lock.git.sha256)
    await extractTar(nodeTar, join(RUNTIME, 'node'), lock.node.strip)
    await extractTar(pnpmTar, join(RUNTIME, 'pnpm'), lock.pnpm.strip)
    await extractTar(pythonTar, join(RUNTIME, 'python'), lock.python.strip)
    await extractTar(gitTar, join(RUNTIME, 'git'), lock.git.strip)
  }

  writeWrapper(join(RUNTIME, 'bin', 'dsh'), dshWrapper())
  writeWrapper(join(RUNTIME, 'bin', 'pnpm'), pnpmWrapper())
  const nodeBin = join(RUNTIME, 'node', 'bin', 'node')
  if (existsSync(nodeBin)) {
    writeWrapper(join(RUNTIME, 'bin', 'node'), `#!/bin/sh\nexec "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)/node/bin/node" "$@"\n`)
  }
  writePackagedStamp()
  await chmodSpawnHelpers()
  await assertRuntime()
  console.log(`build-runtime: ready at ${RUNTIME}`)
}

await main()
