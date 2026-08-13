/**
 * Locate and start the local harness Web UI, or attach when it is already up.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNodeExecutable } from './resolve-node.mjs'

const desktopRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))
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
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string }} [options]
 * @returns {{ command: string, args: string[], cwd: string }}
 */
export function resolveHarnessLaunch(options = {}) {
  const env = options.env ?? process.env
  const root = options.repoRoot ?? repoRoot
  const explicit = env.TINYWHALE_DSH_BIN
  if (explicit) {
    return { command: explicit, args: [], cwd: root }
  }

  const onPath = findOnPath('dsh', env)
  if (onPath) {
    return { command: onPath, args: [], cwd: root }
  }

  const sourceBin = join(root, 'apps/cli/src/bin.ts')
  if (existsSync(sourceBin)) {
    const node = resolveNodeExecutable(env)
    return {
      command: node,
      args: ['--import', 'tsx/esm', sourceBin],
      cwd: root,
    }
  }

  throw new Error(
    'Cannot find the harness CLI. Install `dsh` on PATH, or set TINYWHALE_DSH_BIN, or run from a TinyWhale checkout after `pnpm install`.',
  )
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
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
  const env = options.env ?? process.env
  const port = Number(env.TINYWHALE_PORT ?? options.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid TinyWhale port: ${String(env.TINYWHALE_PORT ?? options.port)}`)
  }
  const host = options.host ?? DEFAULT_HOST
  const url = harnessUrl(port, host)
  if (await isHttpReady(url)) {
    return { url, port, child: undefined, attached: true }
  }
  if (options.attachOnly) {
    throw new Error(`Nothing is serving ${url}, and attach-only mode will not start dsh.`)
  }

  const launch = resolveHarnessLaunch({ env, repoRoot: options.repoRoot })
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
