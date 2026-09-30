import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { LanguageId, ProblemDetail, JudgeResult, LspCompletionItem, LspHoverResult } from '@shared/types'
import type { RunOnceResult } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/types'
import { DIFFICULTY_META } from '@shared/ipc'
import { unwrap, ApiError } from '../api/client'
import { MarkdownView } from '../components/MarkdownView'
import { CodeEditor } from '../components/CodeEditor'
import { JudgeResultPanel } from '../components/JudgeResultPanel'
import { RunResultPanel } from '../components/RunResultPanel'
import { HistoryPanel } from '../components/HistoryPanel'
import { useWorkspace } from '../hooks/useWorkspace'

/**
 * 练习页：左题面 / 右编辑器 + 结果（FR-E1–E6、FR-C1、FR-J3）。
 * v1.4：代码编辑态迁入每题工作区（useWorkspace，docs/V1_4_DESIGN.md §1），
 * 附带文件 Tab、实时诊断（LSP/编译器回退）、补全与 hover。
 */

const LANGUAGES: { id: LanguageId; label: string }[] = [
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'python', label: 'Python' }
]

const LSP_BADGE: Record<string, { label: string; cls: string }> = {
  pyright: { label: 'pyright', cls: 'lsp-badge ok' },
  clangd: { label: 'clangd', cls: 'lsp-badge ok' },
  fallback: { label: '语法回退', cls: 'lsp-badge mid' },
  none: { label: '无诊断', cls: 'lsp-badge off' }
}

