import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { REVIEW_GRADE_META } from '@shared/types'
import type { PracticeSession, ReviewGrade } from '@shared/types'
import { useApiData } from '../api/client'

/**
 * 复习页（v1.2 P4）：今日复习概览 → Review Session（跳练习页作答，判题自动回报）→ 完成页等级确认。
 */

type Phase = 'overview' | 'session' | 'confirm' | 'done'

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function ReviewView(): React.JSX.Element {
  const navigate = useNavigate()
  const today = useApiData(() => window.api.getReviewToday(), [])
  const [phase, setPhase] = useState<Phase>('overview')
  const [session, setSession] = useState<PracticeSession | null>(null)
  const [grades, setGrades] = useState<Record<string, ReviewGrade>>({})
  const [summary, setSummary] = useState<{ graded: number; nextReviewAt: Record<string, number> } | null>(null)
  const [size, setSize] = useState<number>(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 挂载时恢复未完成的复习会话
  useEffect(() => {
    let alive = true
    void window.api.getLatestActiveReviewSession().then((res) => {
      if (!alive) return
      if (res.ok && res.data !== null) {
        setSession(res.data)
        setPhase('session')
      }
    })
    return () => {
      alive = false
    }
  }, [])

  async function start(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await unwrapStart(size)
      if (res.session !== null) {
        setSession(res.session)
        setPhase('session')
        today.reload()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function unwrapStart(sz: number): Promise<{ session: PracticeSession | null; created: boolean }> {
    return window.api.startReviewSession(sz).then((r) => {
      if (!r.ok) throw new Error(r.message)
      return r.data
    })
  }

  async function confirmFinish(): Promise<void> {
    if (session === null) return
    setBusy(true)
    try {
      const res = await window.api.finishReviewSession(session.id, grades)
      if (!res.ok) throw new Error(res.message)
      setSummary({ graded: res.data.graded, nextReviewAt: res.data.nextReviewAt })
      setPhase('done')
      today.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function cancelSession(): Promise<void> {
    if (session === null) return
    setBusy(true)
    try {
      await window.api.cancelReviewSession(session.id)
      setSession(null)
      setPhase('overview')
      today.reload()
    } finally {
      setBusy(false)
    }
  }

  // —— 完成页 ——
  if (phase === 'done' && session !== null && summary !== null) {
    const answered = session.items.filter((i) => i.status === 'accepted' || i.status === 'failed')
    const accepted = session.items.filter((i) => i.status === 'accepted').length
    return (
      <div className="page review-page">
        <div className="page-header"><h2>复习完成</h2></div>
        <div className="review-summary">
          <div className="review-summary-stats">
            <span>本次复习 <b>{answered.length}</b> 题</span>
            <span>正确 <b>{accepted}</b> 题</span>
            <span>正确率 <b>{answered.length === 0 ? 0 : Math.round((accepted / answered.length) * 100)}%</b></span>
            <span>已评分 <b>{summary.graded}</b> 项</span>
          </div>
          <h3>下次复习时间</h3>
          <ul className="review-next-list">
            {Object.entries(summary.nextReviewAt).map(([targetId, ts]) => (
              <NextLabel key={targetId} targetId={targetId} ts={ts} />
            ))}
          </ul>
          <button className="primary" onClick={() => { setSession(null); setPhase('overview') }}>
            返回
          </button>
        </div>
      </div>
    )
  }

  // —— 等级确认页 ——
  if (phase === 'confirm' && session !== null) {
    const answered = session.items.filter((i) => i.status === 'accepted' || i.status === 'failed')
    return (
      <div className="page review-page">
        <div className="page-header"><h2>复习结果确认</h2></div>
        {error !== null && <div className="alert error">{error}</div>}
        <p className="settings-note">为每道题确认记忆等级（已按做题结果预选：通过 → 掌握，失败 → 重学）：</p>
        <div className="review-grade-list">
          {answered.map((item, idx) => (
            <div key={item.id} className="review-grade-row">
              <span className="review-grade-title">#{idx + 1} {item.problemId.slice(0, 8)}…</span>
              {item.status === 'accepted' ? <span className="badge accepted">已通过</span> : <span className="badge">未通过</span>}
              <div className="review-grade-options">
                {(['again', 'hard', 'good', 'easy'] as ReviewGrade[]).map((g) => (
                  <label key={g} className="review-grade-option">
                    <input
                      type="radio"
                      name={`grade-${item.problemId}`}
                      checked={(grades[item.problemId] ?? (item.status === 'accepted' ? 'good' : 'again')) === g}
                      onChange={() => setGrades((prev) => ({ ...prev, [item.problemId]: g }))}
                    />
                    {REVIEW_GRADE_META[g].label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="header-actions">
          <button onClick={() => setPhase('session')}>返回会话</button>
          <button className="primary" disabled={busy} onClick={() => void confirmFinish()}>
            {busy ? '提交中…' : '确认完成复习'}
          </button>
        </div>
      </div>
    )
  }

  // —— 会话进行中 ——
  if (phase === 'session' && session !== null) {
    const done = session.items.filter((i) => i.status !== 'pending' && i.status !== 'skipped').length
    const allAnswered = done === session.items.length && session.items.length > 0
    const nextItem = session.items.find((i) => i.status === 'pending')
    return (
      <div className="page review-page">
        <div className="page-header">
          <h2>今日复习</h2>
          <div className="header-actions">
            <button className="danger" disabled={busy} onClick={() => void cancelSession()}>放弃会话</button>
          </div>
        </div>
        {error !== null && <div className="alert error">{error}</div>}
        <div className="review-progress">
          进度 {done} / {session.items.length}
          {nextItem !== undefined && (
            <button className="primary review-next-btn" onClick={() => void navigate(`/practice/${nextItem.problemId}`)}>
              开始下一题 →
            </button>
          )}
        </div>
        <div className="review-item-list">
          {session.items.map((item, idx) => (
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
                {item.status === 'failed' && '❌ 未通过'}
                {item.status === 'pending' && '⏳ 待复习'}
                {item.status === 'skipped' && '⏭ 已跳过'}
              </span>
              <span className="review-item-hint">点击前往练习页作答，判题结果自动回报</span>
            </div>
          ))}
        </div>
        {allAnswered && (
          <div className="review-finish-row">
            <button className="primary" onClick={() => setPhase('confirm')}>
              全部作答完成 → 确认记忆等级
            </button>
          </div>
        )}
      </div>
    )
  }

  // —— 概览 ——
  const t = today.data
  return (
    <div className="page review-page">
      <div className="page-header"><h2>今日复习</h2></div>
      {today.error !== null && <div className="alert error">{today.error}</div>}
      {error !== null && <div className="alert error">{error}</div>}
      {today.loading || t === null ? (
        <div className="empty-hint">加载中…</div>
      ) : (
        <div className="review-overview">
          <div className="review-overview-count card">
            <div className="review-count-num">{t.dueCount}</div>
            <div className="review-count-label">今日待复习</div>
          </div>
          {t.byKnowledgePoint.length > 0 && (
            <div className="review-overview-kps">
              {t.byKnowledgePoint.map((kp) => (
                <span key={kp.name} className="review-kp-chip">
                  {kp.name} ×{kp.count}
                </span>
              ))}
            </div>
          )}
          <div className="review-size-row">
            <span>会话题数：</span>
            {[5, 10, 20].map((n) => (
              <label key={n} className="review-size-option">
                <input type="radio" checked={size === n} onChange={() => setSize(n)} />
                {n} 题
              </label>
            ))}
          </div>
          <button className="primary review-start-btn" disabled={busy || t.dueCount === 0} onClick={() => void start()}>
            {busy ? '组题中…' : t.dueCount === 0 ? '今日无待复习项' : '开始今日复习'}
          </button>
          <p className="settings-note privacy-note">
            复习项来源：错题本中的题目（入选即到期）与开始学习的知识点（次日进入循环）。复习通过做题完成，结果自动映射记忆等级，可手动调整。
          </p>
        </div>
      )}
    </div>
  )
}

function NextLabel(props: { targetId: string; ts: number }): React.JSX.Element {
  const [name, setName] = useState(props.targetId)
  useEffect(() => {
    let alive = true
    void window.api.listAllKnowledgePoints().then((res) => {
      if (!alive || !res.ok) return
      const kp = res.data.find((k) => k.id === props.targetId)
      if (kp !== undefined) setName(kp.name)
    })
    return () => {
      alive = false
    }
  }, [props.targetId])
  return (
    <li>
      {name}：<b>{fmtDate(props.ts)}</b>
    </li>
  )
}
