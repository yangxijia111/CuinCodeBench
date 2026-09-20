import type Database from 'better-sqlite3'
import type { JudgeStatus, MistakeBookEntry } from '@shared/types'
import { MISTAKE_THRESHOLD } from '@shared/constants'

/**
 * 错题本仓储：按题目聚合失败情况（FR-M1–M4）。
 * 聚合数据由 submissions 派生重算（mistake-service 触发）；mastered 用户标记永久保留。
 */

interface MistakeRow {
  problem_id: string
  failed_count: number
  first_failed_at: number | null
  last_failed_at: number | null
  last_error_type: string | null
  error_type_counts: string
  mastered: number
  mastered_at: number | null
  problem_title: string
}

export class MistakeRepository {
  constructor(private readonly db: Database.Database) {}

  /** 从 submissions 全量重算某题的错题聚合；保留 mastered 标记 */
  recompute(problemId: string): void {
    const tx = this.db.transaction(() => {
      const stats = this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN status != 'accepted' THEN 1 ELSE 0 END) AS failed_count,
             MIN(CASE WHEN status != 'accepted' THEN created_at END) AS first_failed_at,
             MAX(CASE WHEN status != 'accepted' THEN created_at END) AS last_failed_at
           FROM submissions WHERE problem_id = ?`
        )
        .get(problemId) as {
        failed_count: number | null
        first_failed_at: number | null
        last_failed_at: number | null
      }

      const failedCount = stats.failed_count ?? 0
      if (failedCount === 0) {
        this.db.prepare('DELETE FROM mistake_book WHERE problem_id = ?').run(problemId)
        return
      }

      const lastTypeRow = this.db
        .prepare(
          `SELECT status FROM submissions
           WHERE problem_id = ? AND status != 'accepted'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(problemId) as { status: string } | undefined

      const typeRows = this.db
        .prepare(
          `SELECT status, COUNT(*) AS c FROM submissions
           WHERE problem_id = ? AND status != 'accepted'
           GROUP BY status`
        )
        .all(problemId) as { status: string; c: number }[]
      const counts: Record<string, number> = {}
      for (const r of typeRows) counts[r.status] = r.c

      this.db
        .prepare(
          `INSERT INTO mistake_book (problem_id, failed_count, first_failed_at, last_failed_at, last_error_type, error_type_counts, mastered, mastered_at)
           VALUES (?, ?, ?, ?, ?, ?,
             COALESCE((SELECT mastered FROM mistake_book WHERE problem_id = ?), 0),
             (SELECT mastered_at FROM mistake_book WHERE problem_id = ?))
           ON CONFLICT(problem_id) DO UPDATE SET
             failed_count = excluded.failed_count,
             first_failed_at = excluded.first_failed_at,
             last_failed_at = excluded.last_failed_at,
             last_error_type = excluded.last_error_type,
             error_type_counts = excluded.error_type_counts`
        )
        .run(
          problemId,
          failedCount,
          stats.first_failed_at,
          stats.last_failed_at,
          lastTypeRow?.status ?? null,
          JSON.stringify(counts),
          problemId,
          problemId
        )
    })
    tx()
  }

  /** 错题列表：失败次数达阈值且未标记掌握（FR-M2/M3） */
  listUnmastered(): MistakeBookEntry[] {
    return this.listWhere('mb.failed_count >= ? AND mb.mastered = 0', MISTAKE_THRESHOLD)
  }

  listAll(): MistakeBookEntry[] {
    return this.listWhere('mb.failed_count >= ?', MISTAKE_THRESHOLD)
  }

  private listWhere(where: string, threshold: number): MistakeBookEntry[] {
    const rows = this.db
      .prepare(
        `SELECT mb.*, p.title AS problem_title
         FROM mistake_book mb JOIN problems p ON p.id = mb.problem_id
         WHERE ${where}
         ORDER BY mb.last_failed_at DESC`
      )
      .all(threshold) as MistakeRow[]
    return rows.map((r) => {
      const rawCounts = JSON.parse(r.error_type_counts) as Record<string, number>
      const errorTypeCounts = Object.entries(rawCounts)
        .map(([type, count]) => ({ type: type as JudgeStatus, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      return {
        problemId: r.problem_id,
        problemTitle: r.problem_title,
        failedCount: r.failed_count,
        firstFailedAt: r.first_failed_at ?? 0,
        lastFailedAt: r.last_failed_at ?? 0,
        lastErrorType: (r.last_error_type ?? 'wrong_answer') as JudgeStatus,
        errorTypeCounts,
        mastered: r.mastered === 1,
        masteredAt: r.mastered_at
      }
    })
  }

  setMastered(problemId: string, mastered: boolean): void {
    const res = this.db
      .prepare('UPDATE mistake_book SET mastered = ?, mastered_at = ? WHERE problem_id = ?')
      .run(mastered ? 1 : 0, mastered ? Date.now() : null, problemId)
    if (res.changes === 0) throw new Error(`错题记录不存在: ${problemId}`)
  }
}
