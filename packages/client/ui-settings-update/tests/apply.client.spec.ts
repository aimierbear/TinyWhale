import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { UpdateRow } from '../src/client/UpdateRow.tsx'
import type { UpdateRowInjected } from '../src/client/UpdateRow.tsx'
import { TINYWHALE_UPDATE_APPLY, TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_STATUS } from '../src/types.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(() => {
  vi.unstubAllGlobals()
})

const SLOT = 'settings.general.item'

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  // Non-jsdom lanes never see navigator.languages; LocaleRuntime now opens on
  // English unless the test stages zh explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const call = vi.fn(async (channel: string, endpoint: string) => {
    expect(channel).toBe(TINYWHALE_UPDATE_CHANNEL)
    if (endpoint === TINYWHALE_UPDATE_STATUS) {
      return { ok: true as const, value: { available: true, remoteName: 'upstream', remoteUrl: 'u', branch: 'master' } }
    }
    if (endpoint === TINYWHALE_UPDATE_APPLY) {
      return { ok: true as const, value: { outcome: 'updated' as const } }
    }
    return { ok: false as const, error: { code: 'internal', message: endpoint, details: {} } }
  })
  ctx.provide('connection', { isLoopback, rpc: { call } })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, call }
}

function declareItems(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

describe('ui-settings-update browser plugin', () => {
  it('declares the services used by the Settings row', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers a localized loopback row and routes load/apply through the dedicated channel', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.locale.bind(NS)('title')).toBe('软件更新')
    const entry = b.slots.entries(SLOT).find(row => row.component === UpdateRow)!
    expect(entry.options).toMatchObject({ id: 'tinywhale-update', order: 100 })
    const face = (entry.inject as unknown as () => UpdateRowInjected)()
    await expect(face.load()).resolves.toMatchObject({ available: true })
    await expect(face.apply()).resolves.toEqual({ outcome: 'updated' })
    expect(b.call).toHaveBeenCalledWith(TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_STATUS, {})
    expect(b.call).toHaveBeenCalledWith(TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_APPLY, {})
    b.call.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'nope', details: {} } })
    await expect(face.load()).rejects.toThrow('nope')
    b.call.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'apply-down', details: {} } })
    await expect(face.apply()).rejects.toThrow('apply-down')
  })

  it('stays off a non-loopback browser and recovers across late declaration', async () => {
    const remote = await bench(false)
    declareItems(remote.slots)
    await remote.ctx.plugin({ inject: [...inject], apply }).await()
    expect(remote.slots.entries(SLOT)).toHaveLength(0)

    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    const stop = declareItems(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries(SLOT)).toHaveLength(1) })
    stop()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    declareItems(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries(SLOT)[0]?.component).toBe(UpdateRow)
    })
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
  })
})
