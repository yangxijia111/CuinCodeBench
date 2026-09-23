import type Database from 'better-sqlite3'
import type { V2RecordType } from './backup-v2-format'

/**
 * staging 写入器（docs/V1_3_BACKUP_V2_SPEC.md §5.1）：
 * v2 流式记录 → staging.sqlite 逐行 INSERT（预编译语句）。
 * 写入顺序 = 导出顺序（FK 依赖序）；外层由调用方用单事务包裹。
 */

export class StagingWriter {
  private readonly stmts: Partial<Record<V2RecordType, Database.Statement>> = {}

  constructor(db: Database.Database) {
    const p = (sql: string): Database.Statement => db.prepare(sql)
    const register = (type: V2RecordType, stmt: Database.Statement): void => {
      this.stmts[type] = stmt
    }

    register(
      'setting',
      p('INSERT INTO settings (key, value) VALUES (?, ?)')
    )
    register(
      'learning_path',
      p(
        `INSERT INTO learning_paths (id, slug, title, description, is_builtin, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
      )
    )
    // learning_path 的 stages/kps 子结构用专用语句（见 writeLearningPath）
    this.stmtStage = p(
      `INSERT INTO learning_stages (id, path_id, title, description, sort_order) VALUES (?, ?, ?, ?, ?)`
    )
    this.stmtKp = p(
      `INSERT INTO knowledge_points (id, stage_id, name, description, sort_order, tags) VALUES (?, ?, ?, ?, ?, ?)`
    )
    register(
      'problem',
      p(
        `INSERT INTO problems (id, title, description, difficulty, tags, input_desc, output_desc, samples, initial_code, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
    )
    this.stmtCase = p(
      `INSERT INTO test_cases (id, problem_id, stdin, expected_stdout, timeout_ms, "order") VALUES (?, ?, ?, ?, ?, ?)`
    )
    register(
      'problem_knowledge',
      p('INSERT INTO problem_knowledge_points (problem_id, knowledge_point_id) VALUES (?, ?)')
    )
    register(
      'submission',
      p(
        `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
    )
    this.stmtResult = p(
      `INSERT INTO test_case_results (id, submission_id, test_case_id, "order", stdin, expected, actual, stderr, status, exit_code, duration_ms, termination_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    register(
      'error_record',
      p(
        `INSERT INTO error_records (id, submission_id, problem_id, language, error_type, message, created_at, learning_category, category_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
    )
    register(
      'mistake_book',
      p(
        `INSERT INTO mistake_book (problem_id, failed_count, first_failed_at, last_failed_at, last_error_type, error_type_counts, mastered, mastered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
    )
    register(
      'mistake_note',
      p('INSERT INTO mistake_notes (problem_id, note, updated_at) VALUES (?, ?, ?)')
    )
    register(
      'mastery',
      p('INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES (?, ?, ?, ?)')
    )
    register(
      'review_item',
      p(
        `INSERT INTO review_items (id, target_type, target_id, last_reviewed_at, next_review_at, review_count, success_streak, failure_count, interval_days, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
    )
    register(
      'review_history',
      p(`INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id) VALUES (?, ?, ?, ?, ?)`)
    )
    register(
      'practice_session',
      p(
        `INSERT INTO practice_sessions (id, kind, knowledge_point_id, config, status, total, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
    )
    this.stmtSessionItem = p(
      `INSERT INTO practice_session_items (id, session_id, problem_id, sort_order, status, attempts, first_accepted_submission_id, first_result_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    register(
      'review_session_result',
      p(
        `INSERT OR IGNORE INTO review_session_results (session_id, review_item_id, grade, submission_id, graded_at)
         VALUES (?, ?, ?, ?, ?)`
      )
    )
  }

  private readonly stmtStage: Database.Statement
  private readonly stmtKp: Database.Statement
  private readonly stmtCase: Database.Statement
  private readonly stmtResult: Database.Statement
  private readonly stmtSessionItem: Database.Statement

  /** 按 v2 导出顺序写入一条已校验记录 */
  insert(type: V2RecordType, data: unknown): void {
    switch (type) {
      case 'setting': {
        const d = data as { key: string; value: string }
        this.stmts.setting?.run(d.key, d.value)
        return
      }
      case 'learning_path': {
        const d = data as {
          id: string
          slug: string
          title: string
          description: string
          isBuiltin: boolean
          sortOrder: number
          stages: {
            id: string
            pathId: string
            title: string
            description: string
            sortOrder: number
            knowledgePoints: { id: string; stageId: string; name: string; description: string; sortOrder: number; tags: string[] }[]
          }[]
        }
        this.stmts.learning_path?.run(d.id, d.slug, d.title, d.description, d.isBuiltin ? 1 : 0, d.sortOrder)
        for (const s of d.stages) {
          this.stmtStage.run(s.id, s.pathId, s.title, s.description, s.sortOrder)
          for (const k of s.knowledgePoints) {
            this.stmtKp.run(k.id, k.stageId, k.name, k.description, k.sortOrder, JSON.stringify(k.tags))
          }
        }
        return
      }
      case 'problem': {
        const d = data as {
          id: string
          title: string
          description: string
          difficulty: string
          tags: string[]
          inputDesc: string
          outputDesc: string
          samples: unknown
          initialCode: unknown
          isBuiltin: boolean
          createdAt?: number
          updatedAt?: number
          testCases: { id: string; stdin: string; expectedStdout: string; timeoutMs: number }[]
        }
        this.stmts.problem?.run(
          d.id,
          d.title,
          d.description,
          d.difficulty,
          JSON.stringify(d.tags),
          d.inputDesc,
          d.outputDesc,
          JSON.stringify(d.samples),
          JSON.stringify(d.initialCode),
          d.isBuiltin ? 1 : 0,
          d.createdAt ?? Date.now(),
          d.updatedAt ?? Date.now()
        )
        for (const [i, c] of d.testCases.entries()) {
          this.stmtCase.run(c.id, d.id, c.stdin, c.expectedStdout, c.timeoutMs, i)
        }
        return
      }
      case 'problem_knowledge': {
        const d = data as { problemId: string; knowledgePointId: string }
        this.stmts.problem_knowledge?.run(d.problemId, d.knowledgePointId)
        return
      }
      case 'submission': {
        const d = data as {
          id: string
          problemId: string
          language: string
          code: string
          status: string
          passedCount: number
          totalCount: number
          durationMs: number
          createdAt: number
          results: {
            testCaseId: string
            order: number
            stdin: string
            expected: string
            actual: string | null
            stderr: string
            status: string
            exitCode: number | null
            durationMs: number
            terminationReason?: string | null
          }[]
        }
        this.stmts.submission?.run(d.id, d.problemId, d.language, d.code, d.status, d.passedCount, d.totalCount, d.durationMs, d.createdAt)
        for (const r of d.results) {
          this.stmtResult.run(
            `${d.id}:${r.testCaseId}`,
            d.id,
            r.testCaseId,
            r.order,
            r.stdin,
            r.expected,
            r.actual,
            r.stderr,
            r.status,
            r.exitCode,
            r.durationMs,
            r.terminationReason ?? null
          )
        }
        return
      }
      case 'error_record': {
        const d = data as {
          id: string
          submissionId: string
          problemId: string
          language: string
          errorType: string
          message: string
          createdAt: number
          learningCategory: string | null
          categorySource: string | null
        }
        this.stmts.error_record?.run(d.id, d.submissionId, d.problemId, d.language, d.errorType, d.message, d.createdAt, d.learningCategory, d.categorySource)
        return
      }
      case 'mistake_book': {
        const d = data as {
          problemId: string
          failedCount: number
          firstFailedAt: number | null
          lastFailedAt: number | null
          lastErrorType: string | null
          errorTypeCounts: Record<string, number>
          mastered: boolean
          masteredAt: number | null
        }
        this.stmts.mistake_book?.run(
          d.problemId,
          d.failedCount,
          d.firstFailedAt,
          d.lastFailedAt,
          d.lastErrorType,
          JSON.stringify(d.errorTypeCounts),
          d.mastered ? 1 : 0,
          d.masteredAt
        )
        return
      }
      case 'mistake_note': {
        const d = data as { problemId: string; note: string; updatedAt: number }
        this.stmts.mistake_note?.run(d.problemId, d.note, d.updatedAt)
        return
      }
      case 'mastery': {
        const d = data as { knowledgePointId: string; score: number; status: string; updatedAt: number }
        this.stmts.mastery?.run(d.knowledgePointId, d.score, d.status, d.updatedAt)
        return
      }
      case 'review_item': {
        const d = data as {
          id: string
          targetType: string
          targetId: string
          lastReviewedAt: number | null
          nextReviewAt: number
          reviewCount: number
          successStreak: number
          failureCount: number
          intervalDays: number
          createdAt: number
        }
        this.stmts.review_item?.run(d.id, d.targetType, d.targetId, d.lastReviewedAt, d.nextReviewAt, d.reviewCount, d.successStreak, d.failureCount, d.intervalDays, d.createdAt)
        return
      }
      case 'review_history': {
        const d = data as {
          id: string
          reviewItemId: string
          result: string
          reviewedAt: number
          submissionId: string | null
        }
        this.stmts.review_history?.run(d.id, d.reviewItemId, d.result, d.reviewedAt, d.submissionId)
        return
      }
      case 'practice_session': {
        const d = data as {
          id: string
          kind: string
          knowledgePointId: string | null
          config: Record<string, unknown>
          status: string
          total: number
          createdAt: number
          finishedAt: number | null
          items: {
            id: string
            problemId: string
            sortOrder: number
            status: string
            attempts: number
            firstAcceptedSubmissionId: string | null
            firstResultAt: number | null
          }[]
        }
        this.stmts.practice_session?.run(d.id, d.kind, d.knowledgePointId, JSON.stringify(d.config), d.status, d.total, d.createdAt, d.finishedAt)
        for (const i of d.items) {
          this.stmtSessionItem.run(i.id, d.id, i.problemId, i.sortOrder, i.status, i.attempts, i.firstAcceptedSubmissionId, i.firstResultAt)
        }
        return
      }
      case 'review_session_result': {
        const d = data as {
          sessionId: string
          reviewItemId: string
          grade: string
          submissionId: string | null
          gradedAt: number
        }
        this.stmts.review_session_result?.run(d.sessionId, d.reviewItemId, d.grade, d.submissionId, d.gradedAt)
        return
      }
    }
  }
}

/** staging 落库后的完整性校验（docs §5.1：任一失败 → 删 staging 拒绝恢复）。
 *  expected 按**表名**计数（调用方负责从 v2 类型键 / v1 Counts 键映射到表名）。 */
export function verifyStaging(db: Database.Database, expected: Record<string, number>): void {
  // 1) FK 与完整性
  const fk = db.pragma('foreign_key_check') as unknown[]
  if (fk.length > 0) {
    throw new Error(`staging 外键校验失败：${fk.length} 处引用断裂`)
  }
  const integrity = db.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') {
    throw new Error(`staging 完整性校验失败：${String(integrity).slice(0, 200)}`)
  }
  // 2) 计数对拍（staging 实际行数 vs 期望，按表名）
  for (const [table, exp] of Object.entries(expected)) {
    const actual = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    if (actual !== exp) {
      throw new Error(`staging 计数校验失败：${table} 期望 ${exp}，实际 ${actual}`)
    }
  }
  // 3) 多态引用（review_items 无 FK，需显式检查）
  const dangling = db
    .prepare(
      `SELECT COUNT(*) AS c FROM review_items r WHERE
         (r.target_type = 'problem' AND NOT EXISTS (SELECT 1 FROM problems p WHERE p.id = r.target_id)) OR
         (r.target_type = 'knowledge_point' AND NOT EXISTS (SELECT 1 FROM knowledge_points k WHERE k.id = r.target_id))`
    )
    .get() as { c: number }
  if (dangling.c > 0) {
    throw new Error(`staging 校验失败：${dangling.c} 条复习项指向不存在的目标（多态引用断裂）`)
  }
  // 4) 会话评分引用（exactly-once 表完整性）
  const badResults = db
    .prepare(
      `SELECT COUNT(*) AS c FROM review_session_results r WHERE
         NOT EXISTS (SELECT 1 FROM review_items i WHERE i.id = r.review_item_id) OR
         NOT EXISTS (SELECT 1 FROM practice_sessions s WHERE s.id = r.session_id)`
    )
    .get() as { c: number }
  if (badResults.c > 0) {
    throw new Error(`staging 校验失败：${badResults.c} 条会话评分记录引用断裂`)
  }
}
