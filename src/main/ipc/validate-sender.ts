import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { logger } from '../lib/logger'

/**
 * IPC sender 校验（v1.1 Hardening H3）：纵深防御。
 *
 * handler 只接受来自本应用创建的窗口（可信 WebContents 注册表）且
 * frame URL 属于本应用页面的请求：
 * - 生产：file: 协议（loadFile 加载打包产物）
 * - 开发：ELECTRON_RENDERER_URL 指定的 dev server origin（electron-vite 注入）
 *
 * 校验失败：拒绝执行、记录安全日志（不抛异常，返回统一信封由 handle 处理）。
 */

const trustedSenders = new WeakSet<WebContents>()

/** 窗口创建时注册其 WebContents 为可信 IPC 来源 */
export function registerTrustedSender(wc: WebContents): void {
  trustedSenders.add(wc)
}

/**
 * 判定 frame URL 是否属于本应用页面。
 * devOrigin 为 dev server origin（如 http://localhost:5173），生产模式传 null。
 */
export function isTrustedFrameUrl(frameUrl: string, devOrigin: string | null): boolean {
  if (frameUrl === '') return false
  let parsed: URL
  try {
    parsed = new URL(frameUrl)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:') return true
  if (devOrigin !== null && parsed.protocol === 'http:') {
    let origin: string | null
    try {
      origin = new URL(devOrigin).origin
    } catch {
      // dev origin 配置非法：视为无开发白名单
      return false
    }
    return parsed.origin === origin
  }
  return false
}

/** 当前开发模式 origin（electron-vite dev 注入 ELECTRON_RENDERER_URL；生产为 null） */
export function devServerOrigin(): string | null {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl === undefined || devUrl.trim() === '') return null
  return devUrl
}

/**
 * 统一 sender 校验入口：所有 IPC handler 经 handle() 自动调用。
 */
export function validateIpcSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  const frameUrl = frame?.url ?? ''
  const ok = trustedSenders.has(event.sender) && isTrustedFrameUrl(frameUrl, devServerOrigin())
  if (!ok) {
    logger.warn(
      '已拒绝来自不可信来源的 IPC 请求',
      `frameUrl=${frameUrl.slice(0, 120)} trusted=${trustedSenders.has(event.sender)}`
    )
  }
  return ok
}
