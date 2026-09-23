import type { ExecutionResult } from '@shared/types'
import { execute, killAllActiveChildren, type ExecuteOptions } from './execute'
import { executeNative, killAllActiveLaunchers } from './native-launcher'
import { resolveLauncherPath } from './resolve-launcher'
import { logger } from '../lib/logger'

/**
 * 进程执行分发（docs/V1_3_ARCHITECTURE.md §1）：
 * - Windows + launcher 存在（且未被 CCB_DISABLE_NATIVE_LAUNCHER 禁用）→ Native Launcher
 *   （Job Object 资源围栏：内存/进程数上限、无竞态整树清理）；
 * - 否则 → 旧 execute() 路径（fallback 永久保留，非 Windows 平台主路径）。
 * 语义契约：两路径对同一输入产生等价 ExecutionResult（对拍测试，tests P3 §1.1）。
 */

export function nativeLauncherAvailable(): boolean {
  if (process.platform !== 'win32') return false
  if (process.env['CCB_DISABLE_NATIVE_LAUNCHER'] === '1') return false
  return resolveLauncherPath() !== null
}

export async function runProcess(opts: ExecuteOptions): Promise<ExecutionResult> {
  if (nativeLauncherAvailable()) {
    const launcherPath = resolveLauncherPath()
    if (launcherPath !== null) {
      try {
        return await executeNative(opts, {}, launcherPath)
      } catch (err) {
        // 仅 launcher 自身无法启动（ENOENT/被拦截）——未创建任何用户进程，可安全降级
        logger.warn(
          'Native launcher 启动失败，本次执行降级 fallback 路径',
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }
  return execute(opts)
}

/** 应用退出：终止全部执行中的程序（native 与 fallback 两条登记表） */
export function killAllActiveProcesses(): void {
  killAllActiveLaunchers()
  killAllActiveChildren()
}
