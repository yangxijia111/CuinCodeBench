import { JUDGE_STATUS_META } from '@shared/types'
import type { DashboardStats, LanguageId } from '@shared/types'
import { useApiData } from '../api/client'

/**
 * Dashboard（FR-D1–D3）：练习总量、正确率、连续天数、语言分布、常见错误、最近练习。
 */
export function DashboardView(): React.JSX.Element {
  const stats = useApiData<DashboardStats>(() => window.api.getDashboardStats(), [])

  if (stats.error !== null) return <div className="page"><div className="alert error">{stats.error}</div></div>
  if (stats.loading || stats.data === null) return <div className="page">加载中…</div>

  const d = stats.data
  const langTotal = d.languageCounts.c + d.languageCounts.cpp + d.languageCounts.python

  return (
    <div className="page dashboard">
      <div className="page-header">
        <h2>统计</h2>
        <span className="header-note">全部数据保存在本机</span>
      </div>

      <div className="stat-cards">
        <StatCard label="已练题目" value={`${d.totalProblemsAttempted}`} sub={`题库共 ${d.totalProblemsInBank} 题`} />
        <StatCard label="已通过题目" value={`${d.acceptedProblems}`} />
        <StatCard label="正确率" value={d.totalSubmissions === 0 ? '—' : `${Math.round(d.accuracy * 100)}%`} sub={`${d.totalSubmissions} 次提交`} />
        <StatCard label="今日提交" value={`${d.todaySubmissions}`} />
        <StatCard label="连续练习" value={`${d.streakDays} 天`} />
      </div>

      <div className="dash-grid">
        <section className="dash-card">
          <h3>语言使用</h3>
          {langTotal === 0 ? (
            <div className="empty-hint small">暂无提交</div>
          ) : (
            <div className="lang-bars">
              <LangBar label="C" count={d.languageCounts.c} total={langTotal} color="#8b949e" />
              <LangBar label="C++" count={d.languageCounts.cpp} total={langTotal} color="#2f81f7" />
              <LangBar label="Python" count={d.languageCounts.python} total={langTotal} color="#3fb950" />
            </div>
          )}
        </section>

        <section className="dash-card">
          <h3>常见错误类型</h3>
          {d.errorTypeCounts.length === 0 ? (
            <div className="empty-hint small">暂无错误记录，继续保持！</div>
          ) : (
            <div className="error-type-list">
              {d.errorTypeCounts.map((e) => (
                <div key={e.type} className="error-type-row">
                  <span
                    className="status-pill small"
                    style={{
                      borderColor: JUDGE_STATUS_META[e.type].color,
                      color: JUDGE_STATUS_META[e.type].color
                    }}
                  >
                    {JUDGE_STATUS_META[e.type].label}
                  </span>
                  <span className="error-count">× {e.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="dash-card wide">
          <h3>最近练习</h3>
          {d.recentSubmissions.length === 0 ? (
            <div className="empty-hint small">还没有提交记录，去题库开始第一道题吧。</div>
          ) : (
            <div className="recent-list">
              {d.recentSubmissions.map((s) => {
                const meta = JUDGE_STATUS_META[s.status]
                return (
                  <div key={s.id} className="recent-row">
                    <span className="recent-title">{s.problemTitle}</span>
                    <span className="recent-lang">{langLabel(s.language)}</span>
                    <span
                      className="status-pill small"
                      style={{ borderColor: meta.color, color: meta.color }}
                    >
                      {meta.label}
                    </span>
                    <span className="recent-passed">
                      {s.passedCount}/{s.totalCount}
                    </span>
                    <span className="recent-time">{formatShort(s.createdAt)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function StatCard(props: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="stat-card">
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.sub !== undefined && <div className="stat-sub">{props.sub}</div>}
    </div>
  )
}

function LangBar(props: { label: string; count: number; total: number; color: string }): React.JSX.Element {
  const pct = props.total === 0 ? 0 : Math.round((props.count / props.total) * 100)
  return (
    <div className="lang-bar-row">
      <span className="lang-bar-label">{props.label}</span>
      <div className="lang-bar-track">
        <div className="lang-bar-fill" style={{ width: `${pct}%`, backgroundColor: props.color }} />
      </div>
      <span className="lang-bar-count">
        {props.count}（{pct}%）
      </span>
    </div>
  )
}

function langLabel(lang: LanguageId): string {
  return lang === 'cpp' ? 'C++' : lang.toUpperCase()
}

function formatShort(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return sameDay ? `今天 ${time}` : d.toLocaleDateString('zh-CN') + ' ' + time
}
