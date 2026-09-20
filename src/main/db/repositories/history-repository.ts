import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  JudgeStatus,
  LanguageId,
  ProblemStats,
  Submission,
  SubmissionQuery,
  TestCaseResult
} from '@shared/types'

/**
 * 提交历史仓储：提交、用例明细、每题统计（FR-H1–H4）。
 */

interface SubmissionRow {
  id: string
  problem_id: string
  language: string
  code: string
  status: string
  passed_count: number
  total_count: number
  duration_ms: number
  created_at: number
  problem_title?: string
}

interface TestCaseResultRow {
  id: string
  submission_id: string
  test_case_id: string
  order: number
  stdin: string
  expected: string
  actual: string | null
  stderr: string
  status: string
  exit_code: number | null
  duration_ms: number
}

function toSubmission(row: SubmissionRow): Submission & { problemTitle?: string } {
  return {
    id: row.id,
    problemId: row.problem_id,
    language: row.language as LanguageId,
    code: row.code,
    status: row.status as JudgeStatus,
    passedCount: row.passed_count,
    totalCount: row.total_count,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    ...(row.problem_title !== undefined ? { problemTitle: row.problem_title } : {})
  }
}

export interface NewSubmission {
  problemId: string
  language: LanguageId
  code: string
  status: JudgeStatus
  passedCount: number
  totalCount: number
  durationMs: number
}

export interface NewTestCaseResult {
  testCaseId: string
  order: number
  stdin: string
  expected: string
  actual: string | null
  stderr: string
  status: JudgeStatus
  exitCode: number | null
  durationMs: number
}

export class HistoryRepository {
  constructor(private readonly db: Database.Database) {}

  /** 写入提交 + 明细（同一事务）；返回提交 id */
  insertSubmission(sub: NewSubmission, results: NewTestCaseResult[]): string {
    const id = randomUUID()
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          sub.problemId,
          sub.language,
          sub.code,
          sub.status,
          sub.passedCount,
          sub.totalCount,
          sub.durationMs,
          now
        )
      const stmt = this.db.prepare(
        `INSERT INTO test_case_results (id, submission_id, test_case_id, "order", stdin, expected, actual, stderr, status, exit_code, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const r of results) {
        stmt.run(`${id}:${r.testCaseId}`, id, r.testCaseId, r.order, r.stdin, r.expected, r.actual, r.stderr, r.status, r.exitCode, r.durationMs)
      }
      // 判题失败时写错误记录（FR-M1；message 由 service 提供，此处按状态生成摘要占位由 service 决定）
    })
    tx()
    return id
  }

  /** 写错误记录（FR-M1），由 judge-service 在失败时调用 */
  insertErrorRecord(rec: {
    submissionId: string
    problemId: string
    language: LanguageId
    errorType: JudgeStatus
    message: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO error_records (id, submission_id, problem_id, language, error_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), rec.submissionId, rec.problemId, rec.language, rec.errorType, rec.message, Date.now())
  }

  list(query: SubmissionQuery): (Submission & { problemTitle: string })[] {
    const where = query.problemId ? 'WHERE s.problem_id = ?' : ''
    const params = query.problemId ? [query.problemId, query.limit, query.offset] : [query.limit, query.offset]
    const rows = this.db
      .prepare(
        `SELECT s.*, p.title AS problem_title
         FROM submissions s JOIN problems p ON p.id = s.problem_id
         ${where}
         ORDER BY s.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params) as SubmissionRow[]
    return rows.map((r) => {
      const s = toSubmission(r)
      return { ...s, problemTitle: r.problem_title ?? '' }
    })
  }

  getById(id: string):
    | { submission: Submission & { problemTitle: string }; results: TestCaseResult[] }
    | null {
    const row = this.db
      .prepare(
        `SELECT s.*, p.title AS problem_title
         FROM submissions s JOIN problems p ON p.id = s.problem_id
         WHERE s.id = ?`
      )
      .get(id) as SubmissionRow | undefined
    if (!row) return null
    const resultRows = this.db
      .prepare('SELECT * FROM test_case_results WHERE submission_id = ? ORDER BY "order"')
      .all(id) as TestCaseResultRow[]
    const results: TestCaseResult[] = resultRows.map((r) => ({
      testCaseId: r.test_case_id,
      order: r.order,
      stdin: r.stdin,
      expected: r.expected,
      actual: r.actual,
      stderr: r.stderr,
      status: r.status as JudgeStatus,
      exitCode: r.exit_code,
      durationMs: r.duration_ms
    }))
    const sub = toSubmission(row)
    return { submission: { ...sub, problemTitle: row.problem_title ?? '' }, results }
  }

  getProblemStats(problemId: string): ProblemStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS attempts,
           SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
           MIN(CASE WHEN status = 'accepted' THEN created_at END) AS first_accepted_at,
           MAX(created_at) AS last_attempt_at
         FROM submissions WHERE problem_id = ?`
      )
      .get(problemId) as {
      attempts: number
      accepted_count: number | null
      first_accepted_at: number | null
      last_attempt_at: number | null
    }
    return {
      problemId,
      attempts: row.attempts,
      acceptedCount: row.accepted_count ?? 0,
      firstAcceptedAt: row.first_accepted_at,
      lastAttemptAt: row.last_attempt_at
    }
  }
}
