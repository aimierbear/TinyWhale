/**
 * electron-builder fails when extraResources.from is missing. Dev `pack`
 * only needs a placeholder; `dist` replaces it with the real runtime.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))
const runtime = join(desktopRoot, 'runtime')
if (!existsSync(join(runtime, 'bin', 'dsh'))) {
  mkdirSync(runtime, { recursive: true })
  writeFileSync(
    join(runtime, 'README.txt'),
    'Placeholder. Run `npm run build:runtime` (or `npm run dist`) to assemble the bundled harness.\n',
  )
}
