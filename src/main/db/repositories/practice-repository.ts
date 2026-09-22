import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { PracticeSession, PracticeSessionItem } from '@shared/types'

/**
 * 练习队列仓储：随机练习 / 专项训练 / 复习会话的组题容器（docs/V1_2_LEARNING_MODEL.md §2）。
 */

interface SessionRow {
  id: string
  kind: string
  knowledge_point_id: string | null
  config: string
  status: string
  total: number
  created_at: number
  finished_at: number | null
}

interface ItemRow {
  id: string
  session_id: string
  problem_id: string
  sort_order: number
  status: string
  attempts: number
  first_accepted_submission_id: string | null
  first_result_at: number | null
}

function toItem(r: ItemRow): PracticeSessionItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    problemId: r.problem_id,
    sortOrder: r.sort_order,
    status: r.status as PracticeSessionItem['status'],
    attempts: r.attempts,
    firstAcceptedSubmissionId: r.first_accepted_submission_id,
    firstResultAt: r.first_result_at
  }
}

export class PracticeRepository {
  constructor(private readonly db: Database.Database) {}

  createSession(
    kind: PracticeSession['kind'],
    knowledgePointId: string | null,
    config: Record<string, unknown>,
    problemIds: string[],
    now: number
  ): PracticeSession {
    const id = randomUUID()
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO practice_sessions (id, kind, knowledge_point_id, config, status, total, created_at, finished_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`
        )
        .run(id, kind, knowledgePointId, JSON.stringify(config), problemIds.length, now)
      const stmt = this.db.prepare(
        `INSERT INTO practice_session_items (id, session_id, problem_id, sort_order, status, attempts, first_accepted_submission_id, first_result_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL)`
      )
      problemIds.forEach((pid, i) => stmt.run(randomUUID(), id, pid, i))
    })
    tx()
    return this.getSession(id) as PracticeSession
  }

  getSession(id: string): PracticeSession | null {
    const row = this.db.prepare('SELECT * FROM practice_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    if (row === undefined) return null
    return this.toSession(row)
  }

  private toSession(row: SessionRow): PracticeSession {
    const items = (
      this.db
        .prepare('SELECT * FROM practice_session_items WHERE session_id = ? ORDER BY sort_order, rowid')
        .all(row.id) as ItemRow[]
    ).map(toItem)
    return {
      id: row.id,
      kind: row.kind as PracticeSession['kind'],
      knowledgePointId: row.knowledge_point_id,
      config: JSON.parse(row.config) as Record<string, unknown>,
      status: row.status as PracticeSession['status'],
      total: row.total,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      items
    }
  }

  /** 最新的未完成会话（各 kind 独立） */
  getLatestActive(kind: PracticeSession['kind']): PracticeSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM practice_sessions WHERE kind = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(kind) as SessionRow | undefined
    return row ? this.toSession(row) : null
  }

  /** 最近完成的指定 kind 会话（finished_at >= since） */
  getLatestFinished(kind: PracticeSession['kind'], since: number): PracticeSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM practice_sessions WHERE kind = ? AND status = 'finished' AND finished_at >= ?
         ORDER BY finished_at DESC, rowid DESC LIMIT 1`
      )
      .get(kind, since) as SessionRow | undefined
    return row ? this.toSession(row) : null
  }

  /** 判题 hook：找到包含该题的 active 复习/练习会话 */
  findActiveSessionsForProblem(problemId: string, kinds: PracticeSession['kind'][]): PracticeSession[] {
    const placeholders = kinds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ps.* FROM practice_sessions ps
         JOIN practice_session_items psi ON psi.session_id = ps.id
         WHERE ps.status = 'active' AND psi.problem_id = ? AND ps.kind IN (${placeholders})`
      )
      .all(problemId, ...kinds) as SessionRow[]
    return rows.map((r) => this.toSession(r))
  }

  /** 报告某题结果：更新会话内题目状态；会话内全部有结果时自动收尾 */
  reportResult(
    sessionId: string,
    problemId: string,
    accepted: boolean,
    submissionId: string | null,
    now: number
  ): PracticeSession | null {
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE practice_session_items SET
             attempts = attempts + 1,
             status = CASE WHEN status = 'accepted' THEN 'accepted' WHEN ? THEN 'accepted' ELSE 'failed' END,
             first_accepted_submission_id = COALESCE(first_accepted_submission_id, ?),
             first_result_at = COALESCE(first_result_at, ?)
           WHERE session_id = ? AND problem_id = ? AND status != 'skipped'`
        )
        .run(accepted ? 1 : 0, accepted ? submissionId : null, now, sessionId, problemId)
      if (res.changes === 0) return
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM practice_session_items WHERE session_id = ? AND status = 'pending'`
        )
        .get(sessionId) as { c: number }
      if (pending.c === 0) {
        this.db
          .prepare(`UPDATE practice_sessions SET status = 'finished', finished_at = ? WHERE id = ?`)
          .run(now, sessionId)
      }
    })
    tx()
    return this.getSession(sessionId)
  }

  finish(sessionId: string, now: number): void {
    this.db
      .prepare(`UPDATE practice_sessions SET status = 'finished', finished_at = ? WHERE id = ?`)
      .run(now, sessionId)
  }
}
