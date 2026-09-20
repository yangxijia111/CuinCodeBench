import type { RunOnceResult } from '@shared/ipc'

/**
 * 自定义运行结果面板（FR-C1）：stdout / stderr / 退出码 / 耗时。
 */
export function RunResultPanel({ result }: { result: RunOnceResult }): React.JSX.Element {
  if (result.error !== undefined) {
    return <div className="alert error">{result.error.message}</div>
  }

  const exec = result.execution
  if (exec === null) {
    return (
      <div className="compile-error">
        <div className="section-label">编译失败</div>
        <pre>{result.compile?.stderr || '（无输出）'}</pre>
      </div>
    )
  }

  const statusLabel: Record<string, string> = {
    ok: '正常结束',
    timeout: '超出时限（进程已终止）',
    output_limit: '输出超限（已截断，进程已终止）',
    spawn_error: `启动失败：${exec.stderr}`
  }

  return (
    <div className="run-result">
      <div className="judge-summary">
        <span className={`status-pill ${exec.status === 'ok' ? 'ok' : 'bad'}`}>{statusLabel[exec.status]}</span>
        <span className="judge-stats">
          退出码 {exec.exitCode ?? '—'} · 用时 {exec.durationMs} ms
        </span>
      </div>
      <div className="case-io">
        <span className="section-label">stdout{exec.stdoutTruncated ? '（已截断）' : ''}</span>
        <pre>{exec.stdout === '' ? '（无输出）' : exec.stdout}</pre>
      </div>
      {exec.stderr.trim() !== '' && (
        <div className="case-io">
          <span className="section-label">stderr{exec.stderrTruncated ? '（已截断）' : ''}</span>
          <pre className="stderr">{exec.stderr}</pre>
        </div>
      )}
    </div>
  )
}
