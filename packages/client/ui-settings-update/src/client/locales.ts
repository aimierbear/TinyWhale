/** Copy dictionaries for the General-settings Update row. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  title: '软件更新',
  description: '从上游仓库拉取最新代码。完成后请重启 TinyWhale。',
  packagedDescription: '这是安装包。下载新的 DMG，把它拖到「应用程序」替换当前版本，然后重新打开 TinyWhale。',
  checking: '正在检查安装…',
  apply: '更新',
  openReleases: '打开下载页',
  applying: '正在更新…',
  success: '更新完成，请重启 TinyWhale。',
  alreadyCurrent: '已是最新。',
  manual: '请从下载页安装新版本，然后完全退出并重新打开 TinyWhale。',
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
  packagedDescription: 'This is the packaged app. Download the new DMG, drag it onto Applications to replace this copy, then reopen TinyWhale.',
  checking: 'Checking this install…',
  apply: 'Update',
  openReleases: 'Open download page',
  applying: 'Updating…',
  success: 'Update complete. Restart TinyWhale.',
  alreadyCurrent: 'Already up to date.',
  manual: 'Install the new version from the download page, then quit TinyWhale completely and open it again.',
  dirty: 'The working tree has uncommitted changes. Commit or clean it, then update.',
  detached: 'HEAD is detached, so automatic update is unavailable.',
  unavailable: 'This install is not a Git checkout, so it cannot update online.',
  busy: 'An update is already running.',
  conflict: 'Merge conflict. The merge was aborted. Resolve it in a terminal.',
  failed: 'Update failed.',
} satisfies Record<UpdateSettingsKey, string>
