/**
 * Locate the TinyWhale git checkout and merge the configured upstream remote.
 * @module @deepseek-ai/dsh-client-ui-settings-update
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import type { TinyWhaleUpdateApplyResult, TinyWhaleUpdateStatus } from './types.ts'
import {
  DEFAULT_UPSTREAM_BRANCH, DEFAULT_UPSTREAM_REMOTE, DEFAULT_UPSTREAM_URL,
} from './types.ts'

/** Resolved Host config for one checkout. */
export interface TinyWhaleUpdateConfig {
  /** Git remote name fetched and merged. */
  remoteName: string
  /** URL used when {@link TinyWhaleUpdateConfig.remoteName} is absent. */
  remoteUrl: string
  /** Branch name on that remote. */
  branch: string
}

/** Injectable command runners for git and the lockfile installer. */
export interface TinyWhaleUpdateCommands {
  /** Run one argv against a host executable. */
  run: NativeCommandRunner
  /** Install workspace dependencies after a lockfile-changing merge. */
  install: (root: string, signal: AbortSignal) => Promise<void>
}

const FETCH_MS = 120_000
const INSTALL_MS = 300_000
const MARKER = 'TINYWHALE.md'
const LOCKFILE = 'pnpm-lock.yaml'

/**
 * Walk parents of `startPath` until `TINYWHALE.md` is found.
 * @param startPath - a file or directory inside the candidate tree.
 * @returns the directory that owns the marker, or undefined.
 */
