import { app } from 'electron'
import { z } from 'zod'
import { handle, getDataDir } from './index'

/**
 * IPC 通道注册总入口：按模块拆分的注册函数在此汇总。
 * 各 Phase 逐步追加（problems / toolchains / run / judge / history / mistakes / stats / settings）。
 */

const noArgs = z.tuple([])

export function registerIpcHandlers(): void {
  // —— 应用信息 ——
  handle('app.getInfo', noArgs, () => ({
    version: app.getVersion(),
    dataDir: getDataDir()
  }))
}
