/**
 * Shell root: boot loading page → (boot settled) → real UI in one switch.
 * Pure kernel component with zero plugin dependencies — before settled it may
 * only rely on itself (the fail-loud presentation must not depend on the
 * system whose failure it reports; the status/signal stores are kernel-own,
 * shell self-sufficiency rule); the real UI is produced by the
 * app-shell entry once every entry is active. A failed boot keeps the
 * loading page, lists the per-entry fiber states and the sweep report (fail
 * loud, no partial UI).
 *
 * The boot surface matches the TinyWhale desktop splash so the Electron
 * window does not flash a second full-screen theme while plugins load.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { KernelSignal, LoaderStatus } from './loader-status.ts'
import css from './AppRoot.module.css'

/** AppRoot props: settled signal, fiber-state projection feed, boot failure report, deferred real-UI factory. */
export interface AppRootProps {
  /** True once the boot chain settled (loader quiesced + all entries ACTIVE); the boot closure flips it. */
  settled: KernelSignal<boolean>
  /** Per-entry fiber-state projection store (drives loading/failed rendering). */
  status: KernelSignal<LoaderStatus>
  /** Boot failure report (the settle rejection message); undefined while loading or after success. */
  error: KernelSignal<string | undefined>
  /** Builds the real UI; called only after settled. */
  renderApp: () => ReactNode
}

/** Boot gate: loading page until the boot settles; failures stay here. */
export function AppRoot(props: AppRootProps) {
  const settled = useSyncExternalStore(props.settled.subscribe, props.settled.getSnapshot)
  const status = useSyncExternalStore(props.status.subscribe, props.status.getSnapshot)
  const error = useSyncExternalStore(props.error.subscribe, props.error.getSnapshot)
  const failed = Object.entries(status).filter(([, s]) => s === 'failed')
  const loud = error !== undefined || failed.length > 0

  useEffect(() => {
    let value = 'loading'
    if (settled) value = 'ready'
    else if (loud) value = 'failed'
    document.documentElement.setAttribute('data-dsh-boot', value)
  }, [settled, loud])

  if (settled) return <>{props.renderApp()}</>

  return (
    <div className={css.boot} data-boot-page>
      <div className={css.sea} aria-hidden="true" />
      <div className={css.grain} aria-hidden="true" />
      <main className={css.stage}>
        <div className={css.figure}>
          <img className={css.tail} src="/icon-mark.png" alt="" />
          <div className={css.echo} />
        </div>
        <div className={css.shore}>
          {!loud
            ? (
              <h1 className={css.line}>
                <span className={css.gleam}>TinyWhale</span>
                <span className={css.status}>
                  <span className={css.ping} />
                  <span className={css.gleam}>正在加载插件</span>
                </span>
              </h1>
            )
            : (
              <div className={css.failed}>
                <div className={css.failedTitle}>插件加载失败</div>
                {failed.map(([id]) => <div key={id} className={css.failedItem}>{id}</div>)}
                {error !== undefined && <div className={css.failedItem}>{error}</div>}
              </div>
            )}
        </div>
      </main>
    </div>
  )
}
