import { pathToFileURL } from 'url'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import type {
  LanguageId,
  LspCompletionItem,
  LspDiagnosticsEvent,
  LspDiagnostic,
  LspHoverResult,
  LspServerStatus
} from '@shared/types'
import type { WorkspaceFileInput } from '@shared/types'
import { logger } from '../lib/logger'
import { execute } from '../runner/execute'
import type { ToolchainService } from './toolchain-service'
import { LspServer, type RawLspDiagnostic } from '../lsp/lsp-server'
import { mapCompletions, mapDiagnostics, mapHover, uriToPath } from '../lsp/lsp-mapping'
import { collectFallbackDiagnostics, fallbackAvailable, type FallbackRunCommand } from '../lsp/fallback-diagnostics'
import { resolveClangd } from '../lsp/clangd-detect'
import { resolvePyrightEntry } from '../lsp/pyright-resolve'

/**
 * LSP 编排服务（docs/V1_4_DESIGN.md §2/§3）：
 * - 每语言族（clang=c+cpp / python）至多一个长驻语言服务器；
 * - 工作区切换经 didChangeWorkspaceFolders（不重启服务器）；
 * - 崩溃退避重启（500ms/1s/2s），超 3 次降级到编译器回退诊断；
 * - 诊断统一映射共享类型后经 pushEvent 推送（唯一事件通道）。
 * 不进 ServiceContext、不持 DB 引用（同 ToolchainService 模式，备份恢复不受影响）。
 */

type Family = 'clang' | 'python'

function familyOf(language: LanguageId): Family {
  return language === 'python' ? 'python' : 'clang'
}

/** 诊断回退防抖（毫秒）：sync 后静置片刻再跑编译器，避免连续击键反复 spawn */
const FALLBACK_DEBOUNCE_MS = 500
/** 崩溃重启退避基数（毫秒）：500 / 1000 / 2000 */
const RESTART_BASE_MS = 500
const MAX_RESTARTS = 3

interface TrackedDoc {
  uri: string
  languageId: string
  version: number
  text: string
}

interface FamilyState {
  server: LspServer | null
  /** LSP 供给（null = 二进制不可用或已降级） */
  provider: 'clangd' | 'pyright' | null
  starting: boolean
  restartAttempts: number
  degraded: boolean
  workspace: { problemId: string; language: LanguageId; dir: string } | null
  currentFolderUri: string | null
  docs: Map<string, TrackedDoc>
  fallbackTimer: NodeJS.Timeout | null
  lastFallbackPaths: Set<string>
}

export interface LspServiceDeps {
  toolchains: ToolchainService
  /** 设置读取（getServices().settings.get() 的相关子集；防 stale 闭包，一律函数取值） */
  settings: () => { manualClangdPath?: string }
  /** 诊断事件出口（注入 pushToTrustedWindows；测试注入桩） */
  pushEvent: (event: LspDiagnosticsEvent) => void
  /** 回退诊断命令执行器（默认 execute 包装；测试注入桩） */
  runCommand?: FallbackRunCommand
  /** 崩溃重启退避基数毫秒（默认 500；测试注入 1） */
  restartBaseMs?: number
  /** 回退诊断防抖毫秒（默认 500；测试注入 1） */
  fallbackDebounceMs?: number
}

const defaultRunCommand: FallbackRunCommand = async (program, args, cwd, timeoutMs) => {
  const result = await execute({ program, args, cwd, stdin: '', timeoutMs, outputLimitBytes: 256 * 1024 })
  return { stdout: result.stdout, stderr: result.stderr }
}

export class LspService {
  private readonly families: Record<Family, FamilyState> = {
    clang: emptyFamily(),
    python: emptyFamily()
  }
  private readonly runCommand: FallbackRunCommand
  private readonly restartBaseMs: number
  private readonly fallbackDebounceMs: number
  private shutdownStarted = false

