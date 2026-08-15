/**
 * Finder-launched Mac apps inherit a tiny PATH. Prepend the directories where
 * this machine's Node / dsh usually live so the packaged app can start the
 * harness the same way a terminal can. A release .app prepends its bundled
 * runtime bins instead of guessing Homebrew.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { packagedPathExtras, resolvePackagedRuntimeRoot } from './packaged.mjs'

/**
 * @param {string} [home]
 * @returns {string[]}
 */
export function guiPathExtras(home = homedir(), runtimeRoot = resolvePackagedRuntimeRoot()) {
  if (runtimeRoot !== undefined) return packagedPathExtras(runtimeRoot)
  return [
    join(home, '.hermes/node/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/node/bin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.nvm/current/bin'),
  ].filter(dir => existsSync(dir))
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function enrichPath(env = process.env, home = homedir(), runtimeRoot = resolvePackagedRuntimeRoot()) {
  const current = env.PATH ?? env.Path ?? ''
  const parts = [...guiPathExtras(home, runtimeRoot), ...current.split(delimiter).filter(Boolean)]
  return [...new Set(parts)].join(delimiter)
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithGuiPath(env = process.env, home = homedir(), runtimeRoot = resolvePackagedRuntimeRoot()) {
  return { ...env, PATH: enrichPath(env, home, runtimeRoot) }
}

/**
 * @param {string} [home]
 * @returns {string | undefined}
 */
export function knownDshBin(home = homedir()) {
  const candidates = [
    join(home, '.hermes/node/bin/dsh'),
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
  ]
  return candidates.find(path => existsSync(path))
}
