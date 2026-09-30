import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  AppSettings,
  Difficulty,
  KnowledgePoint,
  LanguageId,
  ProblemFileInput,
  ProblemInput,
  TestCaseInput
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { DEFAULT_TESTCASE_TIMEOUT_MS } from '@shared/constants'
import { unwrap, ApiError } from '../api/client'
import { CodeEditor } from '../components/CodeEditor'

/**
 * 题目新建/编辑页（FR-P1/P3）：基本信息 + 示例 + 初始代码 + 附加文件（v1.4）+ 测试用例编辑。
 */

const EMPTY_INPUT: ProblemInput = {
  title: '',
  description: '',
  difficulty: 'easy',
  tags: [],
  inputDesc: '',
  outputDesc: '',
  samples: [{ input: '', output: '' }],
  initialCode: { c: '', cpp: '', python: '' },
  testCases: [{ stdin: '', expectedStdout: '', timeoutMs: DEFAULT_TESTCASE_TIMEOUT_MS }]
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']
const DIFF_LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '困难' }

export function ProblemEditView(): React.JSX.Element {
  const { id } = useParams()
  const isEdit = id !== undefined
  const navigate = useNavigate()

  const [input, setInput] = useState<ProblemInput>(EMPTY_INPUT)
  const [tagText, setTagText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(!isEdit)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  // v1.2：知识点绑定（题目编辑页多选；保存时与旧集合 diff 同步）
  const [allKps, setAllKps] = useState<KnowledgePoint[]>([])
  const [selectedKpIds, setSelectedKpIds] = useState<Set<string>>(new Set())
  const [oldKpIds, setOldKpIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    unwrap(window.api.getSettings())
      .then((s) => setSettings(s))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    unwrap(window.api.listAllKnowledgePoints())
      .then((kps) => setAllKps(kps))
      .catch(() => setAllKps([]))
  }, [])

  useEffect(() => {
    if (!isEdit) return
    let alive = true
    void Promise.all([
      unwrap(window.api.getProblem(id ?? '')),
      unwrap(window.api.getProblemKnowledgePoints(id ?? '')).catch(() => [] as KnowledgePoint[])
    ])
      .then(([p, kps]) => {
        if (!alive || p === null) return
        setInput({
          title: p.title,
          description: p.description,
          difficulty: p.difficulty,
          tags: p.tags,
          inputDesc: p.inputDesc,
          outputDesc: p.outputDesc,
          samples: p.samples.length > 0 ? p.samples : [{ input: '', output: '' }],
          initialCode: p.initialCode,
          files: p.files.map((f) => ({ language: f.language, path: f.path, content: f.content })),
          testCases: p.testCases.map((tc) => ({
            stdin: tc.stdin,
            expectedStdout: tc.expectedStdout,
            timeoutMs: tc.timeoutMs
          }))
        })
        setTagText(p.tags.join(' '))
        const ids = new Set(kps.map((k) => k.id))
        setSelectedKpIds(ids)
        setOldKpIds(ids)
        setLoaded(true)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [id, isEdit])

  const patch = useMemo(
    () => (partial: Partial<ProblemInput>) => setInput((prev) => ({ ...prev, ...partial })),
    []
  )

  async function handleSave(): Promise<void> {
    setSaving(true)
    setError(null)
    const files = (input.files ?? []).filter((f) => f.path.trim() !== '' && f.path !== 'main.c' && f.path !== 'main.cpp' && f.path !== 'main.py')
    const payload: ProblemInput = {
      ...input,
      files,
      tags: tagText
        .split(/[\s,，]+/)
        .map((t) => t.trim())
        .filter((t) => t !== '')
    }
    try {
      const saved = isEdit ? await unwrap(window.api.updateProblem(id ?? '', payload)) : await unwrap(window.api.createProblem(payload))
      // 同步知识点绑定（diff：旧有新无 → 解绑；新有 → 绑定）
      for (const kpId of oldKpIds) {
        if (!selectedKpIds.has(kpId)) {
          await unwrap(window.api.unbindProblemKnowledgePoint(saved.id, kpId)).catch(() => undefined)
        }
      }
      const toBind = [...selectedKpIds].filter((kpId) => !oldKpIds.has(kpId))
      if (toBind.length > 0) {
        await unwrap(window.api.bindProblemKnowledgePoints(saved.id, toBind))
      }
      void navigate(`/practice/${saved.id}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded && error === null) return <div className="page">加载中…</div>

  return (
    <div className="page">
      <div className="page-header">
        <h2>{isEdit ? '编辑题目' : '新建题目'}</h2>
        <div className="header-actions">
          <button onClick={() => void navigate(-1)}>取消</button>
          <button className="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {error !== null && <div className="alert error">{error}</div>}

      <div className="form-grid">
        <label className="form-row">
          <span className="form-label">标题 *</span>
          <input
            value={input.title}
            maxLength={100}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="例如：A+B 问题"
          />
        </label>

        <label className="form-row">
          <span className="form-label">难度</span>
          <select
            value={input.difficulty}
            onChange={(e) => patch({ difficulty: e.target.value as Difficulty })}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFF_LABEL[d]}
              </option>
            ))}
          </select>
        </label>

        <label className="form-row">
          <span className="form-label">标签（空格分隔）</span>
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="入门 数学" />
        </label>

        {/* —— 知识点（v1.2）—— */}
        {allKps.length > 0 && (
          <div className="form-row">
            <span className="form-label">关联知识点（可多选，用于学习路线与掌握度统计）</span>
            <div className="kp-picker">
              {allKps.map((kp) => (
                <label key={kp.id} className="kp-option">
                  <input
                    type="checkbox"
                    checked={selectedKpIds.has(kp.id)}
                    onChange={(e) => {
                      const next = new Set(selectedKpIds)
                      if (e.target.checked) next.add(kp.id)
                      else next.delete(kp.id)
                      setSelectedKpIds(next)
                    }}
                  />
                  {kp.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="form-row">
          <span className="form-label">题目描述（Markdown）</span>
          <textarea
            rows={5}
            value={input.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>

        <label className="form-row">
          <span className="form-label">输入说明</span>
          <textarea rows={2} value={input.inputDesc} onChange={(e) => patch({ inputDesc: e.target.value })} />
        </label>

        <label className="form-row">
          <span className="form-label">输出说明</span>
          <textarea rows={2} value={input.outputDesc} onChange={(e) => patch({ outputDesc: e.target.value })} />
        </label>

        {/* —— 示例 —— */}
        <div className="form-row">
          <span className="form-label">示例（最多 3 个）</span>
          <div className="samples-editor">
            {input.samples.map((s, i) => (
              <div key={i} className="sample-pair">
                <textarea
                  rows={2}
                  placeholder="输入"
                  value={s.input}
                  onChange={(e) => {
                    const next = [...input.samples]
                    next[i] = { ...s, input: e.target.value }
                    patch({ samples: next })
                  }}
                />
                <textarea
                  rows={2}
                  placeholder="输出"
                  value={s.output}
                  onChange={(e) => {
                    const next = [...input.samples]
                    next[i] = { ...s, output: e.target.value }
                    patch({ samples: next })
                  }}
                />
                <button
                  className="danger"
                  onClick={() => patch({ samples: input.samples.filter((_, j) => j !== i) })}
                >
                  删除
                </button>
              </div>
            ))}
            <button
              disabled={input.samples.length >= 3}
              onClick={() => patch({ samples: [...input.samples, { input: '', output: '' }] })}
            >
              添加示例
            </button>
          </div>
        </div>

        {/* —— 初始代码（v1.4：CodeMirror 编辑）—— */}
        <div className="form-row">
          <span className="form-label">初始代码 / 入口文件（可留空；入口名固定 main.c / main.cpp / main.py）</span>
          {(['c', 'cpp', 'python'] as LanguageId[]).map((lang) => (
            <div key={lang} className="initial-code-row">
              <span className="lang-chip">{lang === 'cpp' ? 'C++' : lang.toUpperCase()}</span>
              <div className="edit-code-mirror">
                <CodeEditor
                  value={input.initialCode[lang]}
                  language={lang}
                  fontSize={settings.fontSize}
                  tabSize={settings.tabSize}
                  wordWrap={settings.wordWrap}
                  onChange={(value) => patch({ initialCode: { ...input.initialCode, [lang]: value } })}
                />
              </div>
            </div>
          ))}
        </div>

        {/* —— 附加文件（v1.4 多文件题目定义）—— */}
        <div className="form-row">
          <span className="form-label">
            附加文件（可选，最多 16 个/语言；头文件与辅助源文件将进入做题工作区并参与编译）
          </span>
          <div className="problem-files-editor">
            {(input.files ?? []).map((f, i) => (
              <div key={i} className="problem-file-row">
                <div className="problem-file-head">
                  <select
                    aria-label="文件语言"
                    value={f.language}
                    onChange={(e) => {
                      const next = [...(input.files ?? [])]
                      next[i] = { ...f, language: e.target.value as LanguageId }
                      patch({ files: next })
                    }}
                  >
                    <option value="c">C</option>
                    <option value="cpp">C++</option>
                    <option value="python">Python</option>
                  </select>
                  <input
                    className="mono"
                    aria-label="文件路径"
                    placeholder="相对路径，如 util.h / sub/helper.py"
                    value={f.path}
                    onChange={(e) => {
                      const next = [...(input.files ?? [])]
                      next[i] = { ...f, path: e.target.value }
                      patch({ files: next })
                    }}
                  />
                  <button
                    className="danger"
                    onClick={() => patch({ files: (input.files ?? []).filter((_, j) => j !== i) })}
                  >
                    删除
                  </button>
                </div>
                <div className="edit-code-mirror small">
                  <CodeEditor
                    value={f.content}
                    language={f.language}
                    fontSize={settings.fontSize}
                    tabSize={settings.tabSize}
                    wordWrap={settings.wordWrap}
                    onChange={(value) => {
                      const next = [...(input.files ?? [])]
                      next[i] = { ...f, content: value }
                      patch({ files: next })
                    }}
                  />
                </div>
              </div>
            ))}
            <button
              disabled={(input.files ?? []).length >= 48}
              onClick={() =>
                patch({
                  files: [
                    ...(input.files ?? []),
                    { language: 'cpp' as LanguageId, path: '', content: '' } satisfies ProblemFileInput
                  ]
                })
              }
            >
              添加附加文件
            </button>
          </div>
        </div>

        {/* —— 测试用例 —— */}
        <div className="form-row">
          <span className="form-label">测试用例（{input.testCases.length}/50）</span>
          <div className="cases-editor">
            {input.testCases.map((tc, i) => (
              <CaseEditor
                key={i}
                index={i}
                value={tc}
                onChange={(next) => {
                  const cases = [...input.testCases]
                  cases[i] = next
                  patch({ testCases: cases })
                }}
                onRemove={() => patch({ testCases: input.testCases.filter((_, j) => j !== i) })}
              />
            ))}
            <button
              disabled={input.testCases.length >= 50}
              onClick={() =>
                patch({
                  testCases: [
                    ...input.testCases,
                    { stdin: '', expectedStdout: '', timeoutMs: DEFAULT_TESTCASE_TIMEOUT_MS }
                  ]
                })
              }
            >
              添加用例
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CaseEditor(props: {
  index: number
  value: TestCaseInput
  onChange: (next: TestCaseInput) => void
  onRemove: () => void
}): React.JSX.Element {
  const { index, value, onChange, onRemove } = props
  return (
    <div className="case-editor">
      <div className="case-head">
        <span>用例 #{index + 1}</span>
        <label className="timeout-label">
          超时
          <input
            type="number"
            min={100}
            max={60000}
            step={100}
            value={value.timeoutMs}
            onChange={(e) => onChange({ ...value, timeoutMs: Number(e.target.value) })}
          />
          ms
        </label>
        <button className="danger" onClick={onRemove}>
          删除
        </button>
      </div>
      <div className="case-body">
        <textarea
          rows={2}
          aria-label="用例 stdin 输入" placeholder="stdin 输入（可为空）"
          value={value.stdin}
          onChange={(e) => onChange({ ...value, stdin: e.target.value })}
        />
        <textarea
          rows={2}
          aria-label="用例期望输出" placeholder="期望 stdout"
          value={value.expectedStdout}
          onChange={(e) => onChange({ ...value, expectedStdout: e.target.value })}
        />
      </div>
    </div>
  )
}
