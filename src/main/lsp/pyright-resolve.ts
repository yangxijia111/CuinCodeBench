import { existsSync } from 'fs'
import { join } from 'path'

/**
 * pyright langserver 路径解析单源（docs/V1_4_DESIGN.md §2）：
 * - 开发：<appPath>/node_modules/pyright/langserver.index.js
 * - 打包：<resourcesPath>/app.asar.unpacked/node_modules/pyright/langserver.index.js
 *   （electron-builder asarUnpack；ELECTRON_RUN_AS_NODE 下 Electron 内置 node 可读）
 * 本模块不 import electron（上下文由主进程注入，同 resolve-launcher 模式）。
 */

interface LspPathContext {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

let context: LspPathContext | null = null
/** 测试注入：undefined = 常规解析；null = 强制视为不可用；非空 = 强制入口路径 */
let override: string | null | undefined

export function configureLspPathContext(ctx: LspPathContext): void {
  context = ctx
}

/** 测试注入专用：强制 pyright 入口 / 禁用（null）/ 恢复常规解析（undefined） */
export function overridePyrightEntry(path: string | null | undefined): void {
  override = path
}

/** pyright langserver 入口 JS；不可用返回 null（Python 智能编辑降级到回退链） */
export function resolvePyrightEntry(): string | null {
  if (override !== undefined) return override
  if (context?.isPackaged === true) {
    const packaged = join(context.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pyright', 'langserver.index.js')
    return existsSync(packaged) ? packaged : null
  }
  const dev = join(context?.appPath ?? process.cwd(), 'node_modules', 'pyright', 'langserver.index.js')
  return existsSync(dev) ? dev : null
}
