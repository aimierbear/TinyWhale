/**
 * Stamp the TinyWhale monorepo path for a packed or installed .app.
 * Usage: node scripts/write-checkout-root.mjs [dest.json]
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))
const repoRoot = dirname(desktopRoot)
const dest = process.argv[2] ?? join(desktopRoot, 'tinywhale-checkout.json')
writeFileSync(dest, `${JSON.stringify({ repoRoot }, null, 2)}\n`)
process.stdout.write(`${dest}\n`)