  constructor(private readonly deps: LspServiceDeps) {
    this.runCommand = deps.runCommand ?? defaultRunCommand
    this.restartBaseMs = deps.restartBaseMs ?? RESTART_BASE_MS
    this.fallbackDebounceMs = deps.fallbackDebounceMs ?? FALLBACK_DEBOUNCE_MS
  }

  // ----------------------------------------------------------
  // 工作区（WorkspaceService 调用；files 为该工作区当前全量文件）
  // ----------------------------------------------------------

  /** 打开/切换工作区：写 compile_flags.txt（c/cpp）→ 换 folder → didOpen 全量文件 */
  async openWorkspace(
    problemId: string,
    language: LanguageId,
    dir: string,
    files: WorkspaceFileInput[]
  ): Promise<void> {
    if (this.shutdownStarted) return
    const family = familyOf(language)
    const state = this.families[family]

    // clangd 编译口径与判题一致（-std/-Wall；-O2 对诊断无意义不写）
    if (language === 'c' || language === 'cpp') {
      try {
        await writeFile(join(dir, 'compile_flags.txt'), `${language === 'c' ? '-std=c11' : '-std=c++17'}\n-Wall\n`, 'utf8')
      } catch (err) {
        logger.warn('compile_flags.txt 写入失败', err instanceof Error ? err.message : String(err))
      }
    }

    state.workspace = { problemId, language, dir }
    state.docs = new Map()
    state.lastFallbackPaths = new Set()
    this.clearFallbackTimer(state)

    if (state.server !== null) {
      this.switchFolder(state, dir)
      this.didOpenAll(state, language, files)
      return
    }
    if (state.degraded || this.providerAvailable(family) === null) {
      // 无语言服务器：直接走编译器回退
      this.scheduleFallback(state)
      return
    }
    await this.ensureServer(family, files)
  }

  /** 增量文档同步（WorkspaceService 写盘后调用） */
  syncDocs(problemId: string, language: LanguageId, dir: string, changed: WorkspaceFileInput[]): void {
    const state = this.families[familyOf(language)]
    if (state.workspace?.problemId !== problemId || state.workspace.dir !== dir) return
    for (const file of changed) {
      this.didChange(state, language, file)
    }
    if (state.server === null) this.scheduleFallback(state)
  }

  // ----------------------------------------------------------
  // 智能编辑请求（renderer invoke → IPC 层调用）
  // ----------------------------------------------------------

  async requestCompletion(
    problemId: string,
    language: LanguageId,
    dir: string,
    path: string,
    line: number,
    col: number,
    content: string
  ): Promise<LspCompletionItem[]> {
    const state = this.families[familyOf(language)]
    if (state.workspace?.problemId !== problemId || state.workspace.dir !== dir) return []
    if (state.server === null) return []
    const doc = this.ensureDocFresh(state, language, path, content)
    try {
      const raw = await state.server.request('textDocument/completion', {
        textDocument: { uri: doc.uri },
        position: { line, character: col }
      })
      return mapCompletions(raw)
    } catch (err) {
      logger.warn('completion 请求失败', err instanceof Error ? err.message : String(err))
      return []
    }
  }

