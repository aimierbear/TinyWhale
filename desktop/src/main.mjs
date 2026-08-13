import { app, BrowserWindow, shell } from 'electron'
import { attachOrStartHarness, stopHarness } from './harness.mjs'

const SMOKE = process.argv.includes('--smoke')
const ATTACH_ONLY = process.argv.includes('--attach-only') || process.env.TINYWHALE_ATTACH_ONLY === '1'

/** @type {import('node:child_process').ChildProcess | undefined} */
let harnessChild
/** @type {BrowserWindow | null} */
let mainWindow = null

function isLocalUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

async function createWindow(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show: !SMOKE,
    title: 'TinyWhale',
    autoHideMenuBar: true,
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

  if (SMOKE) {
    window.webContents.once('did-finish-load', () => {
      process.stdout.write(`TINYWHALE_SMOKE_OK ${url}\n`)
      app.quit()
    })
    window.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`TINYWHALE_SMOKE_FAIL ${code} ${description}`)
      app.exit(1)
    })
  } else {
    window.once('ready-to-show', () => {
      window.show()
    })
  }

  await window.loadURL(url)
}

app.setName('TinyWhale')

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
    try {
      const session = await attachOrStartHarness({ attachOnly: ATTACH_ONLY || SMOKE })
      harnessChild = session.child
      if (harnessChild !== undefined) {
        harnessChild.on('exit', () => {
          if (!SMOKE) app.quit()
        })
      }
      await createWindow(session.url)
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      app.exit(1)
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
