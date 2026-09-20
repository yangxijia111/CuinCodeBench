import { useNavigate } from 'react-router-dom'
import { JUDGE_STATUS_META } from '@shared/types'
import type { MistakeBookEntry } from '@shared/types'
import { useApiData, unwrap, ApiError } from '../api/client'

/**
 * 错题本（FR-M2–M4）：失败次数 ≥ 2 的未掌握题目列表，支持重新练习与标记已掌握。
 */
export function MistakesView(): React.JSX.Element {
  const navigate = useNavigate()
  const mistakes = useApiData<MistakeBookEntry[]>(() => window.api.listMistakes(), [])

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
        <span className="header-note">失败 ≥ 2 次的题目自动收录；通过后仍保留，直到你标记「已掌握」</span>
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
              </div>
              <div className="mistake-actions">
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
