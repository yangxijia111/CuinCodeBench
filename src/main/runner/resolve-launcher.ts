import { existsSync } from 'fs'
import { join } from 'path'

/**
 * ccb-launcher 路径解析单源（docs/V1_3_JOB_OBJECT_DESIGN.md §2）：
 * - 打包：process.resourcesPath/bin/ccb-launcher.exe（electron-builder extraResources）
 * - 开发：<repo>/native/bin/ccb-launcher.exe（npm run build:launcher 产物，gitignore）
 * - 非 Windows / 文件缺失 → null → Runner 走 fallback（旧 execute 路径）。
 *
 * runner 模块不 import electron（测试与降级语义一致）：
 * 打包上下文由主进程启动时注入（configureLauncherContext）。
 */

interface LauncherContext {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

let context: LauncherContext | null = null
/** 测试/降级开关：undefined = 按常规解析；null = 强制禁用；非空 = 强制路径 */
let override: string | null | undefined

export function configureLauncherContext(ctx: LauncherContext): void {
  context = ctx
}

/** 测试注入专用：强制 launcher 路径或禁用（null） */
export function overrideLauncherPath(path: string | null): void {
  override = path
}

export function resolveLauncherPath(): string | null {
  if (override !== undefined) return override
  if (process.platform !== 'win32') return null
  if (context?.isPackaged === true) {
    const packaged = join(context.resourcesPath, 'bin', 'ccb-launcher.exe')
    return existsSync(packaged) ? packaged : null
  }
  const dev = join(context?.appPath ?? process.cwd(), 'native', 'bin', 'ccb-launcher.exe')
  return existsSync(dev) ? dev : null
}
