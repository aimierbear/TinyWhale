/**
 * Locate and start the local harness Web UI, or attach when it is already up.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { envWithGuiPath, knownDshBin } from './gui-path.mjs'
import { envForPackagedRuntime, resolvePackagedRuntimeRoot } from './packaged.mjs'
import { resolveNodeExecutable } from './resolve-node.mjs'

const desktopRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))

/**
 * @param {string} root
 */
export function isTinyWhaleCheckout(root) {
  return existsSync(join(root, 'TINYWHALE.md')) && existsSync(join(root, 'apps/cli/src/bin.ts'))
}

/**
 * @param {string} file
 * @returns {string | undefined}
 */
function repoRootFromStamp(file) {
  if (!existsSync(file)) return undefined
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof data.repoRoot === 'string' && isTinyWhaleCheckout(data.repoRoot)) {
      return data.repoRoot
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Resolve the TinyWhale git checkout. A packed .app does not live inside the
 * monorepo, so install:dev stamps `tinywhale-checkout.json` into Resources.
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string }} [options]
 */
export function resolveRepoRoot(options = {}) {
  if (options.repoRoot !== undefined) return options.repoRoot
  const env = options.env ?? process.env
  const fromEnv = env.TINYWHALE_REPO
  if (typeof fromEnv === 'string' && fromEnv !== '' && isTinyWhaleCheckout(fromEnv)) {
    return fromEnv
  }
  const resources = typeof process.resourcesPath === 'string' && process.resourcesPath !== ''
    ? process.resourcesPath
    : undefined
  const stampCandidates = [
    resources === undefined ? undefined : join(resources, 'tinywhale-checkout.json'),
    join(dirname(desktopRoot), 'tinywhale-checkout.json'),
    join(desktopRoot, 'tinywhale-checkout.json'),
  ]
  for (const file of stampCandidates) {
    if (file === undefined) continue
    const recorded = repoRootFromStamp(file)
    if (recorded !== undefined) return recorded
  }
  return dirname(desktopRoot)
}

export const repoRoot = dirname(desktopRoot)

export const DEFAULT_PORT = 3080
export const DEFAULT_HOST = '127.0.0.1'

/**
 * @param {number} port
 * @param {string} [host]
 */