export function PracticeView(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()

  const [problem, setProblem] = useState<ProblemDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // v1.2：题库顺序导航（上一题/下一题）与知识点徽章
  const [problemIds, setProblemIds] = useState<string[]>([])
  const [kpNames, setKpNames] = useState<string[]>([])

  const [language, setLanguage] = useState<LanguageId>('python')
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [judging, setJudging] = useState(false)
  const [running, setRunning] = useState(false)
  const [judgeResult, setJudgeResult] = useState<JudgeResult | null>(null)
  const [runResult, setRunResult] = useState<RunOnceResult | null>(null)
  const [customStdin, setCustomStdin] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [showResultTab, setShowResultTab] = useState<'judge' | 'run' | 'history'>('judge')

  const ws = useWorkspace(problem?.id ?? '', language)

  // 加载题目 + 设置
  useEffect(() => {
    let alive = true
    if (id === undefined) return
    void (async () => {
      try {
        const [p, s] = await Promise.all([unwrap(window.api.getProblem(id)), unwrap(window.api.getSettings())])
        if (!alive) return
        if (p === null) {
          setLoadError('题目不存在或已被删除')
          return
        }
        setProblem(p)
        setSettings(s)
        // v1.2：知识点徽章（静默加载，失败不阻塞）
        void window.api.getProblemKnowledgePoints(p.id).then((res) => {
          if (alive && res.ok) setKpNames(res.data.map((k) => k.name))
        })
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  // v1.2：题库顺序导航（首切题时拉一次 id 列表）
  useEffect(() => {
    let alive = true
    void unwrap(window.api.listProblems({ keyword: '', difficulty: 'all', tag: 'all' }))
      .then((list) => {
        if (alive) setProblemIds(list.map((x) => x.id))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const currentIndex = id === undefined ? -1 : problemIds.indexOf(id)

  function goToProblem(delta: number): void {
    const next = problemIds[currentIndex + delta]
    if (next !== undefined) void navigate(`/practice/${next}`)
  }

  const entryFile = ws.files.find((f) => f.isEntry) ?? null
  const activeFile = ws.files.find((f) => f.path === ws.activePath) ?? entryFile
  // 判题/运行始终以入口文件为准（多文件模型：入口 = main.c|cpp|py）
  const entryCode = entryFile?.content ?? ''

  const completionProvider = useCallback(
    (pos: { line: number; col: number; content: string }): Promise<LspCompletionItem[]> => {
      if (problem === null || activeFile === null) return Promise.resolve([])
      return unwrap(
        window.api.lspComplete(problem.id, language, activeFile.path, pos.line, pos.col, pos.content)
      ).catch(() => [])
    },
    [problem, language, activeFile]
  )

  const hoverProvider = useCallback(
    (pos: { line: number; col: number; content: string }): Promise<LspHoverResult | null> => {
      if (problem === null || activeFile === null) return Promise.resolve(null)
      return unwrap(
        window.api.lspHover(problem.id, language, activeFile.path, pos.line, pos.col, pos.content)
      ).catch(() => null)
    },
    [problem, language, activeFile]
  )

  async function handleJudge(): Promise<void> {
    if (problem === null || judging) return
    setJudging(true)
    setActionError(null)
    setRunResult(null)
    setShowResultTab('judge')
    try {
      const result = await unwrap(window.api.judgeSubmit(problem.id, language, entryCode))
      setJudgeResult(result)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setJudging(false)
    }
  }

  async function handleRun(): Promise<void> {
    if (problem === null || running) return
    setRunning(true)
    setActionError(null)
    setJudgeResult(null)
    setShowResultTab('run')
    try {
      const result = await unwrap(
        window.api.runOnce({ language, code: entryCode, stdin: customStdin, timeoutMs: settings.judgeTimeoutDefaultMs })
      )
      setRunResult(result)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  async function handleReset(): Promise<void> {
    if (problem === null) return
    if (!window.confirm('确定重置为初始代码？当前修改与自建文件将丢失（判题历史不受影响）。')) return
    await ws.resetWorkspace()
  }

  function handleAddFile(): void {
    const path = window.prompt('新文件路径（相对工作区，如 util.h / sub/helper.py）', 'util.h')
    if (path === null || path.trim() === '') return
    void ws.addFile(path.trim())
  }

  function handleRemoveFile(path: string): void {
    if (!window.confirm(`删除文件 ${path}？`)) return
    void ws.removeFile(path)
  }

  const lspBadge = LSP_BADGE[ws.lspStatus?.[language]?.server ?? 'none'] ?? LSP_BADGE['none']
  const activeDiagnostics = activeFile !== null ? (ws.diagnostics[activeFile.path] ?? []) : []

  if (loadError !== null) {
    return (
      <div className="page">
        <div className="alert error">{loadError}</div>
        <button onClick={() => void navigate('/problems')}>返回题库</button>
      </div>
    )
  }
  if (problem === null) return <div className="page">加载中…</div>

  return (
    <div className="practice-layout">
      {/* 左：题面 */}
      <section className="problem-panel">
        <div className="problem-panel-head">
          <button className="back-btn" onClick={() => void navigate('/problems')}>
            ← 题库
          </button>
          <span className={`difficulty-label diff-${problem.difficulty}`}>
            {DIFFICULTY_META[problem.difficulty].label}
          </span>
          <h2 className="problem-panel-title">{problem.title}</h2>
        </div>
        <div className="problem-nav">
          <button disabled={currentIndex <= 0} onClick={() => goToProblem(-1)}>
            ← 上一题
          </button>
          {kpNames.map((n) => (
            <button key={n} className="kp-badge" onClick={() => void navigate('/learning')} title="查看学习路线">
              {n}
            </button>
          ))}
          <span className="problem-nav-pos">{currentIndex >= 0 ? `${currentIndex + 1} / ${problemIds.length}` : ''}</span>
          <button
            disabled={currentIndex < 0 || currentIndex >= problemIds.length - 1}
            onClick={() => goToProblem(1)}
          >
            下一题 →
          </button>
        </div>
        <div className="problem-panel-body">
          <MarkdownView text={problem.description} />
          <h3>输入格式</h3>
          <MarkdownView text={problem.inputDesc} />
          <h3>输出格式</h3>
          <MarkdownView text={problem.outputDesc} />
          <h3>示例</h3>
          {problem.samples.map((s, i) => (
            <div key={i} className="sample-block">
              <div className="sample-io">
                <span className="sample-label">输入</span>
                <pre>{s.input}</pre>
              </div>
              <div className="sample-io">
                <span className="sample-label">输出</span>
                <pre>{s.output}</pre>
              </div>
              {s.note !== undefined && <div className="sample-note">说明：{s.note}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* 右：编辑器 + 结果 */}
      <section className="editor-panel">
        <div className="editor-toolbar">
          <div className="lang-switch">
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                className={language === l.id ? 'lang-btn active' : 'lang-btn'}
                onClick={() => setLanguage(l.id)}
              >
                {l.label}
              </button>
            ))}
            <span className={lspBadge.cls} title="当前智能编辑供给（设置页可配置 clangd）">
              {lspBadge.label}
            </span>
          </div>
          <div className="editor-actions">
            <button onClick={() => void handleReset()}>重置代码</button>
            <button className="primary" disabled={running} onClick={() => void handleRun()}>
              {running ? '运行中…' : '运行'}
            </button>
            <button className="primary judge" disabled={judging} onClick={() => void handleJudge()}>
              {judging ? '判题中…' : '判题'}
            </button>
          </div>
        </div>

        {/* v1.4：文件 Tab（单文件题目退化为无 Tab，保持 v1.3 观感） */}
        {ws.files.length > 1 && (
          <div className="file-tabs" role="tablist" aria-label="工作区文件">
            {ws.files.map((f) => {
              const count = (ws.diagnostics[f.path] ?? []).filter((d) => d.severity === 'error').length
              return (
                <div
                  key={f.path}
                  role="tab"
                  aria-selected={f.path === ws.activePath}
                  className={f.path === ws.activePath ? 'file-tab active' : 'file-tab'}
                >
                  <button className="file-tab-btn" onClick={() => ws.setActivePath(f.path)} title={f.path}>
                    {f.path}
                    {count > 0 && <span className="file-tab-error" title={`${count} 个错误`}>{count}</span>}
                  </button>
                  {!f.isEntry && (
                    <button
                      className="file-tab-close"
                      aria-label={`删除 ${f.path}`}
                      title={`删除 ${f.path}`}
                      onClick={() => handleRemoveFile(f.path)}
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
            <button className="file-tab-add" onClick={handleAddFile} title="新建附加文件（如头文件/辅助源文件）">
              +
            </button>
          </div>
        )}

        <div className="editor-area">
          {ws.error !== null && <div className="alert error">{ws.error}</div>}
          {activeFile !== null ? (
            <CodeEditor
              key={activeFile.path}
              value={activeFile.content}
              language={language}
              fontSize={settings.fontSize}
              tabSize={settings.tabSize}
              wordWrap={settings.wordWrap}
              onChange={(value) => ws.updateFile(activeFile.path, value)}
              diagnostics={activeDiagnostics}
              completionProvider={completionProvider}
              hoverProvider={hoverProvider}
            />
          ) : (
            <div className="empty-hint small">正在打开工作区…</div>
          )}
        </div>

        <div className="result-area">
          {actionError !== null && <div className="alert error">{actionError}</div>}
          <div className="stdin-row">
            <span className="stdin-label">自定义输入（运行用）</span>
            <textarea
              rows={2}
              value={customStdin}
              aria-label="自定义 stdin 输入" placeholder="可选：输入将写入程序 stdin"
              onChange={(e) => setCustomStdin(e.target.value)}
            />
          </div>
          <div className="result-tabs">
            <button
              className={showResultTab === 'judge' ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setShowResultTab('judge')}
            >
              判题结果
            </button>
            <button
              className={showResultTab === 'run' ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setShowResultTab('run')}
            >
              运行输出
            </button>
            <button
              className={showResultTab === 'history' ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setShowResultTab('history')}
            >
              提交历史
            </button>
          </div>
          {showResultTab === 'judge' ? (
            judgeResult === null ? (
              <div className="empty-hint small">点击「判题」运行全部测试用例。</div>
            ) : (
              <JudgeResultPanel result={judgeResult} />
            )
          ) : showResultTab === 'run' ? (
            runResult === null ? (
              <div className="empty-hint small">点击「运行」以自定义输入执行代码（不计入记录）。</div>
            ) : (
              <RunResultPanel result={runResult} />
            )
          ) : (
            <HistoryPanel problemId={problem.id} />
          )}
        </div>
      </section>
    </div>
  )
}
