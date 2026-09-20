import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { logger } from '../lib/logger'

/**
 * IPC 层：薄封装——zod 校验入参 → 调用 service → 统一错误信封。
 * 业务逻辑一律在 service 层，此处禁止写业务（ARCHITECTURE §2）。
 */

/** 领域错误：service 层用于表达可预期失败 */
export class AppError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AppError'
  }
}

/** 统一注册器：把 handler 的结果/异常包装为 IpcResult */
export function handle<Args extends unknown[], R>(
  channel: string,
  schema: z.ZodType<unknown> | null,
  fn: (...args: Args) => Promise<R> | R
): void {
  ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]) => {
    try {
      const args: Args = schema
        ? (schema.parse(rawArgs) as Args)
        : ([] as unknown as Args)
      const data = await fn(...args)
      return { ok: true, data } as const
    } catch (err) {
      if (err instanceof AppError) {
        logger.warn(`IPC ${channel} 领域错误: ${err.code}`, err.message)
        return { ok: false, code: err.code, message: err.message } as const
      }
      if (err instanceof z.ZodError) {
        const detail = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
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
