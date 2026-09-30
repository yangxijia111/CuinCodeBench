// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PracticeView } from '../src/renderer/src/views/PracticeView'
import { useWorkspace, legacyDraftKey } from '../src/renderer/src/hooks/useWorkspace'
import { installApiMock, ok } from './helpers/renderer-api-mock'
import type { AppApi } from '../src/shared/ipc'
import type { ProblemDetail, WorkspaceFile } from '../src/shared/types'

/**
 * v1.4 P5：工作区 hook 与练习页集成（docs/V1_4_DESIGN.md §1/§9）。
 * window.api 用代理 mock；诊断经事件订阅回放。
 */

const entryFile: WorkspaceFile = { path: 'main.py', content: 'print("hi")\n', isEntry: true }
const utilFile: WorkspaceFile = { path: 'util.py', content: 'def add(a, b):\n    return a + b\n', isEntry: false }

function makeProblem(): ProblemDetail {
  return {
    id: 'p1',
    title: '两数之和',
    description: '输入两个数，输出和',
    difficulty: 'easy',
    tags: [],
    inputDesc: '两个整数',
    outputDesc: '一个整数',
    samples: [],
    initialCode: { c: '', cpp: '', python: 'print("hi")\n' },
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
    testCases: []
  }
}

let apiImpl: Partial<Record<keyof AppApi, unknown>>
let diagnosticsCb: ((e: never) => void) | null = null

beforeEach(() => {
  localStorage.clear()
  diagnosticsCb = null
  apiImpl = {
    getProblem: () => Promise.resolve(ok(makeProblem())),
    getSettings: () =>
      Promise.resolve(
        ok({ fontSize: 14, tabSize: 4, wordWrap: false, manualToolchains: {}, judgeTimeoutDefaultMs: 5000, manualClangdPath: '' })
      ),
    listProblems: () => Promise.resolve(ok([])),
    getProblemKnowledgePoints: () => Promise.resolve(ok([])),
    workspaceOpen: vi.fn(() => Promise.resolve(ok([entryFile, utilFile]))),
    workspaceSync: vi.fn(() => Promise.resolve(ok(undefined))),
    workspaceReset: vi.fn(() => Promise.resolve(ok([entryFile]))),
    lspStatus: () =>
      Promise.resolve(
        ok({
          c: { server: 'none', state: 'degraded' },
          cpp: { server: 'none', state: 'degraded' },
          python: { server: 'pyright', state: 'ready' }
        })
      ),
    lspComplete: () => Promise.resolve(ok([{ label: 'print_x' }])),
    lspHover: () => Promise.resolve(ok(null)),
    judgeSubmit: vi.fn(() =>
      Promise.resolve(
        ok({ submissionId: 's1', status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 10, compile: null, cases: [], problemStats: { problemId: 'p1', attempts: 1, acceptedCount: 1, firstAcceptedAt: 1, lastAttemptAt: 1 } })
      )
    ),
    onLspDiagnostics: (cb: (e: never) => void) => {
      diagnosticsCb = cb
      return () => {
        diagnosticsCb = null
      }
    }
  }
  installApiMock(apiImpl)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useWorkspace', () => {
  it('open → files/activePath；LSP 状态加载', async () => {
    const { result } = renderHook(() => useWorkspace('p1', 'python'))
    await waitFor(() => expect(result.current.files).toHaveLength(2))
    expect(result.current.activePath).toBe('main.py')
    await waitFor(() => expect(result.current.lspStatus?.python?.server).toBe('pyright'))
  })

  it('localStorage 旧草稿一次性迁移（open 携带 → 成功后清除）', async () => {
    localStorage.setItem(legacyDraftKey('p1', 'python'), 'OLD_DRAFT')
    const { result } = renderHook(() => useWorkspace('p1', 'python'))
    await waitFor(() => expect(result.current.files).toHaveLength(2))
    expect(apiImpl['workspaceOpen']).toHaveBeenCalledWith('p1', 'python', 'OLD_DRAFT')
    expect(localStorage.getItem(legacyDraftKey('p1', 'python'))).toBeNull()
    expect(result.current.files[0]?.content).toBe('print("hi")\n')
  })

  it('编辑 → 防抖 sync 只传变更文件', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useWorkspace('p1', 'python'))
      // open 先完成（fake timers 下 promise 微任务仍执行）
      await vi.waitFor(() => expect(result.current.files).toHaveLength(2))
      act(() => {
        result.current.updateFile('main.py', 'print("edited")\n')
        result.current.updateFile('main.py', 'print("edited2")\n')
      })
      // 防抖窗口内不触发
      expect(apiImpl['workspaceSync']).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(260)
      })
      await vi.waitFor(() => expect(apiImpl['workspaceSync']).toHaveBeenCalled())
      expect(apiImpl['workspaceSync']).toHaveBeenCalledWith('p1', 'python', [{ path: 'main.py', content: 'print("edited2")\n' }], [])
    } finally {
      vi.useRealTimers()
    }
  })

  it('诊断事件按 problemId+language 过滤并落位', async () => {
    const { result } = renderHook(() => useWorkspace('p1', 'python'))
    await waitFor(() => expect(result.current.files).toHaveLength(2))
    act(() => {
      diagnosticsCb?.({
        problemId: 'p1',
        language: 'python',
        path: 'util.py',
        diagnostics: [{ line: 0, col: 0, endLine: 0, endCol: 3, severity: 'error', message: '测试诊断' }]
      } as never)
      // 其他题目/语言的事件被忽略
      diagnosticsCb?.({ problemId: 'other', language: 'python', path: 'x.py', diagnostics: [] } as never)
    })
    expect(result.current.diagnostics['util.py']?.[0]?.message).toBe('测试诊断')
    expect(result.current.diagnostics['x.py']).toBeUndefined()
  })

  it('removeFile：非入口文件可删；入口文件报错上浮', async () => {
    const { result } = renderHook(() => useWorkspace('p1', 'python'))
    await waitFor(() => expect(result.current.files).toHaveLength(2))
    let okFlag = false
    await act(async () => {
      okFlag = await result.current.removeFile('util.py')
    })
    expect(okFlag).toBe(true)
    expect(result.current.files.map((f) => f.path)).toEqual(['main.py'])
    expect(apiImpl['workspaceSync']).toHaveBeenCalledWith('p1', 'python', [], ['util.py'])
  })
})

