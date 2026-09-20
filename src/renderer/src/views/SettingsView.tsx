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

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [s, info, tc] = await Promise.all([
          unwrap(window.api.getSettings()),
          unwrap(window.api.getAppInfo()),
          unwrap(window.api.detectToolchains(false))
        ])
        if (!alive) return
        setSettings(s)
        setDataDir(info.dataDir)
        setToolchains(tc)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
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
          {toolchains !== null && toolchains.length > 0 ? (
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
        <h3>数据</h3>
        <p className="settings-note">所有数据（题库、提交历史、错题本、统计）保存在本机：</p>
        <code className="data-dir">{dataDir}</code>
      </section>
    </div>
  )
}
