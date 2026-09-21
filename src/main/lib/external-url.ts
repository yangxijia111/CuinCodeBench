/**
 * 外部 URL 协议白名单（v1.1 Hardening H2）。
 *
 * shell.openExternal 与窗口导航只允许 http:/https:，
 * 明确拒绝 file:/javascript:/data:/vbscript:/shell:/ms-settings: 等一切其他协议
 * （docs/SECURITY.md「External URLs」节）。
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 判定一个 URL 是否允许交给系统浏览器打开。
 * 解析失败（畸形 URL）一律拒绝。
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return false
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false
  // http(s) 必须带主机名（防御 "https://" 空主机等畸形输入）
  return parsed.hostname !== ''
}
