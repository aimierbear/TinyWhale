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
import { isTinyWhaleOverlayPath, TINYWHALE_OVERLAY_PATHS, overlayGitPath } from './overlay.ts'

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
const OVERLAY_FAST_FORWARD_MESSAGE = 'chore(tinywhale): keep overlay after upstream fast-forward'

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
  env: NodeJS.ProcessEnv = process.env,
): TinyWhaleUpdateStatus {
  if (env.TINYWHALE_PACKAGED === '1') {
    const releaseUrl = env.TINYWHALE_RELEASE_URL !== undefined && env.TINYWHALE_RELEASE_URL !== ''
      ? env.TINYWHALE_RELEASE_URL
      : 'https://github.com/aimierbear/TinyWhale/releases'
    return {
      available: true,
      channel: 'packaged',
      ...(env.TINYWHALE_VERSION === undefined || env.TINYWHALE_VERSION === ''
        ? {}
        : { version: env.TINYWHALE_VERSION }),
      releaseUrl,
      remoteName: config.remoteName,
      remoteUrl: config.remoteUrl,
      branch: config.branch,
    }
  }
  const candidates = [startPath, ...extraPaths]
  for (const candidate of candidates) {
    const root = findTinyWhaleRoot(candidate)
    if (root !== undefined && existsSync(join(root, '.git'))) {
      return {
        available: true,
        channel: 'checkout',
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
 * After the merge, restore {@link TINYWHALE_OVERLAY_PATHS} from the pre-merge
 * HEAD so branding files stay TinyWhale even when only upstream edited them.
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<TinyWhaleUpdateApplyResult> {
  if (applying) return { outcome: 'refused-busy' }
  const status = describeTinyWhaleCheckout(startPath, config, extraPaths, env)
  if (status.channel === 'packaged') {
    return status.releaseUrl === undefined || status.releaseUrl === ''
      ? { outcome: 'manual' }
      : { outcome: 'manual', detail: status.releaseUrl }
  }
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
    const merged = await mergeUpstreamKeepingOverlay(run, root, ref, before, signal)
    if (merged !== undefined) return merged

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

/**
 * Merge `ref`, restore TinyWhale overlay paths from `before`, and finish the
 * commit. Overlay-only conflicts keep ours; any other unmerged path aborts.
 * @param run - Git runner.
 * @param root - Checkout root.
 * @param ref - Remote-tracking ref to merge.
 * @param before - Pre-merge HEAD.
 * @param signal - RPC cancellation.
 * @returns a closed failure when the merge cannot finish, otherwise undefined.
 */
async function mergeUpstreamKeepingOverlay(
  run: NativeCommandRunner,
  root: string,
  ref: string,
  before: string,
  signal: AbortSignal,
): Promise<TinyWhaleUpdateApplyResult | undefined> {
  let mergeError: unknown
  try {
    await gitText(run, root, ['merge', '--no-commit', '--no-edit', ref], signal)
  } catch (error) {
    mergeError = error
  }
  const merging = await gitOk(run, root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], signal)
  if (mergeError !== undefined && !merging) return classifyMergeFailure(mergeError)

  const overlay = await overlayPathsInTree(run, root, before, signal)
  const overlayFiles = overlay.filter(entry => !entry.directory).map(entry => entry.gitPath)
  const overlayDirs = overlay.filter(entry => entry.directory).map(entry => entry.gitPath)
  if (overlayFiles.length > 0) {
    await gitText(run, root, ['checkout', before, '--', ...overlayFiles], signal)
  }
  if (overlayDirs.length > 0) {
    await gitText(run, root, ['checkout', '--no-overlay', before, '--', ...overlayDirs], signal)
  }
  const unmerged = (await gitText(run, root, ['diff', '--name-only', '--diff-filter=U'], signal))
    .split('\n')
    .filter(path => path !== '')
  const leftover = unmerged.filter(path => !isTinyWhaleOverlayPath(path))
  if (leftover.length > 0) {
    await gitOk(run, root, ['merge', '--abort'], signal)
    return classifyMergeFailure(mergeError ?? new Error(`CONFLICT ${leftover.join(' ')}`))
  }
  if (unmerged.length > 0) {
    await gitText(run, root, ['checkout', '--ours', '--', ...unmerged], signal)
    await gitText(run, root, ['add', '--', ...unmerged], signal)
  }
  if (merging) {
    await gitText(run, root, ['commit', '--no-edit'], signal)
    return undefined
  }
  const dirty = await gitText(run, root, ['status', '--porcelain'], signal)
  if (dirty !== '') {
    await gitText(run, root, ['commit', '-m', OVERLAY_FAST_FORWARD_MESSAGE], signal)
  }
  return undefined
}

async function overlayPathsInTree(
  run: NativeCommandRunner,
  root: string,
  tree: string,
  signal: AbortSignal,
): Promise<{ gitPath: string; directory: boolean }[]> {
  const present: { gitPath: string; directory: boolean }[] = []
  for (const entry of TINYWHALE_OVERLAY_PATHS) {
    const gitPath = overlayGitPath(entry)
    if (await gitOk(run, root, ['cat-file', '-e', `${tree}:${gitPath}`], signal)) {
      present.push({ gitPath, directory: entry.endsWith('/') })
    }
  }
  return present
}

function classifyMergeFailure(error: unknown): TinyWhaleUpdateApplyResult {
  const text = `${messageOf(error)}\n${stdoutOf(error)}\n${stderrOf(error)}`
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

function streamOf(error: unknown, key: 'stdout' | 'stderr'): string {
  if (typeof error === 'object' && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : ''
  }
  return ''
}

function stdoutOf(error: unknown): string {
  return streamOf(error, 'stdout')
}

function stderrOf(error: unknown): string {
  return streamOf(error, 'stderr')
}

function truncate(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`
}
