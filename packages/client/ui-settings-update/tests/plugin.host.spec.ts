import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { apply, dispatchTinyWhaleUpdate, inject } from '../src/index.ts'
import { resolveUpdateConfig } from '../src/checkout.ts'
import { TINYWHALE_UPDATE_CHANNEL, TINYWHALE_UPDATE_STATUS } from '../src/types.ts'

const NEVER = new AbortController().signal

function bench() {
  const ctx = new Context()
  let handler: ConnectionRpcHandler | undefined
  let authority: string | undefined
  let channel: string | undefined
  const handle: HostConnectionHandle = {
    rpc: {
      handle(nextChannel, nextHandler, options) {
        channel = nextChannel
        handler = nextHandler
        authority = options.authority
        return async () => {
          handler = undefined
        }
      },
      intercept() {
        throw new Error('unused')
      },
    },
  }
  ctx.provide('connection', handle)
  return { ctx, getHandler: () => handler, getChannel: () => channel, getAuthority: () => authority }
}

describe('ui-settings-update host', () => {
  it('declares the connection inject', () => {
    expect(inject).toEqual(['connection'])
  })

  it('registers a loopback /tinywhale channel and answers status/apply/unknown', async () => {
    const b = await (async () => {
      const next = bench()
      const fiber = next.ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      return { ...next, fiber }
    })()
    expect(b.getChannel()).toBe(TINYWHALE_UPDATE_CHANNEL)
    expect(b.getAuthority()).toBe('loopback')
    const handler = b.getHandler()
    expect(handler).toBeDefined()

    const status = await handler!(TINYWHALE_UPDATE_STATUS, {}, NEVER)
    expect(status.ok).toBe(true)
    if (status.ok) expect(status.value).toMatchObject({ available: true, remoteName: 'upstream' })

    const unknown = await handler!('nope', {}, NEVER)
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'internal', message: 'unknown endpoint nope', details: {} },
    })

    await b.fiber.dispose()
  })

  it('rejects an unknown update endpoint', async () => {
    await expect(dispatchTinyWhaleUpdate('nope', '/tmp/tinywhale-missing-checkout', resolveUpdateConfig(), NEVER))
      .resolves.toMatchObject({ ok: false })
  })
})
