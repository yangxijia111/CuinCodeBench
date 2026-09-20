import CodeMirror from '@uiw/react-codemirror'
import { cpp } from '@codemirror/lang-cpp'
import { python } from '@codemirror/lang-python'
import { EditorView } from '@codemirror/view'
import type { LanguageId } from '@shared/types'

/**
 * 代码编辑器：CodeMirror 6 封装（行号/高亮/缩进开箱即用）。
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

export function CodeEditor(props: {
  value: string
  language: LanguageId
  fontSize: number
  tabSize: number
  wordWrap: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const { value, language, fontSize, tabSize, wordWrap, onChange } = props

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
    '&.cm-focused': { outline: 'none' }
  })

  const extensions = [languageExtension(language), theme]
  if (wordWrap) extensions.push(EditorView.lineWrapping)

  return (
    <CodeMirror
      value={value}
      height="100%"
      style={{ height: '100%' }}
      theme="dark"
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        tabSize,
        foldGutter: false,
        autocompletion: false
      }}
      onChange={onChange}
    />
  )
}
