import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DIFFICULTY_META, } from '@shared/ipc'
import { MASTERY_STATUS_META } from '@shared/types'
import type { PathProgress, StageProgress, KnowledgePointProgress } from '@shared/types'
import { useApiData } from '../api/client'

/**
 * 学习路线页（v1.2 P2）：阶段 → 知识点 → 完成度/掌握状态 → 点击知识点展开题目开始练习。
 * 数据来源 learning.paths / learning.kpProblems。
 */

function ProgressPct(props: { accepted: number; total: number }): React.JSX.Element {
  const { accepted, total } = props
  const pct = total === 0 ? 0 : Math.round((accepted / total) * 100)
  return (
    <div className="lp-progress">
      <div className="lp-progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="lp-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="lp-progress-text">{pct}%</span>
    </div>
  )
}

function KpCard(props: { kp: KnowledgePointProgress }): React.JSX.Element {
  const { kp } = props
  const meta = MASTERY_STATUS_META[kp.mastery?.status ?? 'not_started']
  const [expanded, setExpanded] = useState(false)
  const [problems, setProblems] = useState<
    { id: string; title: string; difficulty: string; accepted: boolean; attempts: number }[] | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function loadProblems(): Promise<void> {
    try {
      const list = await window.api.listKpProblems(kp.knowledgePoint.id)
      if (list.ok) setProblems(list.data)
      else setError(list.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleToggle(): void {
    if (!expanded && problems === null && error === null) void loadProblems()
    setExpanded(!expanded)
  }

  return (
    <div className="lp-kp">
      <button className="lp-kp-head" onClick={handleToggle} aria-expanded={expanded}>
        <span className="mastery-dot" style={{ background: meta.color }} title={meta.label} />
        <span className="lp-kp-name">{kp.knowledgePoint.name}</span>
        <span className="lp-kp-count">
          {kp.acceptedProblems} / {kp.totalProblems}
        </span>
        <span className={`mastery-chip mastery-${kp.mastery?.status ?? 'not_started'}`}>{meta.label}</span>
        <span className="lp-kp-caret">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="lp-kp-body">
          {kp.knowledgePoint.description !== '' && (
            <p className="lp-kp-desc">{kp.knowledgePoint.description}</p>
          )}
          {error !== null && <div className="alert error">{error}</div>}
          {problems === null ? (
            <div className="empty-hint small">加载中…</div>
          ) : problems.length === 0 ? (
            <div className="empty-hint small">该知识点暂无关联题目（可在题目编辑中绑定）</div>
          ) : (
            <div className="lp-kp-problems">
              {problems.map((p) => (
                <div
                  key={p.id}
                  className="lp-kp-problem"
                  onClick={() => void navigate(`/practice/${p.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void navigate(`/practice/${p.id}`)
                  }}
                >
                  <span className={`difficulty-dot diff-${p.difficulty}`} />
                  <span className="lp-kp-problem-title">{p.title}</span>
                  {p.accepted && <span className="badge accepted">已通过</span>}
                  <span className="lp-kp-problem-meta">
                    {DIFFICULTY_META[p.difficulty as 'easy' | 'medium' | 'hard']?.label ?? p.difficulty}
                    {p.attempts > 0 ? ` · ${p.attempts} 次尝试` : ' · 未尝试'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StageCard(props: { stage: StageProgress }): React.JSX.Element {
  const { stage } = props
  return (
    <section className="lp-stage">
      <header className="lp-stage-head">
        <div className="lp-stage-title-row">
          <h4>{stage.title}</h4>
          <ProgressPct accepted={stage.acceptedProblems} total={stage.totalProblems} />
        </div>
        {stage.description !== '' && <p className="lp-stage-desc">{stage.description}</p>}
      </header>
      <div className="lp-stage-kps">
        {stage.knowledgePoints.map((kp) => (
          <KpCard key={kp.knowledgePoint.id} kp={kp} />
        ))}
      </div>
    </section>
  )
}

export function LearningPathView(): React.JSX.Element {
  const paths = useApiData<PathProgress[]>(() => window.api.listLearningPaths(), [])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const list = paths.data ?? []
  const current = list.find((p) => p.id === selectedId) ?? list[0]

  return (
    <div className="page learning-path">
      <div className="page-header">
        <h2>学习路线</h2>
      </div>

      {paths.error !== null && <div className="alert error">加载失败：{paths.error}</div>}

      {list.length > 1 && (
        <div className="lp-tabs">
          {list.map((p) => (
            <button
              key={p.id}
              className={current?.id === p.id ? 'active' : ''}
              onClick={() => setSelectedId(p.id)}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}

      {paths.loading ? (
        <div className="empty-hint">加载中…</div>
      ) : current === undefined ? (
        <div className="empty-hint">暂无学习路线</div>
      ) : (
        <>
          <div className="lp-overview card">
            <div className="lp-overview-head">
              <h3>{current.title}</h3>
              <ProgressPct accepted={current.acceptedProblems} total={current.totalProblems} />
            </div>
            <p className="lp-overview-desc">{current.description}</p>
            <div className="lp-overview-stats">
              <span>题目 {current.totalProblems}</span>
              <span>已通过 {current.acceptedProblems}</span>
              <span>阶段 {current.stages.length}</span>
            </div>
          </div>
          {current.stages.map((stage, i) => (
            <div key={stage.id} className="lp-stage-wrap">
              <div className="lp-stage-num">阶段 {i + 1}</div>
              <StageCard stage={stage} />
            </div>
          ))}
        </>
      )}
    </div>
  )
}
