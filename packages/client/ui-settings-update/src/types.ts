/**
 * Wire values for the loopback TinyWhale update channel.
 * @module @deepseek-ai/dsh-client-ui-settings-update
 */

/** Dedicated Connection channel; loopback-only on the Host. */
export const TINYWHALE_UPDATE_CHANNEL = '/tinywhale'

/** Read whether this process is a TinyWhale git checkout. */
export const TINYWHALE_UPDATE_STATUS = 'status'

/** Fetch and merge the configured upstream remote. */
export const TINYWHALE_UPDATE_APPLY = 'apply'

/** Default git remote name for DeepSeek Harness. */
export const DEFAULT_UPSTREAM_REMOTE = 'upstream'

/** Default DeepSeek Harness clone URL. */
export const DEFAULT_UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** Default branch merged from the upstream remote. */
export const DEFAULT_UPSTREAM_BRANCH = 'master'

/** Local checkout facts the Settings row needs before it offers Update. */
export interface TinyWhaleUpdateStatus {
  /** True when TINYWHALE.md and a git directory sit at the discovered root. */
  available: boolean
  /** Absolute checkout root when {@link TinyWhaleUpdateStatus.available} is true. */
  root?: string
  /** Remote name that apply fetches and merges. */
  remoteName: string
  /** Remote URL used when the named remote is absent. */
  remoteUrl: string
  /** Branch name merged from the remote. */
  branch: string
}

/** Closed apply outcomes the Settings row localizes. */
export type TinyWhaleUpdateOutcome =
  | 'updated'
  | 'already-current'
  | 'refused-dirty'
  | 'refused-detached'
  | 'refused-unavailable'
  | 'refused-busy'
  | 'conflict'
  | 'failed'

/** Result of one apply request. */
export interface TinyWhaleUpdateApplyResult {
  /** Discriminant the Settings row maps to localized copy. */
  outcome: TinyWhaleUpdateOutcome
  /** Optional git or installer diagnostic; the row truncates it for display. */
  detail?: string
  /** Whether `pnpm install` ran after a successful merge that touched the lockfile. */
  installed?: boolean
}
