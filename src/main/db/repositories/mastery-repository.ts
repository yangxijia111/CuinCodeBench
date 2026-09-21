import type Database from 'better-sqlite3'
import type { MasteryInfo, MasteryStatus } from '@shared/types'

/**
 * 掌握度仓储：物化缓存读写（可全量重算）。
 * 计算规则见 docs/V1_2_MASTERY_SPEC.md（mastery-service）。
 */
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
}