export function findTinyWhaleRoot(startPath: string): string | undefined {
  let dir = startPath
  for (;;) {
    if (existsSync(join(dir, MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Fill config defaults used when the plugin row omits a field.
 * @param config - partial Host config.
 * @returns every field populated.
 */
export function resolveUpdateConfig(config?: Partial<TinyWhaleUpdateConfig>): TinyWhaleUpdateConfig {
  return {
    remoteName: config?.remoteName ?? DEFAULT_UPSTREAM_REMOTE,
    remoteUrl: config?.remoteUrl ?? DEFAULT_UPSTREAM_URL,
    branch: config?.branch ?? DEFAULT_UPSTREAM_BRANCH,
  }
}

/**
 * Report whether this process can run an upstream merge.
 * @param startPath - discovery start (the Host plugin module path).
 * @param config - resolved remote/branch.
 * @param extraPaths - additional discovery starts, typically `process.cwd()`.
 * @returns availability plus the remote the next apply will use.
 */
export function describeTinyWhaleCheckout(
  startPath: string,
  config: TinyWhaleUpdateConfig,
  extraPaths: readonly string[] = [],
): TinyWhaleUpdateStatus {
  const candidates = [startPath, ...extraPaths]
  for (const candidate of candidates) {
    const root = findTinyWhaleRoot(candidate)
    if (root !== undefined && existsSync(join(root, '.git'))) {
      return {
        available: true,
        root,
        remoteName: config.remoteName,
        remoteUrl: config.remoteUrl,
        branch: config.branch,
      }
    }
  }
  return {
    available: false,
    remoteName: config.remoteName,
    remoteUrl: config.remoteUrl,
    branch: config.branch,
  }
}

let applying = false

/**
 * Fetch the configured upstream remote and merge it into the current branch.
 * @param startPath - discovery start (the Host plugin module path).
 * @param config - resolved remote/branch.
 * @param signal - RPC cancellation.
 * @param commands - optional git/install runners.
 * @param extraPaths - additional discovery starts, typically `process.cwd()`.
 * @returns a closed outcome the Settings row localizes.
 */
export async function applyTinyWhaleUpdate(
  startPath: string,
  config: TinyWhaleUpdateConfig,
  signal: AbortSignal,
  commands: TinyWhaleUpdateCommands = defaultCommands(),
  extraPaths: readonly string[] = [],
): Promise<TinyWhaleUpdateApplyResult> {
  if (applying) return { outcome: 'refused-busy' }
  const status = describeTinyWhaleCheckout(startPath, config, extraPaths)
  if (!status.available || status.root === undefined) {
    return { outcome: 'refused-unavailable' }
  }
  applying = true
  const root = status.root
  const run = commands.run
  try {
    if (!await gitOk(run, root, ['symbolic-ref', '-q', 'HEAD'], signal)) {
      return { outcome: 'refused-detached' }
    }
    const dirty = await gitText(run, root, ['status', '--porcelain'], signal)
    if (dirty !== '') return { outcome: 'refused-dirty' }

    await ensureRemote(run, root, config, signal)
    await gitText(run, root, ['fetch', config.remoteName], withTimeout(signal, FETCH_MS))
    const ref = await resolveRemoteRef(run, root, config, signal)
    if (await gitOk(run, root, ['merge-base', '--is-ancestor', ref, 'HEAD'], signal)) {
      return { outcome: 'already-current' }
    }

    const before = await gitText(run, root, ['rev-parse', 'HEAD'], signal)
    try {
      await gitText(run, root, ['merge', '--no-edit', ref], signal)
    } catch (error) {
      await gitOk(run, root, ['merge', '--abort'], signal)
      return classifyMergeFailure(error)
    }

    const changed = await gitText(run, root, ['diff', '--name-only', before, 'HEAD'], signal)
    if (!changed.split('\n').includes(LOCKFILE)) {
      return { outcome: 'updated', installed: false }
    }
    try {
      await commands.install(root, withTimeout(signal, INSTALL_MS))
      return { outcome: 'updated', installed: true }
    } catch (error) {
      return {
        outcome: 'updated',
        installed: false,
        detail: truncate(messageOf(error)),
      }
    }
  } catch (error) {
    return { outcome: 'failed', detail: truncate(messageOf(error)) }
  } finally {
    applying = false
  }
}

/**
 * Default git + pnpm runners.
 * @returns `runNativeCommand` plus `pnpm --dir <root> install`.
 */
export function defaultCommands(): TinyWhaleUpdateCommands {
  return {
    run: runNativeCommand,
    install: async (root, signal) => {
      await runNativeCommand('pnpm', ['--dir', root, 'install'], signal)
    },
  }
}

async function ensureRemote(
  run: NativeCommandRunner,
  root: string,
  config: TinyWhaleUpdateConfig,
  signal: AbortSignal,
): Promise<void> {
  if (await gitOk(run, root, ['remote', 'get-url', config.remoteName], signal)) return
  await gitText(run, root, ['remote', 'add', config.remoteName, config.remoteUrl], signal)
}

async function resolveRemoteRef(
  run: NativeCommandRunner,
  root: string,
  config: TinyWhaleUpdateConfig,
  signal: AbortSignal,
): Promise<string> {
  const named = `${config.remoteName}/${config.branch}`
  if (await gitOk(run, root, ['rev-parse', '--verify', named], signal)) return named
  const head = await gitText(run, root, ['symbolic-ref', '--quiet', `refs/remotes/${config.remoteName}/HEAD`], signal)
  const prefix = 'refs/remotes/'
  if (head.startsWith(prefix)) return head.slice(prefix.length)
  throw new Error(`upstream branch ${named} is missing`)
}

function classifyMergeFailure(error: unknown): TinyWhaleUpdateApplyResult {
  const text = `${messageOf(error)}\n${stderrOf(error)}`
  if (/CONFLICT|Automatic merge failed/i.test(text)) {
    return { outcome: 'conflict', detail: truncate(text) }
  }
  return { outcome: 'failed', detail: truncate(text) }
}

async function gitText(
  run: NativeCommandRunner,
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], signal)
  return stdout.trim()
}

async function gitOk(
  run: NativeCommandRunner,
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await gitText(run, root, args, signal)
    return true
  } catch {
    return false
  }
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stderrOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    return typeof stderr === 'string' ? stderr : ''
  }
  return ''
}

function truncate(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`
}
