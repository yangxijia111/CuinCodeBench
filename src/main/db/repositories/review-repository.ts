import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { ReviewGrade, ReviewHistoryEntry, ReviewItem } from '@shared/types'

/**
 * 复习调度仓储：review_items / review_history（docs/V1_2_REVIEW_SPEC.md §2）。
 */

interface ReviewItemRow {
  id: string
  target_type: string
  target_id: string
  last_reviewed_at: number | null
  next_review_at: number
  review_count: number
  success_streak: number
  failure_count: number
  interval_days: number
  created_at: number
}

function rowToItem(r: ReviewItemRow): ReviewItem {
  return {
    id: r.id,
    targetType: r.target_type as 'knowledge_point' | 'problem',
    targetId: r.target_id,
    lastReviewedAt: r.last_reviewed_at,
    nextReviewAt: r.next_review_at,
    reviewCount: r.review_count,
    successStreak: r.success_streak,
    failureCount: r.failure_count,
    intervalDays: r.interval_days,
    createdAt: r.created_at
  }
}

export class ReviewRepository {
  constructor(private readonly db: Database.Database) {}

  getByTarget(targetType: 'knowledge_point' | 'problem', targetId: string): ReviewItem | null {
    const row = this.db
      .prepare('SELECT * FROM review_items WHERE target_type = ? AND target_id = ?')
      .get(targetType, targetId) as ReviewItemRow | undefined
    return row ? rowToItem(row) : null
  }

  getById(id: string): ReviewItem | null {
    const row = this.db.prepare('SELECT * FROM review_items WHERE id = ?').get(id) as
      | ReviewItemRow
      | undefined
    return row ? rowToItem(row) : null
  }

  /** 到期项（next_review_at <= now），按 next_review_at 升序 */
  listDue(now: number): ReviewItem[] {
    const rows = this.db
      .prepare('SELECT * FROM review_items WHERE next_review_at <= ? ORDER BY next_review_at, rowid')
      .all(now) as ReviewItemRow[]
    return rows.map(rowToItem)
  }

  listAll(): ReviewItem[] {
    const rows = this.db.prepare('SELECT * FROM review_items ORDER BY next_review_at, rowid').all() as ReviewItemRow[]
    return rows.map(rowToItem)
  }

  /** 到期计数（Dashboard 用） */
  countDue(now: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM review_items WHERE next_review_at <= ?').get(now) as { c: number }).c
  }

  create(targetType: 'knowledge_point' | 'problem', targetId: string, nextReviewAt: number, now: number): ReviewItem {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO review_items (id, target_type, target_id, last_reviewed_at, next_review_at, review_count, success_streak, failure_count, interval_days, created_at)
         VALUES (?, ?, ?, NULL, ?, 0, 0, 0, 0, ?)`
      )
      .run(id, targetType, targetId, nextReviewAt, now)
    return this.getById(id) as ReviewItem
  }

  /** 评分落库：更新调度状态 + 追加历史（同一事务） */
  applyGrade(itemId: string, grade: ReviewGrade, next: { intervalDays: number; successStreak: number; nextReviewAt: number }, now: number, submissionId: string | null): void {
    const tx = this.db.transaction(() => {
      const isAgain = grade === 'again'
      this.db
        .prepare(
          `UPDATE review_items SET last_reviewed_at = ?, next_review_at = ?, review_count = review_count + 1,
             success_streak = ?, failure_count = failure_count + ?, interval_days = ?
           WHERE id = ?`
        )
        .run(now, next.nextReviewAt, next.successStreak, isAgain ? 1 : 0, next.intervalDays, itemId)
      this.db
        .prepare(
          `INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id) VALUES (?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), itemId, grade, now, submissionId)
    })
    tx()
  }

  deleteByTarget(targetType: 'knowledge_point' | 'problem', targetId: string): void {
    this.db.prepare('DELETE FROM review_items WHERE target_type = ? AND target_id = ?').run(targetType, targetId)
  }

  deleteByProblem(problemId: string): void {
    this.deleteByTarget('problem', problemId)
  }

  listHistory(itemId: string, limit = 20): ReviewHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM review_history WHERE review_item_id = ? ORDER BY reviewed_at DESC LIMIT ?')
      .all(itemId, limit) as { id: string; review_item_id: string; result: string; reviewed_at: number; submission_id: string | null }[]
    return rows.map((r) => ({
      id: r.id,
      reviewItemId: r.review_item_id,
      result: r.result as ReviewGrade,
      reviewedAt: r.reviewed_at,
      submissionId: r.submission_id
    }))
  }
}
