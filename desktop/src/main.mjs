import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachOrStartHarness, stopHarness } from './harness.mjs'
import { envWithGuiPath } from './gui-path.mjs'
import { installApplicationMenu } from './menu.mjs'

const SMOKE = process.argv.includes('--smoke')
const ATTACH_ONLY = process.argv.includes('--attach-only') || process.env.TINYWHALE_ATTACH_ONLY === '1'
const here = dirname(fileURLToPath(import.meta.url))

Object.assign(process.env, envWithGuiPath(process.env))

/** @type {import('node:child_process').ChildProcess | undefined} */
let harnessChild
/** @type {BrowserWindow | null} */
let mainWindow = null

function iconPath() {
  const candidates = [
    join(here, '../resources/icon.png'),
    join(process.resourcesPath ?? '', 'icon.png'),
  ]
  return candidates.find(path => existsSync(path))
}

function isLocalUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

function createWindow() {
  const icon = iconPath()
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show: !SMOKE,
    title: 'TinyWhale',
    backgroundColor: '#15515C',
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      partition: 'persist:tinywhale',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window

  window.on('page-title-updated', event => {
    event.preventDefault()
    window.setTitle('TinyWhale')
  })

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isLocalUrl(target)) {
      void shell.openExternal(target)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, target) => {
    if (!isLocalUrl(target)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  return window
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
    detail: `${message}\n\n需要本机已安装 dsh，或先在终端运行 dsh web。`,
  })
  app.exit(1)
}

app.setName('TinyWhale')
app.setAboutPanelOptions({
  applicationName: 'TinyWhale',
  applicationVersion: app.getVersion(),
  version: 'dev',
  copyright: '© 2026 TinyWhale contributors\nBased on DeepSeek Harness (MIT)',
  iconPath: iconPath(),
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    installApplicationMenu()
    const icon = iconPath()
    if (icon !== undefined) {
      app.dock?.setIcon(nativeImage.createFromPath(icon))
    }

    const window = createWindow()
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

    try {
      if (!SMOKE) {
        await window.loadFile(join(here, 'loading.html'))
        window.show()
      }
      const session = await attachOrStartHarness({ attachOnly: ATTACH_ONLY || SMOKE })
      harnessChild = session.child
      if (harnessChild !== undefined) {
        harnessChild.on('exit', () => {
          if (!SMOKE) app.quit()
        })
      }
      await window.loadURL(session.url)
    } catch (error) {
      await showStartupFailure(error)
    }
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (harnessChild !== undefined) {
    stopHarness(harnessChild)
    harnessChild = undefined
  }
})
