/**
 * Stamp a release .app as packaged so it starts the bundled runtime.
 * Usage: node scripts/write-packaged-stamp.mjs [dest.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))
const dest = process.argv[2] ?? join(desktopRoot, 'tinywhale-packaged.json')
const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version
writeFileSync(dest, `${JSON.stringify({
  mode: 'packaged',
  version,
  releaseUrl: 'https://github.com/aimierbear/TinyWhale/releases',
}, null, 2)}\n`)
process.stdout.write(`${dest}\n`)
