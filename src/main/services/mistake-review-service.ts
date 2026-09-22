import type Database from 'better-sqlite3'
import { ERROR_CATEGORIES, type ErrorCategory, type JudgeStatus, type LanguageId, type MistakeHistoryEntry } from '@shared/types'
import { AppError } from '../lib/app-error'

/**
 * 错题复盘服务（docs/V1_2_ROADMAP.md P5 / docs/V1_2_MASTERY_SPEC.md §6）：
 * 错误历史（从 submissions + error_records 派生，不冗余存储）、错因笔记、学习错误分类。
 */

interface FailureRow {
  id: string
  language: string
  code: string
  status: string
  created_at: number
  message: string | null
  learning_category: string | null
  category_source: string | null
}

/** 自动分类规则（仅在可靠可判时返回非 unknown，docs/V1_2_MASTERY_SPEC.md §6） */
export function autoCategory(status: JudgeStatus): ErrorCategory {
  if (status === 'compile_error') return 'syntax'
  if (status === 'time_limit_exceeded') return 'algorithm'
  return 'unknown'
}

export class MistakeReviewService {
  constructor(private readonly db: Database.Database) {}

  /** 错误历史（时间倒序）：状态、语言、错误代码、错误信息、分类 */
  getHistory(problemId: string): MistakeHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.language, s.code, s.status, s.created_at,
                er.message AS message, er.learning_category, er.category_source
         FROM submissions s
         LEFT JOIN error_records er ON er.submission_id = s.id
         WHERE s.problem_id = ? AND s.status != 'accepted'
         ORDER BY s.created_at DESC, s.rowid DESC`
      )
      .all(problemId) as FailureRow[]
    return rows.map((r) => ({
      submissionId: r.id,
      status: r.status as JudgeStatus,
      language: r.language as LanguageId,
      code: r.code,
      message: r.message ?? '',
      learningCategory: this.normalizeCategory(r.learning_category),
      categorySource: r.category_source as 'auto' | 'manual' | null,
      createdAt: r.created_at
    }))
  }

  /** 首次与最近一次错误代码（同一题；时间序的两端） */
  firstAndLatestCode(problemId: string): { firstCode: string | null; latestCode: string | null } {
    const first = (
      this.db
        .prepare(
          `SELECT code FROM submissions WHERE problem_id = ? AND status != 'accepted'
           ORDER BY created_at ASC, rowid ASC LIMIT 1`
        )
        .get(problemId) as { code: string } | undefined
    )?.code
    const latest = (
      this.db
        .prepare(
          `SELECT code FROM submissions WHERE problem_id = ? AND status != 'accepted'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(problemId) as { code: string } | undefined
    )?.code
    return { firstCode: first ?? null, latestCode: latest ?? null }
  }

  getNote(problemId: string): { problemId: string; note: string; updatedAt: number } | null {
    const row = this.db
      .prepare('SELECT problem_id, note, updated_at FROM mistake_notes WHERE problem_id = ?')
      .get(problemId) as { problem_id: string; note: string; updated_at: number } | undefined
    if (row === undefined) return null
    return { problemId: row.problem_id, note: row.note, updatedAt: row.updated_at }
  }

  setNote(problemId: string, note: string, now: number): { problemId: string; note: string; updatedAt: number } {
    const problem = this.db.prepare('SELECT id FROM problems WHERE id = ?').get(problemId)
    if (problem === undefined) throw new AppError('not_found', `题目不存在: ${problemId}`)
    this.db
      .prepare(
        `INSERT INTO mistake_notes (problem_id, note, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(problem_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
      )
      .run(problemId, note, now)
    return { problemId, note, updatedAt: now }
  }

  /** 手动设置分类：更新该题最近一条错误记录（category_source='manual'） */
  setCategory(problemId: string, category: ErrorCategory, now: number): void {
    if (!(ERROR_CATEGORIES as readonly string[]).includes(category)) {
      throw new AppError('validation', `未知的错误分类: ${category}`)
    }
    const row = this.db
      .prepare(
        `SELECT id FROM error_records WHERE problem_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(problemId) as { id: string } | undefined
    if (row === undefined) {
      throw new AppError('not_found', '该题没有错误记录，无法设置分类')
    }
    this.db
      .prepare(`UPDATE error_records SET learning_category = ?, category_source = 'manual' WHERE id = ?`)
      .run(category === 'unknown' ? null : category, row.id)
    void now
  }

  /** 最近一次非空分类（列表聚合展示用） */
  latestCategory(problemId: string): ErrorCategory | null {
    const row = this.db
      .prepare(
        `SELECT learning_category FROM error_records
         WHERE problem_id = ? AND learning_category IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(problemId) as { learning_category: string | null } | undefined
    return this.normalizeCategory(row?.learning_category ?? null)
  }

  private normalizeCategory(raw: string | null): ErrorCategory | null {
    if (raw === null) return null
    return (ERROR_CATEGORIES as readonly string[]).includes(raw) ? (raw as ErrorCategory) : null
  }
}
