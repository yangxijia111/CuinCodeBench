/**
 * 领域错误：service/repo 层表达可预期失败，由 IPC 层统一转译为错误信封。
 * 独立模块（不依赖 electron），使服务层可在 vitest 中直接测试。
 */

export class AppError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AppError'
  }
}
