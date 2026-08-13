/**
 * Resolve a real Node.js executable.
 *
 * Electron's `process.execPath` is the Electron binary, not Node. Spawning it
 * without ELECTRON_RUN_AS_NODE starts another GUI instance.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isElectronBinary(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  return /(?:^|\/)electron(?:\.exe)?$/i.test(normalized)
    || /Electron\.app\//.test(normalized)
    || /[/]electron[/]/i.test(normalized)
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [execPath]
 * @returns {string}
 */
export function resolveNodeExecutable(env = process.env, execPath = process.execPath) {
  const candidates = [
    env.TINYWHALE_NODE_EXECUTABLE,
    env.npm_node_execpath,
    env.NODE,
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && !isElectronBinary(candidate)) {
      return candidate
    }
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate) && !isElectronBinary(candidate)) {
        return candidate
      }
    }
  }

  if (!isElectronBinary(execPath) && existsSync(execPath)) {
    return execPath
  }

  throw new Error(
    'Cannot find a real Node.js executable. Set TINYWHALE_NODE_EXECUTABLE to a node binary.',
  )
}
