/**
 * The built-in catalog of TAB-registration plugins (sidebar pages),
 * shown in the "add tab plugin" modal (Side card settings → 侧边栏内容 grid
 * → the dashed card). Adding an entry: append one object here (unique
 * `id` = npm package name, `url` = GitHub repo, `description` =
 * i18n-friendly, `install` = the full shell command pre-filled into the
 * install terminal — it starts with `cd ~/.dsh` so the install runs with
 * the DSH home as the working directory). Data integrity is guarded by
 * `tests/plugin-list.spec.ts`.
 */
import type { PluginEntry } from './plugins-shared.ts'

/** Tab-registration plugins (empty until a real one exists — the modal
 *  renders the empty state and points at the GitHub topic). */
export const builtinTabPlugins: readonly PluginEntry[] = []
