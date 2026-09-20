import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * 题面 Markdown 渲染：marked 解析 + DOMPurify 净化（SECURITY §3.6：不渲染原始 HTML）。
 */
export function MarkdownView({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const html = useMemo(() => {
    if (text.trim() === '') return ''
    const raw = marked.parse(text, { async: false, breaks: true })
    return DOMPurify.sanitize(raw, { FORBID_TAGS: ['style', 'iframe', 'form'], FORBID_ATTR: ['onerror', 'onclick'] })
  }, [text])

  if (html === '') return <div className={className} />
  return <div className={`markdown ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
