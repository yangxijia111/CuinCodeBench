import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { logger } from './lib/logger'
import { registerIpcHandlers } from './ipc/register'
import { getDataDir } from './ipc'
import { openDatabase } from './db/connection'
import { initServices, getServices } from './services'
import { ToolchainService } from './services/toolchain-service'
import { JudgeService } from './services/judge-service'
import { loadSeedProblems, resolveSeedFile } from './seed/seed'
import { cleanLegacyTempDirs } from './runner/temp-dir'
import { killAllActiveChildren } from './runner/execute'

/**
 * 主进程入口：单实例锁 → 打开数据库 → 服务初始化 → 种子灌入 → 清扫遗留临时目录 →
 * IPC 注册 → 后台工具链探测 → 窗口创建。
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

  // 外部链接交给系统浏览器；阻止任何页内导航（Markdown 链接会把应用导航走且无法恢复）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    void shell.openExternal(url)
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

    // 首次启动灌入种子题库（FR-P6：仅一次，用户清空题库后不复活）
    // 种子文件损坏时降级为空题库继续启动，不阻塞窗口创建
    if (!services.settings.hasSeeded()) {
      try {
        const seedFile = resolveSeedFile(app.isPackaged, app.getAppPath(), process.resourcesPath)
        const seeds = loadSeedProblems(seedFile)
        for (const s of seeds) services.problems.create(s, true)
        services.settings.markSeeded()
        logger.info('种子题库已灌入', `${seeds.length} 题`)
      } catch (err) {
        services.settings.markSeeded()
        logger.error('种子题库灌入失败（已跳过，题库为空）', err instanceof Error ? err.stack : String(err))
      }
    }

    // 工具链与判题服务
    const toolchains = new ToolchainService(() => services.settings.get().manualToolchains)
    const judge = new JudgeService(toolchains, () => getServices())

    // 清扫上次运行遗留的临时目录（尽力而为，不阻塞启动）
    void cleanLegacyTempDirs().then((n) => {
      if (n > 0) logger.info('已清扫遗留临时目录', `${n} 个`)
    })

    registerIpcHandlers({ toolchains, judge })

    // 后台预探测工具链（不阻塞窗口显示）
    void toolchains
      .detectAll(true)
      .then((list) => logger.info('工具链探测完成', `${list.length} 个可用`))
      .catch((err: unknown) => logger.error('工具链探测失败', String(err)))

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
    // 退出前终止全部执行中的程序（防止孤儿进程），并尽力清理临时目录
    killAllActiveChildren()
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