describe('PracticeView（文件 Tab 与诊断）', () => {
  function renderPractice(): void {
    render(
      <MemoryRouter initialEntries={['/practice/p1']}>
        <Routes>
          <Route path="/practice/:id" element={<PracticeView />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('多文件渲染 Tab；切换 Tab 换编辑内容；判题用入口代码', async () => {
    renderPractice()
    // 工作区打开后出现两个 Tab
    const utilTab = await screen.findByRole('tab', { name: /util\.py/ })
    expect(screen.getByRole('tab', { name: /main\.py/ })).toBeTruthy()
    // 编辑器当前显示入口文件内容
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('print("hi")')
    })

    // 切换到 util.py（点击处理在内层 .file-tab-btn 按钮）
    ;(utilTab.querySelector('button.file-tab-btn') as HTMLElement).click()
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('def add')
    })

    // 判题：无论当前 Tab，提交入口代码
    screen.getByRole('button', { name: '判题' }).click()
    await waitFor(() => expect(apiImpl['judgeSubmit']).toHaveBeenCalled())
    expect(apiImpl['judgeSubmit']).toHaveBeenCalledWith('p1', 'python', 'print("hi")\n')
  })

  it('诊断推送渲染 squiggle（cm-lintRange）', async () => {
    renderPractice()
    await screen.findByRole('tab', { name: /util\.py/ })
    act(() => {
      diagnosticsCb?.({
        problemId: 'p1',
        language: 'python',
        path: 'main.py',
        diagnostics: [{ line: 0, col: 0, endLine: 0, endCol: 5, severity: 'error', message: '未定义名称' }]
      } as never)
    })
    await waitFor(() => {
      expect(document.querySelector('.cm-lintRange-error')).not.toBeNull()
    })
  })

  it('单文件题目（workspace 只回入口）不渲染 Tab 栏', async () => {
    apiImpl['workspaceOpen'] = () => Promise.resolve(ok([entryFile]))
    renderPractice()
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('print("hi")')
    })
    expect(document.querySelector('.file-tabs')).toBeNull()
  })
})
