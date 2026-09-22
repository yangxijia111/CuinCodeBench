import type Database from 'better-sqlite3'
import type { MasteryInfo, MasteryStatus, ReviewGrade } from '@shared/types'

/**
 * 掌握度仓储：物化缓存读写 + 计算所需的聚合查询。
 * 计算规则见 docs/V1_2_MASTERY_SPEC.md（mastery-service）。
 */
/**
 * 全部知识点的最后活动时刻（单条聚合查询；独立函数供其他仓储复用，避免构造实例）。
 * 读侧 effective 状态计算用（P1-B）：与 computeMastery 的 lastActivityAt 同源。
 */
export function kpLastActivityMap(db: Database.Database): Map<string, number | null> {
  const rows = db
    .prepare(
      `SELECT k.id AS kp,
         (SELECT MAX(ts) FROM (
            SELECT MAX(s.created_at) AS ts FROM submissions s
             WHERE s.problem_id IN (SELECT problem_id FROM problem_knowledge_points WHERE knowledge_point_id = k.id)
            UNION ALL
            SELECT MAX(rh.reviewed_at) FROM review_history rh
             JOIN review_items ri ON ri.id = rh.review_item_id
             WHERE ri.target_type = 'knowledge_point' AND ri.target_id = k.id
          )) AS last
       FROM knowledge_points k`
    )
    .all() as { kp: string; last: number | null }[]
  return new Map(rows.map((r) => [r.kp, r.last]))
}

export class MasteryRepository {
  constructor(private readonly db: Database.Database) {}

  get(knowledgePointId: string): MasteryInfo | null {
    const row = this.db
      .prepare('SELECT knowledge_point_id, score, status, updated_at FROM mastery WHERE knowledge_point_id = ?')
      .get(knowledgePointId) as
      | { knowledge_point_id: string; score: number; status: string; updated_at: number }
      | undefined
    if (row === undefined) return null
    return {
      knowledgePointId: row.knowledge_point_id,
      score: row.score,
      status: row.status as MasteryStatus,
      updatedAt: row.updated_at
    }
  }

  listAll(): MasteryInfo[] {
    const rows = this.db
      .prepare('SELECT knowledge_point_id, score, status, updated_at FROM mastery')
      .all() as { knowledge_point_id: string; score: number; status: string; updated_at: number }[]
    return rows.map((row) => ({
      knowledgePointId: row.knowledge_point_id,
      score: row.score,
      status: row.status as MasteryStatus,
      updatedAt: row.updated_at
    }))
  }

  /**
   * 全部知识点的最后活动时刻（最后一次提交或复习，单条聚合查询）。
   * 读侧 effective 状态计算用（P1-B）：与 computeMastery 的 lastActivityAt 同源。
   */
  lastActivityMap(): Map<string, number | null> {
    return kpLastActivityMap(this.db)
  }

  upsert(info: MasteryInfo): void {
    this.db
      .prepare(
        `INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(knowledge_point_id) DO UPDATE SET score = excluded.score, status = excluded.status, updated_at = excluded.updated_at`
      )
      .run(info.knowledgePointId, info.score, info.status, info.updatedAt)
  }

  remove(knowledgePointId: string): void {
    this.db.prepare('DELETE FROM mastery WHERE knowledge_point_id = ?').run(knowledgePointId)
  }

  // —— 计算输入聚合查询（docs/V1_2_MASTERY_SPEC.md §2） ——

  /** 表现样本：每题最近 `perProblem` 次提交（时间倒序），供内存截取最近 N 条 */
  recentSamplesPerProblem(
    knowledgePointId: string,
    perProblem: number
  ): { status: string; created_at: number }[] {
    return this.db
      .prepare(
        `SELECT status, created_at FROM (
           SELECT s.status, s.created_at,
                  ROW_NUMBER() OVER (PARTITION BY s.problem_id ORDER BY s.created_at DESC, s.rowid DESC) AS rn
           FROM submissions s
           WHERE s.problem_id IN (
             SELECT problem_id FROM problem_knowledge_points WHERE knowledge_point_id = ?
           )
         ) WHERE rn <= ? ORDER BY created_at DESC`
      )
      .all(knowledgePointId, perProblem) as { status: string; created_at: number }[]
  }

  /** 最近原始提交（时间倒序，用于 streak 与 weak 判定） */
  recentSubmissions(knowledgePointId: string, limit: number): { status: string; created_at: number }[] {
    return this.db
      .prepare(
        `SELECT s.status, s.created_at
         FROM submissions s
         WHERE s.problem_id IN (
           SELECT problem_id FROM problem_knowledge_points WHERE knowledge_point_id = ?
         )
         ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`
      )
      .all(knowledgePointId, limit) as { status: string; created_at: number }[]
  }

  /** 覆盖：绑定题目数与其中至少一次 AC 的题目数 */
  coverage(knowledgePointId: string): { total: number; covered: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT p.id) AS total,
                COUNT(DISTINCT CASE WHEN acc.problem_id IS NOT NULL THEN p.id END) AS covered
         FROM problem_knowledge_points pkp
         JOIN problems p ON p.id = pkp.problem_id
         LEFT JOIN (SELECT DISTINCT problem_id FROM submissions WHERE status = 'accepted') acc
           ON acc.problem_id = p.id
         WHERE pkp.knowledge_point_id = ?`
      )
      .get(knowledgePointId) as { total: number; covered: number }
    return row
  }

  /** 知识点复习历史的最近 N 次结果（时间倒序） */
  recentReviewResults(knowledgePointId: string, limit: number): ReviewGrade[] {
    const rows = this.db
      .prepare(
        `SELECT rh.result
         FROM review_history rh
         JOIN review_items ri ON ri.id = rh.review_item_id
         WHERE ri.target_type = 'knowledge_point' AND ri.target_id = ?
         ORDER BY rh.reviewed_at DESC, rh.rowid DESC LIMIT ?`
      )
      .all(knowledgePointId, limit) as { result: ReviewGrade }[]
    return rows.map((r) => r.result)
  }

  /** 知识点最后一次活动时间（最后提交或最后复习） */
  lastActivityAt(knowledgePointId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(ts) AS last FROM (
           SELECT MAX(created_at) AS ts FROM submissions
            WHERE problem_id IN (SELECT problem_id FROM problem_knowledge_points WHERE knowledge_point_id = ?)
           UNION ALL
           SELECT MAX(rh.reviewed_at) FROM review_history rh
            JOIN review_items ri ON ri.id = rh.review_item_id
            WHERE ri.target_type = 'knowledge_point' AND ri.target_id = ?
         )`
      )
      .get(knowledgePointId, knowledgePointId) as { last: number | null }
    return row.last
  }
}
