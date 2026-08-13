/**
 * Browser half: loopback General-settings row that asks the Host to merge
 * DeepSeek Harness into this TinyWhale checkout.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TinyWhaleUpdateApplyResult, TinyWhaleUpdateStatus } from '../types.ts'
import {
  TINYWHALE_UPDATE_APPLY, TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_STATUS,
} from '../types.ts'
import { UpdateRow, type UpdateRowInjected } from './UpdateRow.tsx'
import { en, zh, type UpdateSettingsKey } from './locales.ts'

export type { UpdateRowInjected, UpdateRowProps } from './UpdateRow.tsx'
export type { UpdateSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Update row copy. */
    'settings.update': UpdateSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.update'

/** Slot, locale, and loopback Connection used by the Settings row. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the Update row on loopback browsers only.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  if (!connection.isLoopback) return

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-update: dictionaries')

  const load = async (): Promise<TinyWhaleUpdateStatus> => {
    const result = await connection.rpc.call(TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_STATUS, {})
    if (!result.ok) throw new Error(result.error.message)
    return result.value as TinyWhaleUpdateStatus
  }
  const applyUpdate = async (): Promise<TinyWhaleUpdateApplyResult> => {
    const result = await connection.rpc.call(TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_APPLY, {})
    if (!result.ok) throw new Error(result.error.message)
    return result.value as TinyWhaleUpdateApplyResult
  }
  const injected = (): UpdateRowInjected => ({ load, apply: applyUpdate })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'tinywhale-update',
    order: 100,
    locale: NS,
    inject: injected,
  }, UpdateRow))
}
