import { useEffect, useMemo, useRef } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { cpp } from '@codemirror/lang-cpp'
import { python } from '@codemirror/lang-python'
import { EditorView, hoverTooltip } from '@codemirror/view'
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import type { EditorState, Extension } from '@codemirror/state'
import type { LanguageId, LspCompletionItem, LspDiagnostic, LspHoverResult } from '@shared/types'
import { renderMarkdownToSafeHtml } from '../lib/sanitize-markdown'

/**
 * 代码编辑器（v1.4 升级）：
 * - 诊断（LSP/编译器回退统一为 LspDiagnostic[]）经 setDiagnostics 注入 squiggle
 * - 补全：completionProvider（LSP 往返）与语言关键字本地源合并
 * - hover：hoverProvider（LSP），markdown 经净化管线渲染
 * 字号与 Tab 宽度经主题注入；dark 配色跟随全局 CSS 变量。
 */

function languageExtension(lang: LanguageId) {
  switch (lang) {
    case 'c':
    case 'cpp':
      return cpp()
    case 'python':
      return python()
  }
}

/** 语言关键字本地补全（无 LSP 时的基础体验） */
const LOCAL_KEYWORDS: Record<LanguageId, string[]> = {
  c: ['int', 'char', 'float', 'double', 'void', 'if', 'else', 'for', 'while', 'return', 'sizeof', 'struct', 'const', 'break', 'continue', 'switch', 'case'],
  cpp: ['int', 'char', 'float', 'double', 'void', 'bool', 'if', 'else', 'for', 'while', 'return', 'sizeof', 'struct', 'class', 'const', 'break', 'continue', 'switch', 'case', 'std', 'vector', 'string', 'cin', 'cout', 'endl'],
  python: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'print', 'len', 'range', 'list', 'dict', 'set', 'str', 'int', 'float']
}

/** LSP CompletionItemKind → CM6 图标类型（粗映射，取常见段） */
function kindToType(kind: number | undefined): string | undefined {
  switch (kind) {
    case 2: // Method
    case 3: // Function
      return 'function'
    case 4: // Constructor
    case 5: // Field
    case 7: // Property
      return 'property'
    case 6: // Variable
      return 'variable'
    case 8: // Class
    case 23: // Struct
      return 'class'
    case 9: // Interface
      return 'interface'
    case 10: // Module
      return 'namespace'
    case 14: // Keyword
      return 'keyword'
    case 21: // Constant
      return 'constant'
    case 22: // Enum
      return 'enum'
    default:
      return undefined
  }
}

/** 0 基行列 → 文档 offset（clamp 越界） */
function offsetOf(state: EditorState, line: number, col: number): number {
  const ln = state.doc.line(Math.min(Math.max(line + 1, 1), state.doc.lines))
  return Math.min(ln.from + col, ln.to)
}

/** LspDiagnostic[] → CM6 Diagnostic[]（行列 → offset） */
function toCmDiagnostics(state: EditorState, diags: LspDiagnostic[]): Diagnostic[] {
  return diags.slice(0, 200).map((d) => ({
    from: offsetOf(state, d.line, d.col),
    to: Math.max(offsetOf(state, d.line, d.col), offsetOf(state, d.endLine, d.endCol)),
    severity: d.severity,
    message: d.source !== undefined ? `${d.message}（${d.source}）` : d.message
  }))
}

export interface CodeEditorProps {
  value: string
  language: LanguageId
  fontSize: number
  tabSize: number
  wordWrap: boolean
  onChange: (value: string) => void
  /** 当前文件诊断（LSP 或编译器回退；变化即重绘 squiggle） */
  diagnostics?: LspDiagnostic[]
  /** LSP 补全（行列为 0 基，content 为当前全量文本） */
  completionProvider?: (pos: { line: number; col: number; content: string }) => Promise<LspCompletionItem[]>
  /** LSP hover */
  hoverProvider?: (pos: { line: number; col: number; content: string }) => Promise<LspHoverResult | null>
}

export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const { value, language, fontSize, tabSize, wordWrap, onChange, diagnostics, completionProvider, hoverProvider } = props
  const cmRef = useRef<ReactCodeMirrorRef>(null)

  // 诊断注入：prop 变化 → setDiagnostics effect（linter 基座保证扩展在位）
  useEffect(() => {
    const view = cmRef.current?.view
    if (view === undefined) return
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state, diagnostics ?? [])))
  }, [diagnostics, value, language])

  const extensions = useMemo(() => {
    const exts: Extension[] = [
      languageExtension(language),
      // lint 基座（空源）：诊断统一由 setDiagnostics 注入（来源 LSP 或编译器回退）
      linter(() => [])
    ]

    // 补全：LSP 结果 + 本地关键字合并（LSP 不可用时本地源兜底）
    exts.push(
      autocompletion({
        override: [
          async (context: CompletionContext): Promise<CompletionResult | null> => {
            const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)
            const explicitOk = context.explicit || (word !== null && word.from !== word.to)
            if (!explicitOk) return null
            const options: Completion[] = LOCAL_KEYWORDS[language].map((k) => ({ label: k, type: 'keyword' }))
            if (completionProvider !== undefined && word !== null) {
              const state = context.state
              const line = state.doc.lineAt(word.to)
              try {
                const items = await completionProvider({
                  line: line.number - 1,
                  col: word.to - line.from,
                  content: state.doc.toString()
                })
                for (const item of items) {
                  if (item.label === '') continue
                  options.push({
                    label: item.label,
                    detail: item.detail,
                    type: kindToType(item.kind),
                    apply: item.insertText !== undefined && item.insertText !== '' ? item.insertText : item.label
                  })
                }
              } catch {
                // LSP 失败退化为本地关键字（不打断输入）
              }
            }
            if (options.length === 0) return null
            return { from: word?.from ?? context.pos, options, validFor: /^[A-Za-z0-9_]*$/ }
          }
        ]
      })
    )

    if (hoverProvider !== undefined) {
      exts.push(
        hoverTooltip(async (view, pos) => {
          const line = view.state.doc.lineAt(pos)
          const result = await hoverProvider({ line: line.number - 1, col: pos - line.from, content: view.state.doc.toString() })
          if (result === null || result.contents.trim() === '') return null
          const dom = document.createElement('div')
          dom.className = 'cm-hover-doc'
          if (result.isMarkdown) {
            dom.innerHTML = renderMarkdownToSafeHtml(result.contents)
          } else {
            const pre = document.createElement('pre')
            pre.textContent = result.contents
            dom.appendChild(pre)
          }
          return { pos, create: () => ({ dom }), above: true }
        })
      )
    }

    if (wordWrap) exts.push(EditorView.lineWrapping)
    return exts
  }, [language, wordWrap, completionProvider, hoverProvider])

  const theme = EditorView.theme({
    '&': { fontSize: `${fontSize}px`, backgroundColor: 'var(--bg-secondary)' },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      paddingBottom: '24px'
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-primary)',
      color: 'var(--text-secondary)',
      border: 'none'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.06)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-hover-doc': { maxWidth: '480px', maxHeight: '320px', overflow: 'auto', padding: '8px 10px' },
    '.cm-hover-doc pre': { margin: '0', whiteSpace: 'pre-wrap' },
    '.cm-hover-doc p': { margin: '4px 0' },
    '.cm-hover-doc code': { background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: '3px' }
  })

  return (
    <CodeMirror
      ref={cmRef}
      value={value}
      height="100%"
      style={{ height: '100%' }}
      theme="dark"
      extensions={[...extensions, theme]}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        tabSize,
        foldGutter: true,
        autocompletion: false
      }}
      onChange={onChange}
    />
  )
}
