import { useState } from 'react'
import { JUDGE_STATUS_META } from '@shared/types'
import type { Submission } from '@shared/types'
import type { SubmissionDetail } from '@shared/ipc'
import { HISTORY_PAGE_SIZE } from '@shared/constants'
import { useApiData, unwrap } from '../api/client'

/**
 * 提交历史面板（FR-H4）：当前题目的提交列表，点击展开单次提交明细。
 */
export function HistoryPanel({ problemId }: { problemId: string }): React.JSX.Element {
  const [page, setPage] = useState(0)
  const [detail, setDetail] = useState<SubmissionDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const subs = useApiData<Submission[]>(
    () => window.api.listSubmissions({ problemId, limit: HISTORY_PAGE_SIZE, offset: page * HISTORY_PAGE_SIZE }),
    [problemId, page]
  )

  async function openDetail(id: string): Promise<void> {
    if (detail?.id === id) {
      setDetail(null)
      return
    }
    try {
      const d = await unwrap(window.api.getSubmissionDetail(id))
      setDetail(d)
      setDetailError(null)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    }
  }

  const list = subs.data ?? []

  return (
    <div className="history-panel">
      {detailError !== null && <div className="alert error">{detailError}</div>}
      {subs.loading && list.length === 0 ? (
        <div className="empty-hint small">加载中…</div>
      ) : list.length === 0 ? (
        <div className="empty-hint small">本题还没有提交记录。</div>
      ) : (
        <>
          <div className="recent-list">
            {list.map((s) => {
              const meta = JUDGE_STATUS_META[s.status]
              const expanded = detail?.id === s.id
              return (
                <div key={s.id}>
                  <div
                    className={expanded ? 'recent-row clickable open' : 'recent-row clickable'}
                    onClick={() => void openDetail(s.id)}
                  >
                    <span className="recent-lang">{s.language === 'cpp' ? 'C++' : s.language.toUpperCase()}</span>
                    <span
                      className="status-pill small"
                      style={{ borderColor: meta.color, color: meta.color }}
                    >
                      {meta.label}
                    </span>
                    <span className="recent-passed">
                      {s.passedCount}/{s.totalCount}
                    </span>
                    <span className="recent-time">
                      {new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </span>
                  </div>
                  {expanded && detail !== null && (
                    <div className="history-detail">
                      {detail.code !== '' && (
                        <details className="case-item">
                          <summary>
                            <span className="case-index">提交代码</span>
                          </summary>
                          <pre className="history-code">{detail.code}</pre>
                        </details>
                      )}
                      {detail.results.length > 0 && (
                        <div className="case-list">
                          {detail.results.map((c) => {
                            const cm = JUDGE_STATUS_META[c.status]
                            return (
                              <details key={c.testCaseId} className="case-item" open={false}>
                                <summary>
                                  <span className="case-index">用例 #{c.order + 1}</span>
                                  <span
                                    className="status-pill small"
                                    style={{ borderColor: cm.color, color: cm.color }}
                                  >
                                    {cm.label}
                                  </span>
                                  <span className="case-duration">{c.durationMs} ms</span>
                                </summary>
                                <div className="case-detail">
                                  <div className="case-io">
                                    <span className="section-label">期望输出</span>
                                    <pre>{c.expected}</pre>
                                  </div>
                                  <div className="case-io">
                                    <span className="section-label">实际输出</span>
                                    <pre>{c.actual ?? '（未运行）'}</pre>
                                  </div>
                                </div>
                              </details>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="pager">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span className="pager-info">第 {page + 1} 页</span>
            <button disabled={list.length < HISTORY_PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  )
}
