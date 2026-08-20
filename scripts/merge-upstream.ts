/**
 * Merge the configured upstream remote with TinyWhale overlay restore.
 * Same path as Settings → General → Software update on a git checkout.
 */
import {
  applyTinyWhaleUpdate, resolveUpdateConfig,
} from '../packages/client/ui-settings-update/src/checkout.ts'

const result = await applyTinyWhaleUpdate(
  process.cwd(),
  resolveUpdateConfig(),
  AbortSignal.timeout(300_000),
)
console.log(result)
if (result.outcome !== 'updated' && result.outcome !== 'already-current') {
  process.exitCode = 1
}