export function harnessUrl(port, host = DEFAULT_HOST) {
  return `http://${host}:${port}/`
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function isHttpReady(url, timeoutMs = 800) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * True when this origin serves the TinyWhale update channel.
 * A published DeepSeek `dsh web` on the same port returns 404.
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function isTinyWhaleUpdateReady(url, timeoutMs = 800) {
  try {
    const response = await fetch(new URL('/tinywhale/status', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'tinywhale-probe',
        method: 'status',
        payload: {},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.result?.ok === true && typeof body?.result?.value?.available === 'boolean'
  } catch {
    return false
  }
}

/**
 * @param {string} host
 * @param {number} start
 */
export async function findFreeHarnessPort(host, start) {
  for (let port = start; port < start + 20; port++) {
    if (!await isHttpReady(harnessUrl(port, host), 200)) return port
  }
  throw new Error(`No free TinyWhale port after ${String(start)}`)
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 200
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ''}`)
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findOnPath(name, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? ''
  const names = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name]
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const fileName of names) {
      const candidate = join(dir, fileName)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string, home?: string }} [options]
 * @returns {{ command: string, args: string[], cwd: string }}
 */
export function resolveHarnessLaunch(options = {}) {
  const home = options.home ?? homedir()
  const runtimeRoot = options.runtimeRoot ?? resolvePackagedRuntimeRoot()
  const env = envWithGuiPath(options.env ?? process.env, home, runtimeRoot)
  const root = options.repoRoot ?? resolveRepoRoot({ env })
  const explicit = env.TINYWHALE_DSH_BIN
  if (explicit) {
    return { command: explicit, args: [], cwd: runtimeRoot === undefined ? root : home }
  }

  // A published `dsh` on PATH is DeepSeek Harness, not this checkout.
  // Prefer the source CLI so TinyWhale-only plugins (Settings → Update) load.
  const sourceBin = join(root, 'apps/cli/src/bin.ts')
  if (existsSync(join(root, 'TINYWHALE.md')) && existsSync(sourceBin)) {
    const node = resolveNodeExecutable(env)
    return {
      command: node,
      args: ['--import', 'tsx/esm', sourceBin],
      cwd: root,
    }
  }

  if (runtimeRoot !== undefined) {
    return {
      command: join(runtimeRoot, 'bin', 'dsh'),
      args: [],
      cwd: home,
    }
  }

  const onPath = findOnPath('dsh', env)
  if (onPath) {
    return { command: onPath, args: [], cwd: root }
  }

  const known = knownDshBin(home)
  if (known) {
    return { command: known, args: [], cwd: root }
  }

  if (existsSync(sourceBin)) {
    const node = resolveNodeExecutable(env)
    return {
      command: node,
      args: ['--import', 'tsx/esm', sourceBin],
      cwd: root,
    }
  }

  throw new Error(
    'Cannot find the harness CLI. This TinyWhale install is missing its bundled runtime. Reinstall the app, or set TINYWHALE_DSH_BIN.',
  )
}

/**
 * Whether an already-listening origin is this product's Web UI.
 * A packaged or checkout app must not attach to a random HTTP 200.
 * @param {{ attachOnly: boolean, checkout: boolean, packaged: boolean, tinywhaleReady: boolean }} state
 */
export function shouldAttachToReadyOrigin(state) {
  if (state.attachOnly || state.tinywhaleReady) return true
  return !state.checkout && !state.packaged
}

export function stopHarness(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   env?: NodeJS.ProcessEnv,
 *   repoRoot?: string,
 *   attachOnly?: boolean,
 * }} [options]
 */
export async function attachOrStartHarness(options = {}) {
  const runtimeRoot = options.runtimeRoot ?? resolvePackagedRuntimeRoot()
  const baseEnv = options.env ?? process.env
  const env = runtimeRoot === undefined
    ? envWithGuiPath(baseEnv)
    : envForPackagedRuntime(runtimeRoot, envWithGuiPath(baseEnv, undefined, runtimeRoot))
  let port = Number(env.TINYWHALE_PORT ?? options.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid TinyWhale port: ${String(env.TINYWHALE_PORT ?? options.port)}`)
  }
  const host = options.host ?? DEFAULT_HOST
  const root = options.repoRoot ?? resolveRepoRoot({ env })
  let url = harnessUrl(port, host)
  if (await isHttpReady(url)) {
    const checkout = isTinyWhaleCheckout(root)
    const packaged = runtimeRoot !== undefined
    const tinywhaleReady = await isTinyWhaleUpdateReady(url)
    if (shouldAttachToReadyOrigin({
      attachOnly: options.attachOnly === true,
      checkout,
      packaged,
      tinywhaleReady,
    })) {
      return { url, port, child: undefined, attached: true }
    }
    port = await findFreeHarnessPort(host, port + 1)
    url = harnessUrl(port, host)
  }
  if (options.attachOnly) {
    throw new Error(`Nothing is serving ${url}, and attach-only mode will not start dsh.`)
  }

  const launch = resolveHarnessLaunch({ env, repoRoot: root, home: options.home, runtimeRoot })
  const child = spawn(launch.command, [...launch.args, 'web', '--port', String(port)], {
    cwd: launch.cwd,
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const stderrChunks = []
  child.stderr?.on('data', chunk => {
    stderrChunks.push(chunk)
  })

  const earlyExit = new Promise((_, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      const detail = Buffer.concat(stderrChunks).toString('utf8').trim()
      reject(new Error(
        `Harness exited before the Web UI was ready (code=${String(code)} signal=${String(signal)})${detail ? `\n${detail}` : ''}`,
      ))
    })
  })

  try {
    await Promise.race([waitForHttp(url), earlyExit])
  } catch (error) {
    stopHarness(child)
    throw error
  }

  child.removeAllListeners('exit')
  child.removeAllListeners('error')
  return { url, port, child, attached: false }
}
