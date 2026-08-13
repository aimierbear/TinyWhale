/**
 * Finder-launched Mac apps inherit a tiny PATH. Prepend the directories where
 * this machine's Node / dsh usually live so the packaged app can start the
 * harness the same way a terminal can.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * @param {string} [home]
 * @returns {string[]}
 */
export function guiPathExtras(home = homedir()) {
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
export function enrichPath(env = process.env, home = homedir()) {
  const current = env.PATH ?? env.Path ?? ''
  const parts = [...guiPathExtras(home), ...current.split(delimiter).filter(Boolean)]
  return [...new Set(parts)].join(delimiter)
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithGuiPath(env = process.env, home = homedir()) {
  return { ...env, PATH: enrichPath(env, home) }
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
