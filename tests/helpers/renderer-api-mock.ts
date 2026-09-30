import type { AppApi } from '../../src/shared/ipc'
import type { IpcResult } from '../../src/shared/ipc'

/**
 * renderer 测试辅助：window.api 代理 mock（v1.4 起 UI 组件依赖 IPC）。
 * 未覆盖的方法统一返回 ok/undefined；测试按需注入实现。
 */

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function installApiMock(impl: Partial<Record<keyof AppApi, unknown>>): AppApi {
  const fallback = (): IpcResult<unknown> => ok(undefined)
  const api = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string]
      return fallback
    }
  }) as unknown as AppApi
  ;(window as unknown as { api: AppApi }).api = api
  return api
}
