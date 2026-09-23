import { useEffect, useState } from 'react'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, JUDGE_TIMEOUT_MAX_MS, JUDGE_TIMEOUT_MIN_MS } from '@shared/constants'
import type { AppSettings, LanguageId, Toolchain } from '@shared/types'
import { unwrap, ApiError } from '../api/client'

/**
 * 设置页（FR-E4、FR-R10、NFR-6）：编辑器偏好、判题默认超时、工具链手工指定与重新检测。
 */
export function SettingsView(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dataDir, setDataDir] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [toolchains, setToolchains] = useState<Toolchain[] | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupPhase, setBackupPhase] = useState<string>('')

  /** 导出/恢复进行中轮询主进程状态（100ms 节流由主进程保证），展示阶段文案 */
  useEffect(() => {
    if (!backupBusy) return
    const timer = setInterval(() => {
      void unwrap(window.api.getBackupStatus()).then((st) => {
        if (st.restoring) {
          setBackupPhase(st.phase === 'staging' ? '正在写入临时数据库…' : st.phase === 'swap' ? '正在切换数据库…' : st.phase === 'reopen' ? '正在重新加载数据…' : '处理中…')
        } else if (st.exporting) {
          setBackupPhase('正在导出…')
        }
      }).catch(() => {})
    }, 200)
    return () => clearInterval(timer)
  }, [backupBusy])

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleString()
  }

  async function handleExportBackup(): Promise<void> {
    setBackupBusy(true)
    setMessage(null)
    setError(null)
    try {
      const res = await unwrap(window.api.exportBackup())
      if (!res.canceled) {
        setMessage(
          `备份已导出：${res.path}（题目 ${res.counts['problems'] ?? 0} · 提交 ${res.counts['submissions'] ?? 0}）`
        )
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBackupBusy(false)
    }
  }

  async function handleImportBackup(): Promise<void> {
    setBackupBusy(true)
    setMessage(null)
    setError(null)
    try {
      const preview = await unwrap(window.api.importBackupPreview())
      if (preview.canceled) return
      const c = preview.summary.counts
      const lines = [
        `备份文件：${preview.fileName}`,
        `导出时间：${fmtTime(preview.summary.createdAt)}`,
        preview.summary.appVersion !== null ? `应用版本：v${preview.summary.appVersion}` : null,
        '',
        `题目 ${c.problems} · 提交 ${c.submissions} · 错误记录 ${c.errorRecords}`,
        `错题 ${c.mistakeBook} · 错题笔记 ${c.mistakeNotes} · 知识点 ${c.knowledgePoints}`,
        `掌握度 ${c.mastery} · 复习项 ${c.reviewItems} · 复习历史 ${c.reviewHistory}`,
        `练习队列 ${c.practiceSessions}`,
        '',
        '⚠️ 恢复将以备份【全量替换】当前全部数据（题库、提交历史、错题、学习记录、掌握度、复习与练习记录、设置），此操作不可撤销。',
        '建议先导出当前数据作为备份。'
      ]
      const ok = window.confirm(lines.filter((l) => l !== null).join('\n'))
      if (!ok) {
        await unwrap(window.api.cancelBackupImport())
        setMessage('已取消恢复')
        return
      }
      const res = await unwrap(window.api.confirmBackupRestore())
      window.alert(`恢复完成：题目 ${res.counts['problems'] ?? 0} · 提交 ${res.counts['submissions'] ?? 0}。页面即将刷新。`)
      window.location.reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      // 失败时清掉主进程的待恢复状态
      try {
        await unwrap(window.api.cancelBackupImport())
      } catch {
        // 清理失败不影响主错误展示
      }
    } finally {
      setBackupBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    // 快速数据（设置 + 数据目录）：纯 IPC 读，决定整页是否可渲染
    void (async () => {
      try {
        const [s, info] = await Promise.all([unwrap(window.api.getSettings()), unwrap(window.api.getAppInfo())])
        if (!alive) return
        setSettings(s)
        setDataDir(info.dataDir)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    // 慢速数据（工具链探测）：MSVC vcvars 解析可能长达数十秒，独立加载，
    // 不阻塞页面渲染（期间工具链区域显示「检测中…」）
    void (async () => {
      try {
        const tc = await unwrap(window.api.detectToolchains(false))
        if (alive) setToolchains(tc)
      } catch {
        // 探测失败按「未检测到」呈现，用户可手动重新检测
        if (alive) setToolchains([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  async function patch(partial: Partial<AppSettings>): Promise<void> {
    try {
      const next = await unwrap(window.api.updateSettings(partial))
      setSettings(next)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  async function redetect(): Promise<void> {
    setDetecting(true)
    setMessage(null)
    try {
      const tc = await unwrap(window.api.detectToolchains(true))
      setToolchains(tc)
      setMessage(`检测完成：找到 ${tc.length} 个可用工具链`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setDetecting(false)
    }
  }

  if (settings === null) {
    return <div className="page">{error !== null ? <div className="alert error">{error}</div> : '加载中…'}</div>
  }

  return (
    <div className="page settings">
      <div className="page-header">
        <h2>设置</h2>
      </div>

      {error !== null && <div className="alert error">{error}</div>}
      {message !== null && <div className="alert info">{message}</div>}

      <section className="settings-section">
        <h3>编辑器</h3>
        <label className="settings-row">
          <span>字号</span>
          <div className="range-row">
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={settings.fontSize}
              onChange={(e) => void patch({ fontSize: Number(e.target.value) })}
            />
            <span className="range-value">{settings.fontSize}px</span>
          </div>
        </label>
        <label className="settings-row">
          <span>缩进宽度</span>
          <select value={settings.tabSize} onChange={(e) => void patch({ tabSize: Number(e.target.value) })}>
            <option value={2}>2 空格</option>
            <option value={4}>4 空格</option>
            <option value={8}>8 空格</option>
          </select>
        </label>
        <label className="settings-row">
          <span>自动换行</span>
          <input
            type="checkbox"
            checked={settings.wordWrap}
            onChange={(e) => void patch({ wordWrap: e.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>判题默认超时</span>
          <div className="range-row">
            <input
              type="number"
              min={JUDGE_TIMEOUT_MIN_MS}
              max={JUDGE_TIMEOUT_MAX_MS}
              step={500}
              value={settings.judgeTimeoutDefaultMs}
              onChange={(e) => void patch({ judgeTimeoutDefaultMs: Number(e.target.value) })}
            />
            <span className="range-value">ms（新建用例的默认值）</span>
          </div>
        </label>
      </section>

      <section className="settings-section">
        <h3>工具链</h3>
        <div className="toolchain-list">
          {toolchains === null ? (
            <div className="empty-hint small">正在检测可用工具链…（首次检测可能需要较长时间）</div>
          ) : toolchains.length > 0 ? (
            toolchains.map((t) => (
              <div key={t.id} className="toolchain-item">
                <span className="lang-chip">{t.kind}</span>
                <span className="toolchain-path">{t.program}</span>
                <span className="toolchain-version">{t.version}</span>
              </div>
            ))
          ) : (
            <div className="empty-hint small">未检测到可用工具链。请安装 gcc/g++ 或 Python，或在下方手工指定路径。</div>
          )}
        </div>
        <button disabled={detecting} onClick={() => void redetect()}>
          {detecting ? '检测中…' : '重新检测'}
        </button>

        <div className="manual-toolchains">
          {(['c', 'cpp', 'python'] as LanguageId[]).map((lang) => (
            <label key={lang} className="manual-row">
              <span className="lang-chip">{lang === 'cpp' ? 'C++' : lang.toUpperCase()}</span>
              <input
                placeholder={`手工指定${lang === 'python' ? '解释器' : '编译器'}完整路径（可选）`}
                defaultValue={settings.manualToolchains[lang] ?? ''}
                onBlur={(e) => {
                  const value = e.target.value.trim()
                  // 脏检查：未修改不触发保存
                  if (value === (settings.manualToolchains[lang] ?? '')) return
                  const next = { ...settings.manualToolchains }
                  if (value === '') delete next[lang]
                  else next[lang] = value
                  void patch({ manualToolchains: next }).then(() => {
                    setSettings((prev) => (prev === null ? prev : { ...prev, manualToolchains: next }))
                    setMessage('已保存手工工具链路径，点击「重新检测」生效')
                  })
                }}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3>数据管理</h3>
        <p className="settings-note">
          备份包含<b>全部</b>题库、测试用例、提交历史、错题本与笔记、学习路线进度、知识点掌握度、
          复习记录、练习队列与设置。恢复时将以备份<b>全量替换</b>当前数据。
        </p>
        <div className="backup-actions">
          <button disabled={backupBusy} onClick={() => void handleExportBackup()}>
            {backupBusy ? '导出中…' : '导出完整备份'}
          </button>
          <button disabled={backupBusy} onClick={() => void handleImportBackup()}>
            {backupBusy ? '处理中…' : '导入备份（恢复）'}
          </button>
        </div>
        {backupBusy && backupPhase !== '' && <p className="backup-phase">{backupPhase}</p>}
        <p className="settings-note privacy-note">
          🔒 备份包含你的全部代码与学习记录，属于<b>本地私人数据</b>，请妥善保管，不要上传到网络或发送给他人。
          CuinCodeBench 不会联网上传、同步或发送任何数据。
        </p>
      </section>

      <section className="settings-section">
        <h3>数据</h3>
        <p className="settings-note">所有数据（题库、提交历史、错题本、统计）保存在本机：</p>
        <code className="data-dir">{dataDir}</code>
      </section>
    </div>
  )
}
