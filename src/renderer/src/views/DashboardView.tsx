import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JUDGE_STATUS_META, MASTERY_STATUS_META } from '@shared/types'
import type { DashboardV2Stats, LanguageId, MasteryHeatmapEntry, TrendPoint } from '@shared/types'
import { useApiData } from '../api/client'

/**
 * Dashboard 2.0（v1.2 P6）：练习/复习总览、7/30 天趋势（自研 SVG 柱状图）、
 * Knowledge Heatmap（点击进入学习路线）、语言分布、错误类型、最近练习。
 */
export function DashboardView(): React.JSX.Element {
  const stats = useApiData<DashboardV2Stats>(() => window.api.getDashboardV2Stats(), [])
  const [trendDays, setTrendDays] = useState<7 | 30>(7)
  const navigate = useNavigate()

  if (stats.error !== null) return <div className="page"><div className="alert error">{stats.error}</div></div>
  if (stats.loading || stats.data === null) return <div className="page">加载中…</div>

  const d = stats.data
  const langTotal = d.languageCounts.c + d.languageCounts.cpp + d.languageCounts.python
  const trend = trendDays === 7 ? d.trend7 : d.trend30

  return (
    <div className="page dashboard">
      <div className="page-header">
        <h2>统计</h2>
        <span className="header-note">全部数据保存在本机</span>
      </div>

      <div className="stat-cards">
        <StatCard label="今日提交" value={`${d.todaySubmissions}`} />
        <StatCard label="今日复习" value={`${d.todayReviews}`} sub={`待复习 ${d.dueReviewCount} 项`} />
        <StatCard label="错题待复习" value={`${d.mistakeDueCount}`} />
        <StatCard label="连续学习" value={`${d.streakDays} 天`} />
        <StatCard label="已通过题目" value={`${d.acceptedProblems}`} sub={`题库共 ${d.totalProblemsInBank} 题`} />
        <StatCard
          label="正确率"
          value={d.totalSubmissions === 0 ? '—' : `${Math.round(d.accuracy * 100)}%`}
          sub={`${d.totalSubmissions} 次提交`}
        />
      </div>

      <div className="dash-grid">
        <section className="dash-card wide">
          <h3>
            学习趋势
            <span className="trend-switch">
              <button className={trendDays === 7 ? 'active' : ''} onClick={() => setTrendDays(7)}>7 天</button>
              <button className={trendDays === 30 ? 'active' : ''} onClick={() => setTrendDays(30)}>30 天</button>
            </span>
          </h3>
          <TrendChart points={trend} />
        </section>

        <section className="dash-card wide">
          <h3>知识点掌握度</h3>
          {d.masteryList.length === 0 ? (
            <div className="empty-hint small">暂无知识点（学习路线灌入后显示）</div>
          ) : (
            <div className="mastery-heatmap">
              {d.masteryList.map((m) => (
                <HeatmapRow key={m.knowledgePointId} entry={m} onClick={() => void navigate('/learning')} />
              ))}
            </div>
          )}
        </section>

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

/** 自研轻量 SVG 柱状趋势图：每日提交（蓝）与 AC（绿）叠加，复习（黄）在下方 */
function TrendChart(props: { points: TrendPoint[] }): React.JSX.Element {
  const { points } = props
  const max = Math.max(1, ...points.map((p) => Math.max(p.submissions, p.reviews)))
  const W = points.length * 14
  const H = 120
  const scale = (v: number): number => (v / max) * (H - 24)

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="学习趋势图">
        {points.map((p, i) => {
          const x = i * 14
          const hs = scale(p.submissions)
          const ha = scale(p.accepted)
          const hr = scale(p.reviews)
          const label = p.day.slice(5)
          return (
            <g key={p.day}>
              <rect x={x + 1} y={H - 12 - hr} width={4} height={hr} fill="#d29922" opacity={0.85}>
                <title>{`${p.day} 复习 ${p.reviews}`}</title>
              </rect>
              <rect x={x + 6} y={H - 12 - hs} width={6} height={hs} fill="#58a6ff" opacity={hs === 0 ? 0 : 0.9}>
                <title>{`${p.day} 提交 ${p.submissions}`}</title>
              </rect>
              <rect x={x + 6} y={H - 12 - ha} width={6} height={ha} fill="#3fb950" opacity={ha === 0 ? 0 : 0.9}>
                <title>{`${p.day} 通过 ${p.accepted}`}</title>
              </rect>
              {points.length <= 14 && (
                <text x={x + 4} y={H - 2} fontSize={7} fill="#8b949e" textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="trend-legend">
        <span className="legend-dot" style={{ background: '#58a6ff' }} /> 提交
        <span className="legend-dot" style={{ background: '#3fb950' }} /> 通过
        <span className="legend-dot" style={{ background: '#d29922' }} /> 复习
      </div>
    </div>
  )
}

function HeatmapRow(props: { entry: MasteryHeatmapEntry; onClick: () => void }): React.JSX.Element {
  const { entry, onClick } = props
  const meta = MASTERY_STATUS_META[entry.status]
  return (
    <div
      className="heatmap-row"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick()
      }}
    >
      <span className="heatmap-name">{entry.name}</span>
      <div className="heatmap-track">
        <div className="heatmap-fill" style={{ width: `${entry.score}%`, backgroundColor: meta.color }} />
      </div>
      <span className="heatmap-score">{entry.score}</span>
      <span className="mastery-chip" style={{ color: meta.color, borderColor: meta.color }}>
        {meta.label}
      </span>
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
