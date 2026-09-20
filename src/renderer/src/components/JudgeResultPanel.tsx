import { JUDGE_STATUS_META } from '@shared/types'
import type { JudgeResult } from '@shared/types'
import { truncateForDisplay } from '../lib/display'

/**
 * 判题结果面板：总体状态 + 逐用例展开（输入/期望/实际/耗时/状态，FR-J3）。
 */
export function JudgeResultPanel({ result }: { result: JudgeResult }): React.JSX.Element {
  const meta = JUDGE_STATUS_META[result.status]
  return (
    <div className="judge-result">
      <div className="judge-summary">
        <span className="status-pill" style={{ borderColor: meta.color, color: meta.color }}>
          {meta.label}
        </span>
        <span className="judge-stats">
          通过 {result.passedCount}/{result.totalCount} · 用时 {result.durationMs} ms
        </span>
      </div>

      {result.compile !== null && !result.compile.ok && (
        <div className="compile-error">
          <div className="section-label">编译器输出</div>
          <pre>{result.compile.stderr || `（exit code: ${result.compile.exitCode ?? 'signal'}）`}</pre>
        </div>
      )}

      {result.cases.length > 0 && (
        <div className="case-list">
          {result.cases.map((c) => {
            const cm = JUDGE_STATUS_META[c.status]
            return (
              <details key={c.testCaseId} className="case-item" open={c.status !== 'accepted'}>
                <summary>
                  <span className="case-index">用例 #{c.order + 1}</span>
                  <span className="status-pill small" style={{ borderColor: cm.color, color: cm.color }}>
                    {cm.label}
                  </span>
                  <span className="case-duration">{c.durationMs} ms</span>
                </summary>
                <div className="case-detail">
                  <div className="case-io">
                    <span className="section-label">输入</span>
                    <pre>{c.stdin === '' ? '（空输入）' : c.stdin}</pre>
                  </div>
                  <div className="case-io">
                    <span className="section-label">期望输出</span>
                    <pre>{truncateForDisplay(c.expected)}</pre>
                  </div>
                  <div className="case-io">
                    <span className="section-label">实际输出</span>
                    <pre>{c.actual === null ? '（未运行）' : truncateForDisplay(c.actual)}</pre>
                  </div>
                  {c.stderr.trim() !== '' && (
                    <div className="case-io">
                      <span className="section-label">stderr</span>
                      <pre className="stderr">{truncateForDisplay(c.stderr)}</pre>
                    </div>
                  )}
                  {c.exitCode !== null && c.exitCode !== 0 && (
                    <div className="case-io">
                      <span className="section-label">退出码</span>
                      <pre>
                        {c.exitCode}
                        {isWindowsCrashCode(c.exitCode) ? `（0x${(c.exitCode >>> 0).toString(16).toUpperCase()}，访问违例/崩溃）` : ''}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}

function isWindowsCrashCode(code: number): boolean {
  const unsigned = code >>> 0
  return unsigned >= 0x80000000 && unsigned <= 0xffffffff && unsigned !== 0xffffffff
}
