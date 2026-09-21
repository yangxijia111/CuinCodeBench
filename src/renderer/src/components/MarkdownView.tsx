import { useMemo } from 'react'
import { renderMarkdownToSafeHtml } from '../lib/sanitize-markdown'

/**
 * 题面 Markdown 渲染：净化逻辑见 lib/sanitize-markdown（H5）。
 */
export function MarkdownView({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdownToSafeHtml(text), [text])

  if (html === '') return <div className={className} />
  return <div className={`markdown ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
