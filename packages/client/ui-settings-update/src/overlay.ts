/**
 * Paths TinyWhale keeps when merging DeepSeek Harness.
 *
 * Git has no "never take theirs" for a path: a merge driver only runs when
 * both sides changed. Settings update restores these from the pre-merge HEAD
 * after `git merge --no-commit`, covering upstream-only edits too.
 *
 * README, LICENSE, and the web index are not overlayed: they absorb
 * upstream text, then a rebrand pass restamps product name and clone URL.
 * @module @deepseek-ai/dsh-client-ui-settings-update
 */

/** Repository-relative overlay entries. A trailing slash marks a directory. */
export const TINYWHALE_OVERLAY_PATHS = [
  'NOTICE',
  'TINYWHALE.md',
  'apps/web/public/icon-mark.png',
  'desktop/',
  'packages/bundle/tinywhale/',
  'packages/client/ui-settings-update/',
  'packages/verifier/',
] as const

/**
 * Git pathspec for one overlay entry (directories lose the trailing slash).
 * @param entry - Overlay list entry.
 * @returns Pathspec safe to pass to `git checkout <tree> --`.
 */
export function overlayGitPath(entry: string): string {
  return entry.endsWith('/') ? entry.slice(0, -1) : entry
}

/**
 * Whether a repository-relative path is in the TinyWhale overlay.
 * @param path - Path from `git diff --name-only` (forward slashes).
 * @returns True when Settings update will restore this path from ours.
 */
export function isTinyWhaleOverlayPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  for (const entry of TINYWHALE_OVERLAY_PATHS) {
    const exact = overlayGitPath(entry)
    if (normalized === exact) return true
    if (entry.endsWith('/') && normalized.startsWith(`${exact}/`)) return true
  }
  return false
}
