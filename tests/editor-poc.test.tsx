// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { linter, setDiagnostics } from '@codemirror/lint'
import { autocompletion, startCompletion, type CompletionContext } from '@codemirror/autocomplete'
import { hoverTooltip } from '@codemirror/view'

/**
 * v1.4 P1 PoC③：CodeMirror 6 lint / autocompletion / hoverTooltip 扩展
 * 在本仓库 vitest+jsdom 环境下可渲染（docs/V1_4_DESIGN.md §12 P1）。
 * 生产集成在 P5（CodeEditor 升级）；此处验证库 API 与 DOM 交互无环境障碍。
 */

function mountView(extensions: NonNullable<Parameters<typeof EditorState.create>[0]>['extensions']): {
  view: EditorView
  host: HTMLElement
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({ state: EditorState.create({ doc: 'let x = 1\n', extensions }), parent: host })
  return { view, host }
}

describe('PoC③ CM6 扩展可行性', () => {
  it('setDiagnostics 渲染 squiggle（cm-lintRange）', () => {
    // linter(() => []) 注册 lint 基座（state field + 装饰插件），setDiagnostics 才会被消费
    const { view, host } = mountView([linter(() => [])])
    view.dispatch(
      setDiagnostics(view.state, [
        {
          from: 0,
          to: 3,
          severity: 'error',
          message: 'PoC 诊断：未定义变量'
        }
      ])
    )
    expect(host.querySelector('.cm-lintRange-error')).not.toBeNull()
    view.destroy()
    host.remove()
  })

  it('autocompletion + startCompletion 渲染补全列表', async () => {
    const source = (context: CompletionContext) => {
      const word = context.matchBefore(/\w*/)
      if (word === null || (word.from === word.to && !context.explicit)) return null
      return { from: word.from, options: [{ label: 'print_hello', type: 'function' }, { label: 'pi_value', type: 'variable' }] }
    }
    const { view, host } = mountView([autocompletion({ override: [source] })])
    startCompletion(view)
    await new Promise((r) => setTimeout(r, 50))
    const tooltip = host.querySelector('.cm-tooltip-autocomplete')
    expect(tooltip).not.toBeNull()
    expect(tooltip?.textContent).toContain('print_hello')
    view.destroy()
    host.remove()
  })

  it('hoverTooltip 扩展可构造（悬停内容由回调提供）', () => {
    const hover = hoverTooltip((view, pos) => {
      void view
      return { pos, create: () => ({ dom: document.createElement('div') }), above: true }
    })
    expect(hover).toBeTruthy()
    const { view, host } = mountView([hover])
    expect(host.querySelector('.cm-editor')).not.toBeNull()
    view.destroy()
    host.remove()
  })
})
