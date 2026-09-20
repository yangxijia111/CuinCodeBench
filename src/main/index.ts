import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { logger } from './lib/logger'
import { registerIpcHandlers } from './ipc/register'
import { getDataDir } from './ipc'
import { openDatabase } from './db/connection'
import { initServices } from './services'
import { loadSeedProblems, resolveSeedFile } from './seed/seed'

/**
 * 主进程入口：单实例锁 → 打开数据库 → 服务初始化 → 种子灌入 → IPC 注册 → 窗口创建。
 */

// 禁止硬件加速相关的已知渲染问题（保守关闭，桌面工具不需要 GPU 重度特性）
// 注：如后续遇到性能问题可重新评估
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'CuinCodeBench',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // 外部链接交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

function loadRenderer(win: BrowserWindow): void {
  // electron-vite dev 模式注入 ELECTRON_RENDERER_URL；否则加载打包产物
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    // 数据库与服务（数据目录：userData，或 CCB_DATA_DIR 覆盖）
    const db = openDatabase({ dataDir: getDataDir() })
    const services = initServices(db)

    // 首次启动灌入种子题库（FR-P6：仅当题库为空）
    if (services.problems.count() === 0) {
      const seedFile = resolveSeedFile(app.isPackaged, app.getAppPath(), process.resourcesPath)
      const seeds = loadSeedProblems(seedFile)
      for (const s of seeds) services.problems.create(s, true)
      logger.info('种子题库已灌入', `${seeds.length} 题`)
    }

    registerIpcHandlers()
    const win = createMainWindow()
    loadRenderer(win)
    logger.info('应用已启动', `version=${app.getVersion()}`)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const w = createMainWindow()
        loadRenderer(w)
      }
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 兜底：不静默吞掉未捕获异常（NFR-7）
  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常', err.stack ?? err.message)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', String(reason))
  })
}
