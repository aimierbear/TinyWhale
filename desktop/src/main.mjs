import { app, BrowserWindow, dialog, shell, WebContentsView } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachOrStartHarness, isHttpReady, stopHarness } from './harness.mjs'
import { envWithGuiPath } from './gui-path.mjs'
import { installApplicationMenu } from './menu.mjs'
import { isTranslocatedApp, resolvePackagedRuntimeRoot } from './packaged.mjs'

const SMOKE = process.argv.includes('--smoke')
const ATTACH_ONLY = process.argv.includes('--attach-only') || process.env.TINYWHALE_ATTACH_ONLY === '1'
const here = dirname(fileURLToPath(import.meta.url))

Object.assign(process.env, envWithGuiPath(process.env))

/** @type {import('node:child_process').ChildProcess | undefined} */
let harnessChild
/** @type {string | undefined} */
let harnessPage
/** @type {BrowserWindow | null} */
let mainWindow = null
let opening = false

function isLocalUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

function createWindow() {
  // Do not pass a PNG `icon` on macOS. Electron would call
  // setApplicationIconImage, and Dock would show a raw square instead of the
  // bundle .icns with the system squircle.
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show: !SMOKE,
    title: 'TinyWhale',
    backgroundColor: '#435CDB',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:tinywhale',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.on('page-title-updated', event => {
    event.preventDefault()
    window.setTitle('TinyWhale')
  })

  guardNavigation(window.webContents)
  return window
}

function guardNavigation(contents) {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (!isLocalUrl(target)) {
      void shell.openExternal(target)
    }
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, target) => {
    if (!isLocalUrl(target)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })
}

function fitWebView(window, view) {
  const { width, height } = window.getContentBounds()
  view.setBounds({ x: 0, y: 0, width, height })
}

function setSplashStatus(window, text) {
  return window.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('boot-status'); if (el) el.textContent = ${JSON.stringify(text)} })()`,
  ).catch(() => {})
}

/**
 * Keep the splash document on the window. Load the web shell in a hidden
 * view and reveal it only after plugins settle, so the whale is not torn
 * down and remounted.
 */
async function revealWebWhenReady(window, url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:tinywhale',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  view.setBackgroundColor('#435CDB')
  view.setVisible(false)
  window.contentView.addChildView(view)
  fitWebView(window, view)
  const onResize = () => {
    if (!window.isDestroyed()) fitWebView(window, view)
  }
  window.on('resize', onResize)
  window.once('closed', () => {
    window.removeListener('resize', onResize)
  })
  guardNavigation(view.webContents)
  view.webContents.on('page-title-updated', event => {
    event.preventDefault()
    window.setTitle('TinyWhale')
  })
  await setSplashStatus(window, '正在加载插件')
  const failed = new Promise((_, reject) => {
    view.webContents.once('did-fail-load', (_event, _code, description) => {
      reject(new Error(`无法加载界面：${description}`))
    })
  })
  const booted = (async () => {
    await view.webContents.loadURL(url)
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (view.webContents.isDestroyed()) throw new Error('界面已关闭')
      try {
        const state = await view.webContents.executeJavaScript(
          'document.documentElement.getAttribute("data-dsh-boot")',
        )
        if (state === 'ready' || state === 'failed') return
      } catch {
        // Document is not executable yet.
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  })()
  await Promise.race([booted, failed])
  fitWebView(window, view)
  view.setVisible(true)
}

function focusWindow(window) {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function startupHint(message) {
  if (resolvePackagedRuntimeRoot() !== undefined) {
    return '请把 TinyWhale 拖到「应用程序」文件夹后再打开。如果已经装过，请重新安装一次。'
  }
  if (
    message.includes('typert.host.js')
    || message.includes('plugin tree failed to load')
    || message.includes('loader fibers failed')
  ) {
    return '本仓库还没有编译产物。在 TinyWhale 仓库根目录运行 pnpm build，然后重新打开应用。'
  }
  return '需要本机已安装 dsh，或先在仓库根目录编译后打开 TinyWhale。'
}

async function showStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (SMOKE) {
    console.error(message)
    app.exit(1)
    return
  }
  await dialog.showMessageBox({
    type: 'error',
    title: 'TinyWhale',
    message: '无法启动 TinyWhale',
    detail: `${message}\n\n${startupHint(message)}`,
  })
}

async function ensureHarness() {
  if (harnessPage !== undefined && await isHttpReady(harnessPage)) {
    return harnessPage
  }
  const session = await attachOrStartHarness({ attachOnly: ATTACH_ONLY || SMOKE })
  harnessChild = session.child
  harnessPage = session.url
  if (harnessChild !== undefined) {
    harnessChild.on('exit', () => {
      harnessChild = undefined
      harnessPage = undefined
    })
  }
  return session.url
}

async function openTinyWhale() {
  if (opening) return
  opening = true
  try {
    const existing = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null
    if (existing !== null && harnessPage !== undefined && await isHttpReady(harnessPage)) {
      focusWindow(existing)
      return
    }

    const window = existing ?? createWindow()
    if (SMOKE) {
      window.webContents.once('did-finish-load', () => {
        process.stdout.write(`TINYWHALE_SMOKE_OK ${window.webContents.getURL()}\n`)
        app.quit()
      })
      window.webContents.once('did-fail-load', (_event, code, description) => {
        console.error(`TINYWHALE_SMOKE_FAIL ${code} ${description}`)
        app.exit(1)
      })
    }

    if (!SMOKE) {
      await window.loadFile(join(here, 'loading.html'))
      focusWindow(window)
    }
    const url = await ensureHarness()
    if (SMOKE) {
      await window.loadURL(url)
      return
    }
    await revealWebWhenReady(window, url)
    focusWindow(window)
  } catch (error) {
    await showStartupFailure(error)
    if (SMOKE) app.exit(1)
  } finally {
    opening = false
  }
}

app.setName('TinyWhale')
app.setAboutPanelOptions({
  applicationName: 'TinyWhale',
  applicationVersion: app.getVersion(),
  version: 'dev',
  copyright: '© 2026 TinyWhale contributors\nBased on DeepSeek Harness (MIT)',
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void openTinyWhale()
  })

  app.whenReady().then(async () => {
    installApplicationMenu()
    if (resolvePackagedRuntimeRoot() !== undefined && isTranslocatedApp()) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'TinyWhale',
        message: '请先把 TinyWhale 装到「应用程序」',
        detail: '不要从磁盘映像里直接打开。把 TinyWhale 拖到「应用程序」文件夹，再从那里启动。',
      })
      app.quit()
      return
    }
    await openTinyWhale()
  })

  app.on('activate', () => {
    void openTinyWhale()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (harnessChild !== undefined) {
    stopHarness(harnessChild)
    harnessChild = undefined
  }
})
