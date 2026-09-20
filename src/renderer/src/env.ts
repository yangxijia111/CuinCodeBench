import type { AppApi } from '@shared/ipc'

/**
 * renderer 侧 window.api 类型声明（由 preload 注入）。
 */
declare global {
  interface Window {
    api: AppApi
  }
}

export {}
