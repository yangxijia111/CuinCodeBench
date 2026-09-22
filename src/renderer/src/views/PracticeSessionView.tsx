import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { PracticeSession } from '@shared/types'
import { useApiData } from '../api/client'

/**
 * 练习会话页（v1.2 P7）：随机练习 / 专项训练的队列进度。
 * 点击题目跳练习页作答，判题结果经判题 hook 自动回报，完成后显示总结。
 */
export function PracticeSessionView(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const session = useApiData<PracticeSession | null>(() => window.api.getSession(id ?? ''), [id])
  const [summary, setSummary] = useState<{ total: number; answered: number; accepted: number; firstAccepted: number } | null>(null)
  const [error] = useState<string | null>(null)

  const s = session.data
  // 轮询刷新：练习页判题后回到本页能看到最新状态
  useEffect(() => {
    const t = setInterval(() => session.reload(), 3000)
    return () => {
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (s === null || s.status !== 'finished' || summary !== null) return
    void window.api
      .getSessionSummary(s.id)
      .then((res) => {
        if (res.ok) setSummary(res.data)
      })
      .catch(() => undefined)
  }, [s, summary])

  if (session.error !== null) {
    return <div className="page"><div className="alert error">{session.error}</div></div>
  }
  if (session.loading || s === null) return <div className="page">加载中…</div>

  const done = s.items.filter((i) => i.status !== 'pending' && i.status !== 'skipped').length
  const accepted = s.items.filter((i) => i.status === 'accepted').length
  const nextItem = s.items.find((i) => i.status === 'pending')

  return (
    <div className="page session-page">
      <div className="page-header">
        <h2>{s.kind === 'knowledge_point' ? '专项训练' : '随机练习'}</h2>
        <div className="header-actions">
          {s.status === 'active' && (
            <button
              className="danger"
              onClick={() => {
                void window.api.finishSession(s.id).then(() => session.reload())
              }}
            >
              结束会话
            </button>
          )}
        </div>
      </div>

      {error !== null && <div className="alert error">{error}</div>}

      <div className="review-progress">
        进度 {done} / {s.items.length} · 已通过 {accepted}
        {nextItem !== undefined && s.status === 'active' && (
          <button className="primary review-next-btn" onClick={() => void navigate(`/practice/${nextItem.problemId}`)}>
            开始下一题 →
          </button>
        )}
      </div>

      {s.status === 'finished' && summary !== null && (
        <div className="session-summary card">
          <h3>会话总结</h3>
          <div className="review-summary-stats">
            <span>完成 <b>{summary.answered}</b> / {summary.total}</span>
            <span>通过 <b>{summary.accepted}</b> 题</span>
            <span>正确率 <b>{summary.answered === 0 ? 0 : Math.round((summary.accepted / summary.answered) * 100)}%</b></span>
            <span>首次 AC <b>{summary.firstAccepted}</b> 题</span>
          </div>
        </div>
      )}

      <div className="review-item-list">
        {s.items.map((item, idx) => (
          <div
            key={item.id}
            className={`review-item review-item-${item.status}`}
            onClick={() => void navigate(`/practice/${item.problemId}`)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void navigate(`/practice/${item.problemId}`)
            }}
          >
            <span>#{idx + 1}</span>
            <span className="review-item-status">
              {item.status === 'accepted' && '✅ 已通过'}
              {item.status === 'failed' && '❌ 未通过（可重试）'}
              {item.status === 'pending' && '⏳ 待完成'}
              {item.status === 'skipped' && '⏭ 已跳过'}
            </span>
            {item.attempts > 0 && <span className="review-item-hint">{item.attempts} 次提交</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
