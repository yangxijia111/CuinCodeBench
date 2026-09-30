import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { SOURCE_FILENAMES, WORKSPACE_RESERVED_NAMES } from '@shared/constants'
import { safeJoinWithin, validateWorkspacePath } from '@shared/workspace-path'
import type { LanguageId, WorkspaceFile, WorkspaceFileInput } from '@shared/types'
import { AppError } from '../lib/app-error'
import { logger } from '../lib/logger'
import type { LspService } from './lsp-service'
import type { ProblemService } from './index'

/**
 * 工作区服务（docs/V1_4_DESIGN.md §1）：每题每语言的磁盘编辑态真相。
 * - {dataDir}/workspaces/{problemId}/{language}/，入口 = SOURCE_FILENAMES
 * - seed-on-open：仅补种缺失文件（入口 ← draft（localStorage 迁移）或 initialCode）；
 *   已存在的工作区文件一律保留（solver 编辑态优先）
 * - 判题输入永远由 renderer 显式传入（本服务只服务 LSP 与编辑态，判题不读工作区）
 * - 不进 ServiceContext、不持 DB 引用；problems 经函数取值（防备份换库 stale）
 */

/** 目录内非用户文件（判题产物/缓存/LSP 基础设施） */
const EXCLUDED_FILES = new Set([...WORKSPACE_RESERVED_NAMES, 'app.exe', '__pycache__'])

export class WorkspaceService {
  constructor(
    private readonly dataDir: string,
    private readonly lsp: LspService,
    private readonly problems: () => ProblemService
  ) {}

  workspaceDir(problemId: string, language: LanguageId): string {
    return join(this.dataDir, 'workspaces', problemId, language)
  }

  /**
   * 打开（或切换到）工作区：补种缺失入口文件与题目定义附加文件 → 通知 LSP → 返回全量文件。
   * draft：renderer 的 localStorage 旧草稿（一次性迁移；工作区已有内容时以磁盘为准）。
   */
  async open(problemId: string, language: LanguageId, draft: string | null): Promise<WorkspaceFile[]> {
    const problem = this.problems().get(problemId)
    if (problem === null) throw new AppError('not_found', `题目不存在: ${problemId}`)
    const dir = this.workspaceDir(problemId, language)
    await mkdir(dir, { recursive: true })
    const entryPath = join(dir, SOURCE_FILENAMES[language])
    if (!existsSync(entryPath)) {
      await writeFile(entryPath, draft ?? problem.initialCode[language] ?? '', 'utf8')
    }
    // 补种题目定义的附加文件（仅缺失的；solver 对已有文件的编辑态优先——题目定义更新后由「重置」同步）
    for (const def of problem.files.filter((f) => f.language === language)) {
      const rel = safeJoinWithin(def.path)
      if (rel === null) continue // 定义数据异常（导入侧已校验）跳过
      const target = join(dir, rel)
      if (!existsSync(target)) {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, def.content, 'utf8')
      }
    }
    const files = await this.list(problemId, language)
    await this.lsp.openWorkspace(
      problemId,
      language,
      dir,
      files.map((f) => ({ path: f.path, content: f.content }))
    )
    return files
  }

  /** 增量同步（renderer 防抖后调用）：写变更/删移除 → LSP didChange/didClose */
  async sync(
    problemId: string,
    language: LanguageId,
    changed: WorkspaceFileInput[],
    removed: string[]
  ): Promise<void> {
    const dir = this.workspaceDir(problemId, language)
    const entry = SOURCE_FILENAMES[language]
    for (const file of changed) {
      // 入口文件允许写（renderer 的编辑目标）；附加文件走完整校验
      if (file.path !== entry) {
        const v = validateWorkspacePath(file.path, language)
        if (!v.ok) throw new AppError('invalid_path', `非法文件路径 ${file.path}：${v.reason}`)
      }
      const rel = safeJoinWithin(file.path)
      if (rel === null) throw new AppError('invalid_path', `路径逃逸被拒绝: ${file.path}`)
      const target = join(dir, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, 'utf8')
    }
    for (const path of removed) {
      if (path === entry) {
        throw new AppError('invalid_path', '入口文件不可删除')
      }
      const v = validateWorkspacePath(path, language)
      if (!v.ok) throw new AppError('invalid_path', `非法文件路径 ${path}：${v.reason}`)
      const rel = safeJoinWithin(path)
      if (rel === null) throw new AppError('invalid_path', `路径逃逸被拒绝: ${path}`)
      await rm(join(dir, rel), { force: true })
    }
    this.lsp.syncDocs(problemId, language, dir, changed, removed)
  }

  /** 重置：清空目录 → 恢复 initialCode 入口 → LSP 重挂（folder 相同，幂等） */
  async reset(problemId: string, language: LanguageId): Promise<WorkspaceFile[]> {
    const problem = this.problems().get(problemId)
    if (problem === null) throw new AppError('not_found', `题目不存在: ${problemId}`)
    const dir = this.workspaceDir(problemId, language)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, SOURCE_FILENAMES[language]), problem.initialCode[language] ?? '', 'utf8')
    const files = await this.list(problemId, language)
    await this.lsp.openWorkspace(
      problemId,
      language,
      dir,
      files.map((f) => ({ path: f.path, content: f.content }))
    )
    return files
  }

  /** 删除题目时清理其全部工作区（best-effort） */
  async removeProblem(problemId: string): Promise<void> {
    try {
      await rm(join(this.dataDir, 'workspaces', problemId), { recursive: true, force: true })
    } catch (err) {
      logger.warn('工作区清理失败', err instanceof Error ? err.message : String(err))
    }
  }

  /** 全量文件列表（排除判题产物/缓存/保留名；入口排首位） */
  private async list(problemId: string, language: LanguageId): Promise<WorkspaceFile[]> {
    const dir = this.workspaceDir(problemId, language)
    const entry = SOURCE_FILENAMES[language]
    const out: WorkspaceFile[] = []
    const walk = async (rel: string): Promise<void> => {
      let entries: string[]
      try {
        entries = await readdir(join(dir, rel))
      } catch {
        return
      }
      for (const name of entries.sort()) {
        if (EXCLUDED_FILES.has(name) || name.startsWith('.')) continue
        const relPath = rel === '' ? name : `${rel}/${name}`
        let st
        try {
          st = await stat(join(dir, relPath))
        } catch {
          continue
        }
        if (st.isDirectory()) {
          await walk(relPath)
        } else {
          out.push({
            path: relPath,
            content: await readFile(join(dir, relPath), 'utf8'),
            isEntry: relPath === entry
          })
        }
      }
    }
    await walk('')
    // 入口固定首位（UI Tab 顺序稳定）
    out.sort((a, b) => (a.isEntry === b.isEntry ? a.path.localeCompare(b.path) : a.isEntry ? -1 : 1))
    return out.slice(0, 64)
  }
}
