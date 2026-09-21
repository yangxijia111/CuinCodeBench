import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { LanguageId, ProblemDetail, JudgeResult } from '@shared/types'
import type { RunOnceResult } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/types'
import { DIFFICULTY_META } from '@shared/ipc'
import { unwrap, ApiError } from '../api/client'
import { MarkdownView } from '../components/MarkdownView'
import { CodeEditor } from '../components/CodeEditor'
import { JudgeResultPanel } from '../components/JudgeResultPanel'
import { RunResultPanel } from '../components/RunResultPanel'
import { HistoryPanel } from '../components/HistoryPanel'

/**
 * 练习页：左题面 / 右编辑器 + 结果（FR-E1–E6、FR-C1、FR-J3）。
 * 草稿按 (problemId, language) 存 localStorage（FR-E6）。
 */

const LANGUAGES: { id: LanguageId; label: string }[] = [
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'python', label: 'Python' }
]

function draftKey(problemId: string, lang: LanguageId): string {
  return `ccbench.draft.${problemId}.${lang}`
}

export function PracticeView(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()

  const [problem, setProblem] = useState<ProblemDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [language, setLanguage] = useState<LanguageId>('python')
  const [codeByLang, setCodeByLang] = useState<Record<LanguageId, string>>({
    c: '',
    cpp: '',
    python: ''
  })

  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [judging, setJudging] = useState(false)
  const [running, setRunning] = useState(false)
  const [judgeResult, setJudgeResult] = useState<JudgeResult | null>(null)
  const [runResult, setRunResult] = useState<RunOnceResult | null>(null)
  const [customStdin, setCustomStdin] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [showResultTab, setShowResultTab] = useState<'judge' | 'run' | 'history'>('judge')

  // 加载题目 + 设置 + 恢复草稿
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
        setCodeByLang({
          c: loadDraft(p.id, 'c', p.initialCode.c),
          cpp: loadDraft(p.id, 'cpp', p.initialCode.cpp),
          python: loadDraft(p.id, 'python', p.initialCode.python)
        })
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  const currentCode = codeByLang[language]

  const setCode = useMemo(
    () => (value: string) => {
      setCodeByLang((prev) => ({ ...prev, [language]: value }))
      if (problem !== null) {
        // 草稿保存（FR-E6）；与初始代码一致时清除草稿
        const initial = problem.initialCode[language] ?? ''
        if (value === initial) localStorage.removeItem(draftKey(problem.id, language))
        else localStorage.setItem(draftKey(problem.id, language), value)
      }
    },
    [language, problem]
  )

  async function handleJudge(): Promise<void> {
    if (problem === null || judging) return
    setJudging(true)
    setActionError(null)
    setRunResult(null)
    setShowResultTab('judge')
    try {
      const result = await unwrap(window.api.judgeSubmit(problem.id, language, currentCode))
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
        window.api.runOnce({ language, code: currentCode, stdin: customStdin, timeoutMs: settings.judgeTimeoutDefaultMs })
      )
      setRunResult(result)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  function handleReset(): void {
    if (problem === null) return
    if (!window.confirm('确定重置为初始代码？当前修改将丢失（判题历史不受影响）。')) return
    localStorage.removeItem(draftKey(problem.id, language))
    setCodeByLang((prev) => ({ ...prev, [language]: problem.initialCode[language] ?? '' }))
  }

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
          </div>
          <div className="editor-actions">
            <button onClick={handleReset}>重置代码</button>
            <button className="primary" disabled={running} onClick={() => void handleRun()}>
              {running ? '运行中…' : '运行'}
            </button>
            <button className="primary judge" disabled={judging} onClick={() => void handleJudge()}>
              {judging ? '判题中…' : '判题'}
            </button>
          </div>
        </div>

        <div className="editor-area">
          <CodeEditor
            value={currentCode}
            language={language}
            fontSize={settings.fontSize}
            tabSize={settings.tabSize}
            wordWrap={settings.wordWrap}
            onChange={setCode}
          />
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

function loadDraft(problemId: string, lang: LanguageId, initial: string): string {
  try {
    return localStorage.getItem(draftKey(problemId, lang)) ?? initial
  } catch {
    return initial
  }
}
