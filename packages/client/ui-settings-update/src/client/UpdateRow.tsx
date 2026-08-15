/**
 * General-settings row: pull DeepSeek Harness into this TinyWhale checkout.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TinyWhaleUpdateApplyResult, TinyWhaleUpdateOutcome, TinyWhaleUpdateStatus } from '../types.ts'
import type { UpdateSettingsKey } from './locales.ts'
import css from './UpdateRow.module.css'

/** Registration-side Host face. */
export interface UpdateRowInjected {
  /** Cheap local checkout probe. */
  load: () => Promise<TinyWhaleUpdateStatus>
  /** Fetch and merge the configured upstream remote. */
  apply: () => Promise<TinyWhaleUpdateApplyResult>
}

/** Full component props. */
export type UpdateRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.update'>
  & InjectFace<UpdateRowInjected>

const OUTCOME_KEY = {
  updated: 'success',
  'already-current': 'alreadyCurrent',
  manual: 'manual',
  'refused-dirty': 'dirty',
  'refused-detached': 'detached',
  'refused-unavailable': 'unavailable',
  'refused-busy': 'busy',
  conflict: 'conflict',
  failed: 'failed',
} as const satisfies Record<TinyWhaleUpdateOutcome, UpdateSettingsKey>

const ERROR_OUTCOMES = new Set<TinyWhaleUpdateOutcome>([
  'refused-dirty', 'refused-detached', 'refused-unavailable', 'refused-busy', 'conflict', 'failed',
])

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable'; readonly detail?: string }
  | { readonly status: 'ready'; readonly channel?: TinyWhaleUpdateStatus['channel']; readonly version?: string }

function withDetail(label: string, detail: string | undefined): string {
  if (detail === undefined || detail === '') return label
  return `${label} ${detail}`
}

function describeUpdate(
  view: ViewState,
  result: TinyWhaleUpdateApplyResult | null,
  t: UpdateRowProps['t'],
): string {
  if (view.status === 'loading') return t('checking')
  if (view.status === 'unavailable') return withDetail(t('unavailable'), view.detail)
  const outcome = result?.outcome
  if (outcome === undefined) {
    if (view.channel !== 'packaged') return t('description')
    if (view.version === undefined || view.version === '') return t('packagedDescription')
    return `${t('packagedDescription')} (${view.version})`
  }
  return withDetail(t(OUTCOME_KEY[outcome]), result?.detail)
}

/**
 * Render the Update row on every loopback Settings mount.
 * @param props - composed slot props.
 * @returns the row.
 */
export function UpdateRow({ load, apply, t }: UpdateRowProps): ReactNode {
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<TinyWhaleUpdateApplyResult | null>(null)

  useEffect(() => {
    let current = true
    void load().then(
      (status) => {
        if (!current) return
        if (!status.available) {
          setView({ status: 'unavailable' })
          return
        }
        setView({
          status: 'ready',
          ...(status.channel === undefined ? {} : { channel: status.channel }),
          ...(status.version === undefined || status.version === '' ? {} : { version: status.version }),
        })
      },
      (error: unknown) => {
        if (!current) return
        setView({
          status: 'unavailable',
          detail: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return () => { current = false }
  }, [load])

  const busy = applying
  const canApply = view.status === 'ready' && !busy
  const outcome = result?.outcome
  const description = describeUpdate(view, result, t)
  const alert = view.status === 'unavailable'
    || (outcome !== undefined && ERROR_OUTCOMES.has(outcome))

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('title')}</div>
        <div className={alert ? css.error : css.desc} role={alert ? 'alert' : undefined}>
          {busy ? t('applying') : description}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!canApply}
        onClick={() => {
          setApplying(true)
          setResult(null)
          void apply().then(
            (next) => {
              if (next.outcome === 'manual' && next.detail !== undefined && next.detail !== '') {
                window.open(next.detail, '_blank', 'noopener,noreferrer')
              }
              setResult(next)
            },
            (error: unknown) => {
              setResult({
                outcome: 'failed',
                detail: error instanceof Error ? error.message : String(error),
              })
            },
          ).finally(() => { setApplying(false) })
        }}
      >
        {view.status === 'ready' && view.channel === 'packaged' ? t('openReleases') : t('apply')}
      </Button>
    </div>
  )
}
