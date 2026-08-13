/** Copy dictionaries for the General-settings Update row. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  title: '软件更新',
  description: '从上游仓库拉取最新代码。完成后请重启 TinyWhale。',
  checking: '正在检查安装…',
  apply: '更新',
  applying: '正在更新…',
  success: '更新完成，请重启 TinyWhale。',
  alreadyCurrent: '已是最新。',
  dirty: '工作区有未提交更改，请先提交或清理后再更新。',
  detached: '当前不在分支上，无法自动更新。',
  unavailable: '当前安装不是 Git 检出，无法在线更新。',
  busy: '已有更新在进行中。',
  conflict: '合并冲突，已中止。请在终端手动处理。',
  failed: '更新失败。',
} satisfies Record<string, string>

/** Update-row locale key union. */
export type UpdateSettingsKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  title: 'Software update',
  description: 'Pull the latest code from the upstream repository. Restart TinyWhale when it finishes.',
  checking: 'Checking this install…',
  apply: 'Update',
  applying: 'Updating…',
  success: 'Update complete. Restart TinyWhale.',
  alreadyCurrent: 'Already up to date.',
  dirty: 'The working tree has uncommitted changes. Commit or clean it, then update.',
  detached: 'HEAD is detached, so automatic update is unavailable.',
  unavailable: 'This install is not a Git checkout, so it cannot update online.',
  busy: 'An update is already running.',
  conflict: 'Merge conflict. The merge was aborted. Resolve it in a terminal.',
  failed: 'Update failed.',
} satisfies Record<UpdateSettingsKey, string>
