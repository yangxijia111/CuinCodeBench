import { app, ipcMain } from 'electron'
import type { ZodTypeAny, z } from 'zod'
import { logger } from '../lib/logger'
import { AppError } from '../lib/app-error'
import { validateIpcSender } from './validate-sender'

/**
 * IPC 层：薄封装——sender 校验 + zod 校验入参 → 调用 service → 统一错误信封。
 * 业务逻辑一律在 service 层，此处禁止写业务（ARCHITECTURE §2）。
 *
 * 约定：每个通道只接收一个 raw 参数（对象或数组），schema 校验后的值传给 fn。
 */

export { AppError }

/** 统一注册器：入参经 schema 校验，fn 返回值/异常包装为 IpcResult。
 *  调用约定：单参数通道 schema 校验该值本身；多参数通道（z.tuple）校验参数数组。 */
export function handle<S extends ZodTypeAny, R>(
  channel: string,
  schema: S,
  fn: (parsed: z.output<S>) => Promise<R> | R
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    // 纵深防御：只处理来自本应用窗口的请求（H3）
    if (!validateIpcSender(event)) {
      return { ok: false, code: 'forbidden', message: '拒绝来自不可信来源的请求' } as const
    }
    try {
      const parsed = schema.parse(rawArgs.length === 1 ? rawArgs[0] : rawArgs)
      const data = await fn(parsed)
      return { ok: true, data } as const
    } catch (err) {
      if (err instanceof AppError) {
        logger.warn(`IPC ${channel} 领域错误: ${err.code}`, err.message)
        return { ok: false, code: err.code, message: err.message } as const
      }
      // zod 校验失败（ZodError 带 issues 数组，避免直接 import zod 实例做 instanceof）
      if (
        err !== null &&
        typeof err === 'object' &&
        'issues' in err &&
        Array.isArray(err.issues)
      ) {
        const issues = err.issues as { path: (string | number)[]; message: string }[]
        const detail = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        logger.warn(`IPC ${channel} 参数校验失败`, detail)
        return { ok: false, code: 'validation', message: `参数不合法：${detail}` } as const
      }
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`IPC ${channel} 内部错误`, err instanceof Error ? err.stack : undefined)
      return { ok: false, code: 'internal', message } as const
    }
  })
}

export function getDataDir(): string {
  // 测试与便携场景可覆盖；默认使用系统用户数据目录（NFR-2）
  const override = process.env['CCB_DATA_DIR']
  return override && override.trim() !== '' ? override : app.getPath('userData')
}
