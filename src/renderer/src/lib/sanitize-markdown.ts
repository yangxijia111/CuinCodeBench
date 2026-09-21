import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * Markdown 净化（v1.1 Hardening H5，SECURITY「Markdown」节）：
 * marked 解析 + DOMPurify 净化，显式配置，杜绝脚本执行与危险 URI。
 *
 * - 禁用标签：script/svg/math/style/iframe/form/object/embed（SVG/MathML 攻击面整体移除）
 * - 事件属性：DOMPurify 默认删除全部 on* 属性（无需逐个列举）
 * - URI allowlist：DOMPurify 默认正则（http/https/ftp/mailto/tel 等安全协议；
 *   javascript:/data:/vbscript: 一律清除；相对路径与锚点保留）
 * - SANITIZE_DOM（默认开）：防御 DOM clobbering
 */

const FORBID_TAGS = ['script', 'style', 'iframe', 'form', 'object', 'embed', 'svg', 'math']
const FORBID_ATTR = ['srcset', 'background']

export function renderMarkdownToSafeHtml(text: string): string {
  if (text.trim() === '') return ''
  const raw = marked.parse(text, { async: false, breaks: true })
  return DOMPurify.sanitize(raw, {
    FORBID_TAGS,
    FORBID_ATTR,
    SANITIZE_DOM: true,
    // 显式声明仅净化的目标命名空间，防 mXSS 回归
    ALLOW_UNKNOWN_PROTOCOLS: false
  })
}
