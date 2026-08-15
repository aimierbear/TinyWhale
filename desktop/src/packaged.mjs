/**
 * Packaged-install detection. A release .app vendors `runtime/bin/dsh` and
 * `runtime/node`. The JSON stamp is version metadata, not the only signal.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * @param {string} file
 * @returns {{ version?: string, releaseUrl?: string } | undefined}
 */
function readStampFile(file) {
  if (!existsSync(file)) return undefined
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data?.mode !== 'packaged') return undefined
    return {
      version: typeof data.version === 'string' ? data.version : undefined,
      releaseUrl: typeof data.releaseUrl === 'string' ? data.releaseUrl : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * @param {string} [resourcesPath]
 * @returns {{ version?: string, releaseUrl?: string } | undefined}
 */
export function readPackagedStamp(resourcesPath = process.resourcesPath) {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return undefined
  return readStampFile(join(resourcesPath, 'tinywhale-packaged.json'))
    ?? readStampFile(join(resourcesPath, 'runtime', 'packaged.json'))
}

/**
 * A complete bundled runtime is the packaged-install signal. A leftover
 * stamp next to a placeholder `runtime/README.txt` is not enough.
 * @param {string} [resourcesPath]
 * @returns {string | undefined}
 */
export function resolvePackagedRuntimeRoot(resourcesPath = process.resourcesPath) {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return undefined
  const runtime = join(resourcesPath, 'runtime')
  if (!existsSync(join(runtime, 'bin', 'dsh'))) return undefined
  if (!existsSync(join(runtime, 'node', 'bin', 'node'))) return undefined
  return runtime
}

/**
 * Gatekeeper translocation or a DMG volume copy. Do not match
 * `/Volumes/Macintosh HD/Applications/TinyWhale.app`.
 * @param {string} [execPath]
 */
export function isTranslocatedApp(execPath = process.execPath) {
  const normalized = execPath.replaceAll('\\', '/')
  return normalized.includes('/AppTranslocation/')
    || /\/Volumes\/[^/]+\/TinyWhale\.app\//.test(normalized)
}

/**
 * Directories the packaged dsh wrapper and child processes must see first.
 * @param {string} runtimeRoot
 * @returns {string[]}
 */
export function packagedPathExtras(runtimeRoot) {
  return [
    join(runtimeRoot, 'bin'),
    join(runtimeRoot, 'node', 'bin'),
    join(runtimeRoot, 'git', 'bin'),
  ].filter(dir => existsSync(dir))
}

/**
 * @param {string} runtimeRoot
 * @returns {{ version?: string, releaseUrl?: string } | undefined}
 */
export function readStampFromRuntime(runtimeRoot) {
  return readStampFile(join(runtimeRoot, 'packaged.json'))
    ?? readStampFile(join(dirname(runtimeRoot), 'tinywhale-packaged.json'))
}

/**
 * @param {string} runtimeRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function envForPackagedRuntime(runtimeRoot, env = process.env) {
  const extras = packagedPathExtras(runtimeRoot)
  const current = env.PATH ?? env.Path ?? ''
  const path = [...new Set([...extras, ...current.split(delimiter).filter(Boolean)])].join(delimiter)
  const python = [
    join(runtimeRoot, 'python', 'bin', 'python3'),
    join(runtimeRoot, 'python', 'bin', 'python'),
  ].find(file => existsSync(file))
  const spawnHelperCandidates = [
    join(runtimeRoot, 'dsh', 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(
      runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local',
      'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper',
    ),
  ]
  const spawnHelper = spawnHelperCandidates.find(file => existsSync(file))
  const stamp = readStampFromRuntime(runtimeRoot)
  return {
    ...env,
    PATH: path,
    TINYWHALE_PACKAGED: '1',
    TINYWHALE_NODE_EXECUTABLE: join(runtimeRoot, 'node', 'bin', 'node'),
    TINYWHALE_DSH_BIN: join(runtimeRoot, 'bin', 'dsh'),
    TINYWHALE_PNPM: join(runtimeRoot, 'bin', 'pnpm'),
    TINYWHALE_HOME: env.TINYWHALE_HOME ?? homedir(),
    ...(stamp?.version === undefined ? {} : { TINYWHALE_VERSION: stamp.version }),
    ...(stamp?.releaseUrl === undefined ? {} : { TINYWHALE_RELEASE_URL: stamp.releaseUrl }),
    ...(python === undefined ? {} : { FRACTAL_PYTHON: python, TINYWHALE_PYTHON: python }),
    ...(spawnHelper === undefined ? {} : { DSH_NODE_PTY_SPAWN_HELPER: spawnHelper }),
  }
}