  async requestHover(
    problemId: string,
    language: LanguageId,
    dir: string,
    path: string,
    line: number,
    col: number,
    content: string
  ): Promise<LspHoverResult | null> {
    const state = this.families[familyOf(language)]
    if (state.workspace?.problemId !== problemId || state.workspace.dir !== dir) return null
    if (state.server === null) return null
    const doc = this.ensureDocFresh(state, language, path, content)
    try {
      const raw = await state.server.request('textDocument/hover', {
        textDocument: { uri: doc.uri },
        position: { line, character: col }
      })
      return mapHover(raw)
    } catch (err) {
      logger.warn('hover 请求失败', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** 每语言智能编辑供给状态（UI 徽标） */
  async status(): Promise<Record<LanguageId, LspServerStatus>> {
    return {
      c: await this.statusOf('c', this.families['clang']),
      cpp: await this.statusOf('cpp', this.families['clang']),
      python: await this.statusOf('python', this.families['python'])
    }
  }

  private async statusOf(language: LanguageId, state: FamilyState): Promise<LspServerStatus> {
    const family = familyOf(language)
    if (state.server !== null) return { server: state.provider ?? 'none', state: 'ready' }
    const provider = this.providerAvailable(family)
    if (state.starting) return { server: provider ?? 'none', state: 'starting' }
    if (provider !== null && !state.degraded) {
      // 二进制可用、尚未按需启动：视为可用（首次打开工作区即启动）
      return { server: provider, state: 'ready' }
    }
    const toolchain = await this.deps.toolchains.select(language)
    if (fallbackAvailable(language, toolchain)) return { server: 'fallback', state: 'ready' }
    return { server: 'none', state: 'degraded' }
  }

  // ----------------------------------------------------------
  // 生命周期
  // ----------------------------------------------------------

  /** 应用退出：主动关闭全部语言服务器（不触发重启） */
  shutdown(): void {
    this.shutdownStarted = true
    for (const state of [this.families['clang'], this.families['python']]) {
      this.clearFallbackTimer(state)
      state.server?.close()
      state.server = null
    }
  }

  // ----------------------------------------------------------
  // 内部：服务器启动 / 崩溃重启 / 工作区挂载
  // ----------------------------------------------------------

  private providerAvailable(family: Family): 'clangd' | 'pyright' | null {
    if (family === 'python') {
      return resolvePyrightEntry() !== null ? 'pyright' : null
    }
    return resolveClangd(this.deps.settings().manualClangdPath) !== null ? 'clangd' : null
  }

  /** 确保该族服务器在位（幂等）；files = 启动成功后立即 didOpen 的文件集（崩溃重启时复用 docs） */
  private async ensureServer(family: Family, files?: WorkspaceFileInput[]): Promise<void> {
    const state = this.families[family]
    if (this.shutdownStarted || state.server !== null || state.starting || state.degraded) return
    if (state.workspace === null) return
    const provider = this.providerAvailable(family)
    if (provider === null) {
      state.provider = null
      this.scheduleFallback(state)
      return
    }
    state.provider = provider
    state.starting = true
    try {
      const server = await this.startServerFor(family, provider, state.workspace.dir)
      state.server = server
      state.restartAttempts = 0
      state.currentFolderUri = pathToFileURL(state.workspace.dir).href
      // 启动即挂载当前工作区：优先用本次 open 的 files；崩溃重启场景 docs 仍在（服务端是全新进程，
      // didOpen 幂等安全——本地 docs 已有则保留版本号）
      const toOpen =
        files ?? [...state.docs.entries()].map(([path, d]) => ({ path, content: d.text }))
      this.didOpenAll(state, state.workspace.language, toOpen)
    } catch (err) {
      logger.warn(`语言服务器启动失败（${provider}）`, err instanceof Error ? err.message : String(err))
      state.restartAttempts += 1
      if (state.restartAttempts > MAX_RESTARTS) {
        state.degraded = true
        state.provider = null
        this.scheduleFallback(state)
        return
      }
      const delay = this.restartBaseMs * 2 ** (state.restartAttempts - 1)
      setTimeout(() => {
        void this.ensureServer(family)
      }, delay)
    } finally {
      state.starting = false
    }
  }

  private async startServerFor(family: Family, provider: 'clangd' | 'pyright', dir: string): Promise<LspServer> {
    const rootUri = pathToFileURL(dir).href
    if (provider === 'pyright') {
      const entry = resolvePyrightEntry()
      if (entry === null) throw new Error('pyright 入口缺失')
      const python = await this.deps.toolchains.select('python')
      return LspServer.start({
        program: process.execPath,
        args: [entry, '--stdio'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        rootUri,
        serverName: 'pyright',
        ...(python !== null ? { initializationOptions: { python: { pythonPath: python.program } } } : {}),
        onNotification: (method, params) => this.onNotification(family, method, params),
        onExit: () => this.onServerExit(family),
        onServerRequest: this.answerServerRequest
      })
    }
    const clangd = resolveClangd(this.deps.settings().manualClangdPath)
    if (clangd === null) throw new Error('clangd 不可用')
    return LspServer.start({
      program: clangd.program,
      args: ['--background-index=false', '--pch-storage=memory'],
      rootUri,
      serverName: 'clangd',
      onNotification: (method, params) => this.onNotification(family, method, params),
      onExit: () => this.onServerExit(family),
      onServerRequest: this.answerServerRequest
    })
  }

  /** server→client 请求最小应答（pyright 的 workspace/configuration 等；未识别统一 MethodNotFound） */
  private answerServerRequest = (method: string, params: unknown): unknown => {
    if (method === 'workspace/configuration') {
      const items = (params as { items?: unknown[] })?.items
      return Array.isArray(items) ? items.map(() => null) : []
    }
    if (method === 'client/registerCapability' || method === 'client/unregisterCapability') {
      return null
    }
    return undefined
  }

  /** 崩溃（非主动关闭）：退避重启或降级 */
  private onServerExit(family: Family): void {
    const state = this.families[family]
    state.server = null
    if (this.shutdownStarted) return
    state.restartAttempts += 1
    if (state.restartAttempts > MAX_RESTARTS) {
      state.degraded = true
      state.provider = null
      logger.warn(`语言服务器（${family}）连续崩溃，降级到编译器回退诊断`)
      this.scheduleFallback(state)
      return
    }
    const delay = this.restartBaseMs * 2 ** (state.restartAttempts - 1)
    setTimeout(() => {
      void this.ensureServer(family)
    }, delay)
  }

  /** 换工作区文件夹（同族同服务器） */
  private switchFolder(state: FamilyState, dir: string): void {
    if (state.server === null) return
    const newUri = pathToFileURL(dir).href
    const event: { removed: { uri: string; name?: string }[]; added: { uri: string; name?: string }[] } = {
      removed: [],
      added: [{ uri: newUri }]
    }
    if (state.currentFolderUri !== null && state.currentFolderUri !== newUri) {
      event.removed.push({ uri: state.currentFolderUri })
    }
    state.server.notify('workspace/didChangeWorkspaceFolders', { event })
    state.currentFolderUri = newUri
  }

  private didOpenAll(state: FamilyState, language: LanguageId, files: WorkspaceFileInput[]): void {
    for (const file of files) {
      const existing = state.docs.get(file.path)
      const uri = existing?.uri ?? pathToFileURL(join(state.workspace?.dir ?? '', file.path)).href
      const version = existing?.version ?? 1
      state.docs.set(file.path, { uri, languageId: language, version, text: file.content })
      // 服务端此时必无该文档（新工作区或新进程），didOpen 安全
      state.server?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: language, version, text: file.content }
      })
    }
  }

  private didChange(state: FamilyState, language: LanguageId, file: WorkspaceFileInput): void {
    const existing = state.docs.get(file.path)
    if (existing === undefined) {
      this.didOpenAll(state, language, [file])
      return
    }
    existing.version += 1
    existing.text = file.content
    state.server?.notify('textDocument/didChange', {
      textDocument: { uri: existing.uri, version: existing.version },
      contentChanges: [{ text: file.content }]
    })
  }

  /** 请求前刷新文档（携带最新内容，消除防抖窗口滞后） */
  private ensureDocFresh(state: FamilyState, language: LanguageId, path: string, content: string): TrackedDoc {
    const existing = state.docs.get(path)
    if (existing === undefined) {
      const uri = pathToFileURL(join(state.workspace?.dir ?? '', path)).href
      const doc: TrackedDoc = { uri, languageId: language, version: 1, text: content }
      state.docs.set(path, doc)
      state.server?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: language, version: 1, text: content }
      })
      return doc
    }
    if (existing.text !== content) {
      existing.version += 1
      existing.text = content
      state.server?.notify('textDocument/didChange', {
        textDocument: { uri: existing.uri, version: existing.version },
        contentChanges: [{ text: content }]
      })
    }
    return existing
  }

  private onNotification(family: Family, method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return
    const state = this.families[family]
    const p = params as { uri?: string; diagnostics?: RawLspDiagnostic[] }
    if (state.workspace === null || typeof p.uri !== 'string') return
    const absPath = uriToPath(p.uri)
    const rel = relativeWithin(state.workspace.dir, absPath)
    if (rel === null) return
    const source = state.provider === 'pyright' ? 'pyright' : state.provider === 'clangd' ? 'clangd' : 'lsp'
    this.deps.pushEvent({
      problemId: state.workspace.problemId,
      language: state.workspace.language,
      path: rel,
      diagnostics: mapDiagnostics(p.diagnostics ?? [], source)
    })
  }

  // ----------------------------------------------------------
  // 回退诊断（防抖 500ms；清空已消失文件的历史诊断）
  // ----------------------------------------------------------

  private scheduleFallback(state: FamilyState): void {
    if (this.shutdownStarted || state.workspace === null) return
    this.clearFallbackTimer(state)
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = null
      void this.runFallback(state)
    }, this.fallbackDebounceMs)
  }

  private clearFallbackTimer(state: FamilyState): void {
    if (state.fallbackTimer !== null) {
      clearTimeout(state.fallbackTimer)
      state.fallbackTimer = null
    }
  }

  private async runFallback(state: FamilyState): Promise<void> {
    if (this.shutdownStarted || state.workspace === null) return
    const { problemId, language, dir } = state.workspace
    if (state.server !== null) return // LSP 恢复则不再回退
    const toolchain = await this.deps.toolchains.select(language)
    const byFile = await collectFallbackDiagnostics(language, dir, toolchain, this.runCommand)
    if (state.workspace?.problemId !== problemId || state.server !== null) return // 期间切换/恢复
    const newPaths = new Set<string>()
    for (const [path, diagnostics] of byFile) {
      newPaths.add(path)
      this.pushDiag(problemId, language, path, diagnostics)
    }
    for (const prev of state.lastFallbackPaths) {
      if (!newPaths.has(prev)) this.pushDiag(problemId, language, prev, []) // 清空已修复文件
    }
    state.lastFallbackPaths = newPaths
  }

  private pushDiag(problemId: string, language: LanguageId, path: string, diagnostics: LspDiagnostic[]): void {
    this.deps.pushEvent({ problemId, language, path, diagnostics })
  }
}

function emptyFamily(): FamilyState {
  return {
    server: null,
    provider: null,
    starting: false,
    restartAttempts: 0,
    degraded: false,
    workspace: null,
    currentFolderUri: null,
    docs: new Map(),
    fallbackTimer: null,
    lastFallbackPaths: new Set()
  }
}

/** 绝对路径 → 工作区内相对路径（POSIX 分隔符）；越界（..）返回 null */
function relativeWithin(dir: string, absPath: string): string | null {
  const norm = (p: string): string[] => p.replace(/\\/g, '/').split('/').filter((s) => s !== '')
  const dirParts = norm(dir)
  const pathParts = norm(absPath)
  // Windows 盘符大小写归一
  if (dirParts[0]?.toLowerCase() !== pathParts[0]?.toLowerCase()) return null
  if (pathParts.length <= dirParts.length) return null
  const rel = pathParts.slice(dirParts.length)
  if (rel.some((s) => s === '..')) return null
  return rel.join('/')
}
