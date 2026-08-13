// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateRow } from '../src/client/UpdateRow.tsx'
import type { UpdateRowInjected, UpdateRowProps } from '../src/client/UpdateRow.tsx'
import { en, type UpdateSettingsKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: UpdateSettingsKey): string => en[key]) as UpdateRowProps['t']

const STATUS = {
  available: true,
  remoteName: 'upstream',
  remoteUrl: 'u',
  branch: 'master',
} as const

function props(face: UpdateRowInjected): UpdateRowProps {
  return { t, ...face } as UpdateRowProps
}

function applyButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: en.apply })
}

describe('UpdateRow', () => {
  it('shows a disabled button while checking, then applies', async () => {
    const deferred = Promise.withResolvers<typeof STATUS>()
    const load = vi.fn(() => deferred.promise)
    const applyUpdate = vi.fn(async () => ({ outcome: 'updated' as const }))
    render(<UpdateRow {...props({ load, apply: applyUpdate })} />)
    expect(screen.getByText(en.title)).toBeTruthy()
    expect(screen.getByText(en.checking)).toBeTruthy()
    expect(applyButton().disabled).toBe(true)

    await act(async () => { deferred.resolve(STATUS) })
    expect(screen.getByText(en.description)).toBeTruthy()
    fireEvent.click(applyButton())
    expect(screen.getByText(en.applying)).toBeTruthy()
    expect(applyButton().disabled).toBe(true)
    await waitFor(() => { expect(screen.getByText(en.success)).toBeTruthy() })
    expect(applyUpdate).toHaveBeenCalledOnce()
  })

  it('ignores a load that settles after unmount', async () => {
    const ok = Promise.withResolvers<typeof STATUS>()
    const fail = Promise.withResolvers<never>()
    const first = render(<UpdateRow {...props({
      load: () => ok.promise,
      apply: vi.fn(),
    })} />)
    first.unmount()
    await act(async () => { ok.resolve(STATUS) })
    expect(first.container.querySelector('button')).toBeNull()

    const second = render(<UpdateRow {...props({
      load: () => fail.promise,
      apply: vi.fn(),
    })} />)
    second.unmount()
    await act(async () => { fail.reject(new Error('offline')) })
    expect(second.container.querySelector('button')).toBeNull()
  })

  it('keeps the row visible when the Host has no checkout', async () => {
    const load = vi.fn(async () => ({ available: false, remoteName: 'upstream', remoteUrl: 'u', branch: 'master' }))
    render(<UpdateRow {...props({ load, apply: vi.fn() })} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.unavailable) })
    expect(applyButton().disabled).toBe(true)
  })

  it('surfaces a failed apply and a thrown load as alerts', async () => {
    const load = vi.fn(async () => ({ available: true, remoteName: 'upstream', remoteUrl: 'u', branch: 'master' }))
    const applyUpdate = vi.fn(async () => {
      throw new Error('transport down')
    })
    render(<UpdateRow {...props({ load, apply: applyUpdate })} />)
    await screen.findByRole('button', { name: en.apply })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en.failed) })
    expect(screen.getByRole('alert').textContent).toContain('transport down')

    cleanup()
    const load2 = vi.fn(async () => ({ available: true, remoteName: 'upstream', remoteUrl: 'u', branch: 'master' }))
    render(<UpdateRow {...props({ load: load2, apply: async () => { throw 42 } })} />)
    await screen.findByRole('button', { name: en.apply })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('42') })

    cleanup()
    render(<UpdateRow {...props({
      load: async () => { throw new Error('offline') },
      apply: vi.fn(),
    })} />)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(en.unavailable)
    })
    expect(screen.getByRole('alert').textContent).toContain('offline')
  })

  it('appends a conflict detail to the localized outcome', async () => {
    const load = vi.fn(async () => ({ available: true, remoteName: 'upstream', remoteUrl: 'u', branch: 'master' }))
    render(<UpdateRow {...props({
      load,
      apply: async () => ({ outcome: 'conflict', detail: 'both edited README' }),
    })} />)
    await screen.findByRole('button', { name: en.apply })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(`${en.conflict} both edited README`)
    })
  })
})
