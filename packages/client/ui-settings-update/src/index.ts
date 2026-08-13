/**
 * Host half: loopback `/tinywhale` RPC that merges DeepSeek Harness into this
 * TinyWhale checkout. The browser half lives in `./client`.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import {
  applyTinyWhaleUpdate, describeTinyWhaleCheckout, resolveUpdateConfig,
  type TinyWhaleUpdateConfig,
} from './checkout.ts'
import {
  TINYWHALE_UPDATE_APPLY, TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_STATUS,
} from './types.ts'

/** Connection must exist before the dedicated loopback channel is registered. */
export const inject = ['connection']

/** Remote and branch merged by the Settings Update row. */
export interface Config extends TinyWhaleUpdateConfig {}

/** Host config: remote name/URL and branch, all overridable from cordis.yml. */
export const Config: z<Config> = z.object({
  remoteName: z.string().default('upstream'),
  remoteUrl: z.string().default('https://github.com/deepseek-ai/deepseek-harness.git'),
  branch: z.string().default('master'),
})

/**
 * Register the loopback update channel on Connection.
 * @param ctx - Host context that already provides `connection`.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Partial<Config>): void {
  const resolved = resolveUpdateConfig(config)
  const startPath = fileURLToPath(import.meta.url)
  const connection = ctx.get('connection') as {
    rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => ReturnType<typeof dispatchTinyWhaleUpdate>,
        options: { authority: 'loopback' },
      ): unknown
    }
  }
  connection.rpc.handle(
    TINYWHALE_UPDATE_CHANNEL,
    (endpoint, _payload, signal) => dispatchTinyWhaleUpdate(endpoint, startPath, resolved, signal),
    { authority: 'loopback' },
  )
}

/**
 * Dispatch one `/tinywhale` endpoint against a checkout discovery path.
 * @param endpoint - `status` or `apply`.
 * @param startPath - module or directory used to find `TINYWHALE.md`.
 * @param config - resolved remote/branch.
 * @param signal - RPC cancellation for apply.
 * @returns the Connection RPC result.
 */
export async function dispatchTinyWhaleUpdate(
  endpoint: string,
  startPath: string,
  config: TinyWhaleUpdateConfig,
  signal: AbortSignal,
): Promise<
  | { ok: true; value: ReturnType<typeof describeTinyWhaleCheckout> | Awaited<ReturnType<typeof applyTinyWhaleUpdate>> }
  | { ok: false; error: { code: 'internal'; message: string; details: Record<string, never> } }
> {
  if (endpoint === TINYWHALE_UPDATE_STATUS) {
    return { ok: true, value: describeTinyWhaleCheckout(startPath, config, [process.cwd()]) }
  }
  if (endpoint !== TINYWHALE_UPDATE_APPLY) {
    return {
      ok: false,
      error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
    }
  }
  return { ok: true, value: await applyTinyWhaleUpdate(startPath, config, signal, undefined, [process.cwd()]) }
}
