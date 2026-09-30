import {
  MAX_WORKSPACE_FILES,
  SOURCE_FILENAMES,
  WORKSPACE_FILE_MAX_CHARS,
  WORKSPACE_PATH_MAX_DEPTH,
  WORKSPACE_RESERVED_NAMES,
  WORKSPACE_TOTAL_MAX_CHARS
} from './constants'
import type { LanguageId } from './types'

/**
 * 工作区/判题附加文件的路径与内容校验（单源，docs/V1_4_DESIGN.md §5）。
 * 三处消费：zod 入参 schema、WorkspaceService 写盘、判题 writeWorkspaceFiles。
 * 只允许「字母数字下划线连字符点斜杠」的相对路径，杜绝遍历与保留名碰撞。
 */

export type PathValidation = { ok: true } | { ok: false; reason: string }

/** 相对路径白名单（POSIX 分隔符；不允许反斜杠/盘符/UNC/空段） */
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/

/** 校验单个附加文件相对路径（不含入口文件名——入口由系统固定） */
export function validateWorkspacePath(path: string, language: LanguageId): PathValidation {
  if (path === '') return { ok: false, reason: '路径不能为空' }
  if (path.length > 200) return { ok: false, reason: '路径过长（≤200 字符）' }
  if (path.includes('\\')) return { ok: false, reason: '路径必须使用 / 分隔' }
  if (PATH_RE.test(path) === false) return { ok: false, reason: '路径含非法字符（仅允许字母数字 _ - . /）' }
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.')) return { ok: false, reason: '路径含空段或 "." 段' }
  if (segments.includes('..')) return { ok: false, reason: '路径不允许 ".." 段' }
  if (segments.length > WORKSPACE_PATH_MAX_DEPTH) {
    return { ok: false, reason: `路径深度超限（≤${WORKSPACE_PATH_MAX_DEPTH}）` }
  }
  if (segments.some((s) => WORKSPACE_RESERVED_NAMES.includes(s))) {
    return { ok: false, reason: `保留文件名：${WORKSPACE_RESERVED_NAMES.join(' / ')}` }
  }
  if (path === SOURCE_FILENAMES[language]) return { ok: false, reason: '不能与入口文件同名' }
  return { ok: true }
}

export interface WorkspaceFileSetIssue {
  index: number
  path: string
  reason: string
}

/** 校验附加文件集（数量/单文件大小/总量/路径合法性/重复路径） */
export function validateFileSet(
  language: LanguageId,
  files: { path: string; content: string }[]
): { ok: true } | { ok: false; issues: WorkspaceFileSetIssue[] } {
  const issues: WorkspaceFileSetIssue[] = []
  if (files.length > MAX_WORKSPACE_FILES) {
    issues.push({ index: -1, path: '', reason: `附加文件数量超限（≤${MAX_WORKSPACE_FILES}）` })
    return { ok: false, issues }
  }
  const seen = new Set<string>()
  let total = 0
  files.forEach((f, index) => {
    const v = validateWorkspacePath(f.path, language)
    if (!v.ok) {
      issues.push({ index, path: f.path, reason: v.reason })
      return
    }
    if (seen.has(f.path)) {
      issues.push({ index, path: f.path, reason: '重复路径' })
      return
    }
    seen.add(f.path)
    if (f.content.length > WORKSPACE_FILE_MAX_CHARS) {
      issues.push({ index, path: f.path, reason: `文件超过 ${WORKSPACE_FILE_MAX_CHARS} 字符上限` })
      return
    }
    total += f.content.length
  })
  if (total > WORKSPACE_TOTAL_MAX_CHARS && issues.length === 0) {
    issues.push({ index: -1, path: '', reason: `文件集总大小超限（≤${WORKSPACE_TOTAL_MAX_CHARS} 字符）` })
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

/** join 前的纵深防御：规范化相对路径（去空段/"."），拒绝 ".."；返回 null = 非法 */
export function safeJoinWithin(relativePath: string): string | null {
  if (relativePath.includes('\\')) return null
  const normalized = relativePath
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/')
  if (normalized === '' || normalized.split('/').includes('..')) return null
  return normalized
}
