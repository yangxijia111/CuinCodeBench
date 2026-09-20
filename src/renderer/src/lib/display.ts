import { DISPLAY_TRUNCATE_CHARS } from '@shared/constants'

/**
 * 展示层文本截断（SECURITY §3.3）：运行产物可能接近 1MB 上限，
 * UI 只渲染前 N 字符，防止 DOM 卡死。截断时附加提示行。
 */
export function truncateForDisplay(text: string): string {
  if (text.length <= DISPLAY_TRUNCATE_CHARS) return text
  return (
    text.slice(0, DISPLAY_TRUNCATE_CHARS) +
    `\n…（已截断，完整输出共 ${text.length.toLocaleString('zh-CN')} 字符）`
  )
}
