import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DIFFICULTY_META } from '@shared/ipc'
import type { Difficulty, KnowledgePoint, Problem } from '@shared/types'
import { useApiData, unwrap, ApiError } from '../api/client'

/**
 * 题库列表页：搜索 / 难度筛选 / 标签筛选 / 新建 / 导入导出 / 删除（FR-P3–P5）。
 * v1.2：随机练习入口（按难度/标签/知识点/范围组题）。
 */
export function ProblemsView(): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all')
  const [tag, setTag] = useState('all')
  const [actionError, setActionError] = useState<string | null>(null)
  const [randomOpen, setRandomOpen] = useState(false)
  const [randomBusy, setRandomBusy] = useState(false)
  const [randDiff, setRandDiff] = useState<Difficulty | 'all'>('all')
  const [randScope, setRandScope] = useState<'all' | 'unsolved' | 'mistakes' | 'weak'>('all')
  const [randSize, setRandSize] = useState(10)
  const [kpFilter, setKpFilter] = useState('all')
  const navigate = useNavigate()

  const problems = useApiData<Problem[]>(
    () => window.api.listProblems({ keyword, difficulty, tag, knowledgePointId: kpFilter }),
    [keyword, difficulty, tag, kpFilter]
  )
  const tags = useApiData<string[]>(() => window.api.listTags(), [])
  const kps = useApiData<KnowledgePoint[]>(() => window.api.listAllKnowledgePoints(), [])

  async function handleStartRandom(): Promise<void> {
    setRandomBusy(true)
    setActionError(null)
    try {
      const s = await unwrap(
        window.api.createRandomSession({
          difficulty: randDiff,
          scope: randScope,
          size: randSize
        })
      )
      void navigate(`/session/${s.id}`)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRandomBusy(false)
    }
  }

  async function handleDelete(id: string, title: string): Promise<void> {
    if (!window.confirm(`确定删除题目「${title}」？该题的测试用例与提交历史将一并删除。`)) return
    try {
      await unwrap(window.api.deleteProblem(id))
      problems.reload()
      tags.reload()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
    }
  }

  async function handleExport(): Promise<void> {
    try {
      const json = await unwrap(window.api.exportProblems(null))
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cuincodebench-problems-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleImportFile(file: File): Promise<void> {
    try {
      const text = await file.text()
      const res = await unwrap(window.api.importProblems(text))
      setActionError(null)
      window.alert(`成功导入 ${res.imported} 道题目`)
      problems.reload()
      tags.reload()
    } catch (e) {
      setActionError(e instanceof Error ? `导入失败：${e.message}` : String(e))
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>题库</h2>
        <div className="header-actions">
          <button onClick={() => setRandomOpen(!randomOpen)}>随机练习</button>
          <button onClick={() => void handleImportFileFromPicker(handleImportFile)}>导入 JSON</button>
          <button onClick={() => void handleExport()}>导出全部</button>
          <button className="primary" onClick={() => void navigate('/problems/new')}>
            新建题目
          </button>
        </div>
      </div>

      {randomOpen && (
        <div className="random-config card">
          <span className="form-label">随机练习</span>
          <select aria-label="随机练习难度" value={randDiff} onChange={(e) => setRandDiff(e.target.value as Difficulty | 'all')}>
            <option value="all">全部难度</option>
            <option value="easy">简单</option>
            <option value="medium">中等</option>
            <option value="hard">困难</option>
          </select>
          <select
            aria-label="随机练习范围"
            value={randScope}
            onChange={(e) => setRandScope(e.target.value as 'all' | 'unsolved' | 'mistakes' | 'weak')}
          >
            <option value="all">全部题目</option>
            <option value="unsolved">未做过的题</option>
            <option value="mistakes">错题</option>
            <option value="weak">低掌握度题</option>
          </select>
          <select aria-label="会话题数" value={randSize} onChange={(e) => setRandSize(Number(e.target.value))}>
            {[5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n} 题
              </option>
            ))}
          </select>
          <button className="primary" disabled={randomBusy} onClick={() => void handleStartRandom()}>
            {randomBusy ? '组题中…' : '开始'}
          </button>
        </div>
      )}

      <div className="filter-bar">
        <input
          type="search"
          aria-label="搜索题目"
          placeholder="搜索标题或描述…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <select aria-label="难度筛选" value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty | 'all')}>
          <option value="all">全部难度</option>
          <option value="easy">简单</option>
          <option value="medium">中等</option>
          <option value="hard">困难</option>
        </select>
        <select aria-label="标签筛选" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="all">全部标签</option>
          {(tags.data ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select aria-label="知识点筛选" value={kpFilter} onChange={(e) => setKpFilter(e.target.value)}>
          <option value="all">全部知识点</option>
          {(kps.data ?? []).map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </div>

      {actionError !== null && <div className="alert error">{actionError}</div>}
      {problems.error !== null && <div className="alert error">加载失败：{problems.error}</div>}

      {problems.loading ? (
        <div className="empty-hint">加载中…</div>
      ) : (problems.data ?? []).length === 0 ? (
        <div className="empty-hint">没有符合条件的题目。点击右上角「新建题目」创建第一道题。</div>
      ) : (
        <div className="problem-list">
          {(problems.data ?? []).map((p) => (
            <div key={p.id} className="problem-item" onClick={() => void navigate(`/practice/${p.id}`)}>
              <div className="problem-item-main">
                <span className={`difficulty-dot diff-${p.difficulty}`} />
                <span className="problem-title">{p.title}</span>
                {p.isBuiltin && <span className="badge">内置</span>}
              </div>
              <div className="problem-item-meta">
                <span className={`difficulty-label diff-${p.difficulty}`}>
                  {DIFFICULTY_META[p.difficulty].label}
                </span>
                <span className="tags">
                  {p.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </span>
                <span className="item-actions">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void navigate(`/problems/${p.id}/edit`)
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(p.id, p.title)
                    }}
                  >
                    删除
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 文件选择（renderer 无 Node fs，经 input[type=file] 拿到 File 对象） */
function handleImportFileFromPicker(onFile: (f: File) => Promise<void>): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = () => {
    const f = input.files?.[0]
    if (f) void onFile(f)
  }
  input.click()
}
