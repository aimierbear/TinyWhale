import { describe, expect, it, vi } from 'vitest'
import { resolveUpdateConfig } from '../src/checkout.ts'
import { TINYWHALE_UPDATE_APPLY } from '../src/types.ts'

vi.mock('../src/checkout.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkout.ts')>()
  return {
    ...actual,
    applyTinyWhaleUpdate: vi.fn(async () => ({ outcome: 'already-current' as const })),
  }
})

describe('dispatchTinyWhaleUpdate apply', () => {
  it('forwards apply to the checkout helper', async () => {
    const { applyTinyWhaleUpdate } = await import('../src/checkout.ts')
    const { dispatchTinyWhaleUpdate } = await import('../src/index.ts')
    const result = await dispatchTinyWhaleUpdate(
      TINYWHALE_UPDATE_APPLY,
      '/tmp/tinywhale-missing-checkout',
      resolveUpdateConfig(),
      new AbortController().signal,
    )
    expect(applyTinyWhaleUpdate).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, value: { outcome: 'already-current' } })
  })
})
