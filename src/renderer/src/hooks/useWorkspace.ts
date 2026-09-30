import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanguageId, LspDiagnostic, LspServerStatus, WorkspaceFile } from '@shared/types'
import { unwrap } from '../api/client'

/**
 * v1.4 工作区 hook（docs/V1_4_DESIGN.md §1）：
 * - workspace.open 建立编辑态（含 localStorage 旧草稿一次性迁移）
 * - 编辑防抖 250ms → workspace.sync（只传变更/删除）；卸载时 flush 兜底（防编辑丢失）
 * - 订阅 lsp.diagnostics 事件（按 problemId+language 过滤）
 * - 文件增删为低频操作：立即 flush
 */

const SYNC_DEBOUNCE_MS = 250

/** v1.3 及以前的草稿 key（迁移源；迁移成功后删除） */
export function legacyDraftKey(problemId: string, lang: LanguageId): string {
  return `ccbench.draft.${problemId}.${lang}`
}

function readLegacyDraft(problemId: string, lang: LanguageId): string | null {
  try {
    return localStorage.getItem(legacyDraftKey(problemId, lang))
  } catch {
    return null
  }
}

function clearLegacyDraft(problemId: string, lang: LanguageId): void {
  try {
    localStorage.removeItem(legacyDraftKey(problemId, lang))
  } catch {
    // 忽略（隐私模式等）
  }
}

export interface UseWorkspaceResult {
  files: WorkspaceFile[]
  activePath: string
  setActivePath: (path: string) => void
  /** 编辑当前/指定文件内容（进入防抖同步） */
  updateFile: (path: string, content: string) => void
  /** 新建附加文件（空内容）；成功返回 true */
  addFile: (path: string) => Promise<boolean>
  /** 删除附加文件（入口不可删）；成功返回 true */
  removeFile: (path: string) => Promise<boolean>
  /** 重置整个工作区（恢复 initialCode，清空附加文件） */
  resetWorkspace: () => Promise<void>
  /** path → 诊断（含空数组 = 已清空） */
  diagnostics: Record<string, LspDiagnostic[]>
  lspStatus: Record<LanguageId, LspServerStatus> | null
  error: string | null
  busy: boolean
}

export function useWorkspace(problemId: string, language: LanguageId): UseWorkspaceResult {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [activePath, setActivePath] = useState('')
  const [diagnostics, setDiagnostics] = useState<Record<string, LspDiagnostic[]>>({})
  const [lspStatus, setLspStatus] = useState<Record<LanguageId, LspServerStatus> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** 待同步变更（path → content）与删除（路径） */
  const pendingChanged = useRef<Map<string, string>>(new Map())
  const pendingRemoved = useRef<Set<string>>(new Set())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const problemIdRef = useRef(problemId)
  const languageRef = useRef(language)

  // ref 只在 effect 中同步（React 渲染期禁止读写 ref）
  useEffect(() => {
    problemIdRef.current = problemId
    languageRef.current = language
  }, [problemId, language])

  const flushSync = useCallback((): void => {
    const pid = problemIdRef.current
    const lang = languageRef.current
    const changed = [...pendingChanged.current.entries()].map(([path, content]) => ({ path, content }))
    const removed = [...pendingRemoved.current]
    if (changed.length === 0 && removed.length === 0) return
    pendingChanged.current = new Map()
    pendingRemoved.current = new Set()
    // fire-and-forget：失败不阻塞编辑（下次编辑会重试——dirty 已清，接受最终一致；
    // 工作区仅是 LSP 镜像，判题输入始终来自 renderer 内存态）
    void window.api.workspaceSync(pid, lang, changed, removed).catch(() => undefined)
  }, [])

  const scheduleSync = useCallback(
    (path: string, content: string): void => {
      pendingRemoved.current.delete(path)
      pendingChanged.current.set(path, content)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        flushSync()
      }, SYNC_DEBOUNCE_MS)
    },
    [flushSync]
  )

  // 打开工作区（problemId/language 变化）
  useEffect(() => {
    let alive = true
    if (problemId === '') return
    // 切换工作区：丢弃旧 pending 与定时器（防旧 dirty 写入新工作区）
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    pendingChanged.current = new Map()
    pendingRemoved.current = new Set()
    void (async () => {
      setError(null)
      setBusy(true)
      setDiagnostics({})
      try {
        const draft = readLegacyDraft(problemId, language)
        const opened = await unwrap(window.api.workspaceOpen(problemId, language, draft))
        if (!alive) return
        // 迁移成功：旧草稿退役（工作区成为唯一真相）
        if (draft !== null) clearLegacyDraft(problemId, language)
        setFiles(opened)
        const entry = opened.find((f) => f.isEntry)
        setActivePath(entry?.path ?? opened[0]?.path ?? '')
        void window.api.lspStatus().then((res) => {
          if (alive && res.ok) setLspStatus(res.data)
        })
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [problemId, language])

  // 诊断订阅（唯一事件通道）
  useEffect(() => {
    if (problemId === '') return
    const unsubscribe = window.api.onLspDiagnostics((event) => {
      if (event.problemId !== problemId || event.language !== language) return
      setDiagnostics((prev) => ({ ...prev, [event.path]: event.diagnostics }))
    })
    return unsubscribe
  }, [problemId, language])

  // 卸载 flush：防抖窗口内的编辑不丢失
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      flushSync()
    }
  }, [flushSync])

  const updateFile = useCallback(
    (path: string, content: string): void => {
      setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)))
      scheduleSync(path, content)
    },
    [scheduleSync]
  )

  const addFile = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        await unwrap(window.api.workspaceSync(problemId, language, [{ path, content: '' }], []))
        setFiles((prev) => [...prev, { path, content: '', isEntry: false }])
        setActivePath(path)
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [problemId, language]
  )

  const removeFile = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        await unwrap(window.api.workspaceSync(problemId, language, [], [path]))
        pendingChanged.current.delete(path)
        setFiles((prev) => prev.filter((f) => f.path !== path))
        setActivePath((cur) => {
          if (cur !== path) return cur
          const rest = files.filter((f) => f.path !== path)
          return rest[0]?.path ?? ''
        })
        setDiagnostics((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [problemId, language, files]
  )

  const resetWorkspace = useCallback(async (): Promise<void> => {
    try {
      pendingChanged.current = new Map()
      pendingRemoved.current = new Set()
      const opened = await unwrap(window.api.workspaceReset(problemId, language))
      setFiles(opened)
      const entry = opened.find((f) => f.isEntry)
      setActivePath(entry?.path ?? opened[0]?.path ?? '')
      setDiagnostics({})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [problemId, language])

  return {
    files,
    activePath,
    setActivePath,
    updateFile,
    addFile,
    removeFile,
    resetWorkspace,
    diagnostics,
    lspStatus,
    error,
    busy
  }
}
