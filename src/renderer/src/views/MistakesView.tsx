import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ERROR_CATEGORY_META, ERROR_CATEGORIES, JUDGE_STATUS_META } from '@shared/types'
import type { ErrorCategory, MistakeBookEntry, MistakeHistoryEntry } from '@shared/types'
import { useApiData, unwrap, ApiError } from '../api/client'

/**
 * 错题本（FR-M2–M4）+ 错题复盘（v1.2 P5）：
 * 失败次数 ≥ 2 的未掌握题目列表；展开显示错误历史、错因笔记与学习错误分类。
 */
export function MistakesView(): React.JSX.Element {
  const navigate = useNavigate()
  const mistakes = useApiData<MistakeBookEntry[]>(() => window.api.listMistakes(), [])
  const [expanded, setExpanded] = useState<string | null>(null)

  async function toggleMastered(entry: MistakeBookEntry): Promise<void> {
    try {
      await unwrap(window.api.setMistakeMastered(entry.problemId, !entry.mastered))
      mistakes.reload()
    } catch (e) {
      window.alert(e instanceof ApiError ? e.message : String(e))
    }
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>错题本</h2>
        <span className="header-note">失败 ≥ 2 次的题目自动收录；通过后仍保留（观察态），直到你标记「已掌握」</span>
      </div>

      {mistakes.error !== null && <div className="alert error">加载失败：{mistakes.error}</div>}
      {mistakes.loading ? (
        <div className="empty-hint">加载中…</div>
      ) : (mistakes.data ?? []).length === 0 ? (
        <div className="empty-hint">错题本是空的。继续练习，遇到反复失败的题目这里会帮你记下来。</div>
      ) : (
        <div className="mistake-list">
          {(mistakes.data ?? []).map((m) => (
            <div key={m.problemId} className="mistake-item">
              <div className="mistake-main">
                <div className="mistake-title-row">
                  <span className="problem-title">{m.problemTitle}</span>
                  <span className="fail-badge">失败 {m.failedCount} 次</span>
                </div>
                <div className="mistake-meta">
                  <span>最近错误：</span>
                  <span
                    className="status-pill small"
                    style={{
                      borderColor: JUDGE_STATUS_META[m.lastErrorType].color,
                      color: JUDGE_STATUS_META[m.lastErrorType].color
                    }}
                  >
                    {JUDGE_STATUS_META[m.lastErrorType].label}
                  </span>
                  <span className="meta-time">{formatDate(m.lastFailedAt)}</span>
                </div>
                <div className="mistake-meta">
                  <span>错误分布：</span>
                  {m.errorTypeCounts.map((ec) => (
                    <span key={ec.type} className="tag">
                      {JUDGE_STATUS_META[ec.type].label} × {ec.count}
                    </span>
                  ))}
                </div>
                <MistakeDetail problemId={m.problemId} expanded={expanded === m.problemId} formatDate={formatDate} />
              </div>
              <div className="mistake-actions">
                <button
                  onClick={() => setExpanded(expanded === m.problemId ? null : m.problemId)}
                >
                  {expanded === m.problemId ? '收起复盘' : '错误复盘'}
                </button>
                <button className="primary" onClick={() => void navigate(`/practice/${m.problemId}`)}>
                  重新练习
                </button>
                <button onClick={() => void toggleMastered(m)}>标记已掌握</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MistakeDetail(props: {
  problemId: string
  expanded: boolean
  formatDate: (ts: number) => string
}): React.JSX.Element | null {
  const { problemId, expanded, formatDate } = props
  const [history, setHistory] = useState<MistakeHistoryEntry[] | null>(null)
  const [firstLatest, setFirstLatest] = useState<{ firstCode: string | null; latestCode: string | null } | null>(null)
  const [note, setNote] = useState('')
  const [noteDirty, setNoteDirty] = useState(false)
  const [category, setCategory] = useState<string>('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || history !== null) return
    let alive = true
    void (async () => {
      try {
        const [h, fl, n, cat] = await Promise.all([
          unwrap(window.api.getMistakeHistory(problemId)),
          unwrap(window.api.getMistakeFirstLatestCode(problemId)),
          unwrap(window.api.getMistakeNote(problemId)),
          unwrap(window.api.getMistakeLatestCategory(problemId))
        ])
        if (!alive) return
        setHistory(h)
        setFirstLatest(fl)
        setNote(n?.note ?? '')
        setCategory(cat ?? '')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [expanded, problemId, history])

  async function saveNote(): Promise<void> {    try {
      await unwrap(window.api.setMistakeNote(problemId, note))
      setNoteDirty(false)
      setMessage('笔记已保存')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function saveCategory(cat: string): Promise<void> {
    setCategory(cat)
    if (cat === '') return
    try {
      await unwrap(window.api.setMistakeCategory(problemId, cat as ErrorCategory))
      setMessage('错误分类已保存')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!expanded) return null

  return (
    <div className="mistake-detail">
      {error !== null && <div className="alert error">{error}</div>}
      {message !== null && <div className="alert info">{message}</div>}

      {history === null ? (
        <div className="empty-hint small">加载错误历史…</div>
      ) : (
        <>
          {firstLatest !== null && firstLatest.firstCode !== null && (
            <div className="mistake-code-compare">
              {firstLatest.latestCode !== null && firstLatest.latestCode !== firstLatest.firstCode && (
                <details>
                  <summary>对比首次错误代码</summary>
                  <pre className="mono">{firstLatest.firstCode}</pre>
                </details>
              )}
            </div>
          )}

          <div className="mistake-history">
            <h4>错误历史（{history.length} 次）</h4>
            {history.map((h) => (
              <details key={h.submissionId} className="mistake-history-item">
                <summary>
                  <span
                    className="status-pill small"
                    style={{
                      borderColor: JUDGE_STATUS_META[h.status].color,
                      color: JUDGE_STATUS_META[h.status].color
                    }}
                  >
                    {JUDGE_STATUS_META[h.status].label}
                  </span>
                  <span className="tag">{h.language}</span>
                  <span className="meta-time">{formatDate(h.createdAt)}</span>
                  {h.learningCategory !== null && (
                    <span className="tag">{ERROR_CATEGORY_META[h.learningCategory].label}</span>
                  )}
                </summary>
                {h.message !== '' && <p className="mistake-history-msg">{h.message}</p>}
                <pre className="mono mistake-code">{h.code}</pre>
              </details>
            ))}
          </div>

          <div className="mistake-note-row">
            <h4>错误原因笔记</h4>
            <textarea
              rows={2}
              placeholder="例如：忘记 switch 里的 break / 数组循环多写了一次 <="
              value={note}
              onChange={(e) => {
                setNote(e.target.value)
                setNoteDirty(true)
              }}
            />
            <button className="primary" disabled={!noteDirty} onClick={() => void saveNote()}>
              保存笔记
            </button>
          </div>

          <div className="mistake-category-row">
            <h4>学习错误分类</h4>
            <select value={category} onChange={(e) => void saveCategory(e.target.value)}>
              <option value="">（选择分类，可选）</option>
              {ERROR_CATEGORIES.filter((c) => c !== 'unknown').map((c) => (
                <option key={c} value={c}>
                  {ERROR_CATEGORY_META[c].label}
                </option>
              ))}
            </select>
            <span className="settings-note">编译错误自动记为「语法」，超时自动记为「算法效率」；其余建议手动归类。</span>
          </div>
        </>
      )}
    </div>
  )
}
