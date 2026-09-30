import { fileURLToPath } from 'url'
import type { LspCompletionItem, LspDiagnostic, LspHoverResult } from '@shared/types'
import type { RawLspDiagnostic } from './lsp-server'

/**
 * LSP wire 类型 → 共享类型映射（纯函数，docs/V1_4_DESIGN.md §5）。
 * 共享类型是 renderer 唯一消费面（squiggle/补全/hover），来源差异在此抹平。
 */

/** LSP DiagnosticSeverity → 共享三档 */
function mapSeverity(severity: number | undefined): LspDiagnostic['severity'] {
  switch (severity) {
    case 1:
      return 'error'
    case 2:
      return 'warning'
    default:
      // 3=Information / 4=Hint / 缺省
      return 'info'
  }
}

/** 共享类型消息长度上限（与 lspDiagnosticSchema.message 一致） */
const MESSAGE_MAX = 10_000

export function mapDiagnostics(raw: RawLspDiagnostic[], sourceFallback: string): LspDiagnostic[] {
  return raw.slice(0, 200).map((d) => ({
    line: Math.max(0, d.range.start.line),
    col: Math.max(0, d.range.start.character),
    endLine: Math.max(0, d.range.end.line),
    endCol: Math.max(0, d.range.end.character),
    severity: mapSeverity(d.severity),
    message: d.message.slice(0, MESSAGE_MAX),
    ...(d.source !== undefined && d.source !== '' ? { source: d.source.slice(0, 40) } : { source: sourceFallback })
  }))
}

/** LSP CompletionItem（宽松 wire 面） */
interface RawCompletionItem {
  label: string
  kind?: number
  detail?: string
  insertText?: string
  textEdit?: { newText?: string }
}

/** completion 响应（数组 / CompletionList / null）→ 共享项（≤50，设计 §4） */
export function mapCompletions(raw: unknown): LspCompletionItem[] {
  const items: RawCompletionItem[] = Array.isArray(raw)
    ? (raw as RawCompletionItem[])
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { items?: RawCompletionItem[] }).items)
      ? ((raw as { items: RawCompletionItem[] }).items)
      : []
  return items.slice(0, 50).map((it) => ({
    label: String(it.label ?? '').slice(0, 200),
    ...(it.kind !== undefined ? { kind: it.kind } : {}),
    ...(it.detail !== undefined ? { detail: String(it.detail).slice(0, 500) } : {}),
    insertText: (it.textEdit?.newText ?? it.insertText ?? it.label ?? '').slice(0, 200)
  }))
}

/** LSP Hover 结果（{contents} 信封）→ 共享 hover */
export function mapHover(raw: unknown): LspHoverResult | null {
  if (raw === null || raw === undefined) return null
  // LSP Hover = { contents: MarkedString | MarkedString[] | MarkupContent }
  const contents =
    raw !== null && typeof raw === 'object' && 'contents' in (raw as Record<string, unknown>)
      ? (raw as { contents: unknown }).contents
      : raw
  const parts: { text: string; markdown: boolean }[] = []
  const push = (c: unknown): void => {
    if (typeof c === 'string') {
      parts.push({ text: c, markdown: false })
    } else if (c !== null && typeof c === 'object') {
      const obj = c as { value?: unknown; kind?: unknown }
      if (typeof obj.value === 'string') {
        parts.push({ text: obj.value, markdown: obj.kind === 'markdown' })
      }
    }
  }
  if (Array.isArray(contents)) {
    for (const c of contents) push(c)
  } else {
    push(contents)
  }
  const meaningful = parts.filter((p) => p.text.trim() !== '')
  if (meaningful.length === 0) return null
  return {
    contents: meaningful.map((p) => p.text).join('\n\n').slice(0, MESSAGE_MAX),
    isMarkdown: meaningful.some((p) => p.markdown)
  }
}

/** file URI → 平台路径（LSP 通知的 uri 还原为磁盘路径；非 file URI 原样返回） */
export function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}
