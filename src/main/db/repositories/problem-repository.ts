import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  Difficulty,
  LanguageId,
  Problem,
  ProblemDetail,
  ProblemInput,
  Sample,
  TestCase,
  TestCaseInput
} from '@shared/types'

/**
 * 题目仓储：Problem 聚合根（题目 + 测试用例）整体读写（ADR D2）。
 */

interface ProblemRow {
  id: string
  title: string
  description: string
  difficulty: string
  tags: string
  input_desc: string
  output_desc: string
  samples: string
  initial_code: string
  is_builtin: number
  created_at: number
  updated_at: number
}

interface TestCaseRow {
  id: string
  problem_id: string
  stdin: string
  expected_stdout: string
  timeout_ms: number
  order: number
}

function rowToProblem(row: ProblemRow, cases: TestCase[]): Problem {
  const initialCodeRaw = JSON.parse(row.initial_code) as Partial<Record<LanguageId, string>>
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    difficulty: row.difficulty as Difficulty,
    tags: JSON.parse(row.tags) as string[],
    inputDesc: row.input_desc,
    outputDesc: row.output_desc,
    samples: JSON.parse(row.samples) as Sample[],
    initialCode: {
      c: initialCodeRaw['c'] ?? '',
      cpp: initialCodeRaw['cpp'] ?? '',
      python: initialCodeRaw['python'] ?? ''
    },
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 测试用例附加在聚合上（Problem 类型本身不含用例，查询方按需取）
    ...(cases.length >= 0 ? {} : {})
  }
}

export type ProblemWithCases = ProblemDetail

export class ProblemRepository {
  constructor(private readonly db: Database.Database) {}

  /** 建聚合：题目与用例同一事务写入 */
  create(input: ProblemInput, isBuiltin = false): ProblemWithCases {
    const now = Date.now()
    const id = randomUUID()
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO problems (id, title, description, difficulty, tags, input_desc, output_desc, samples, initial_code, is_builtin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.title,
          input.description,
          input.difficulty,
          JSON.stringify(input.tags),
          input.inputDesc,
          input.outputDesc,
          JSON.stringify(input.samples),
          JSON.stringify(input.initialCode),
          isBuiltin ? 1 : 0,
          now,
          now
        )
      this.insertCases(id, input.testCases)
    })
    tx()
    const created = this.getById(id)
    if (!created) throw new Error('题目创建后读取失败')
    return created
  }

  update(id: string, input: ProblemInput): ProblemWithCases {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE problems SET title=?, description=?, difficulty=?, tags=?, input_desc=?, output_desc=?, samples=?, initial_code=?, updated_at=?
           WHERE id=?`
        )
        .run(
          input.title,
          input.description,
          input.difficulty,
          JSON.stringify(input.tags),
          input.inputDesc,
          input.outputDesc,
          JSON.stringify(input.samples),
          JSON.stringify(input.initialCode),
          now,
          id
        )
      if (res.changes === 0) throw new Error(`题目不存在: ${id}`)
      // 用例整体替换（聚合根更新语义）
      this.db.prepare('DELETE FROM test_cases WHERE problem_id=?').run(id)
      this.insertCases(id, input.testCases)
    })
    tx()
    const updated = this.getById(id)
    if (!updated) throw new Error(`题目更新后读取失败: ${id}`)
    return updated
  }

  private insertCases(problemId: string, cases: TestCaseInput[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO test_cases (id, problem_id, stdin, expected_stdout, timeout_ms, "order")
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    cases.forEach((tc, i) => {
      stmt.run(randomUUID(), problemId, tc.stdin, tc.expectedStdout, tc.timeoutMs, i)
    })
  }

  getById(id: string): ProblemWithCases | null {
    const row = this.db.prepare('SELECT * FROM problems WHERE id=?').get(id) as
      | ProblemRow
      | undefined
    if (!row) return null
    const cases = this.getCases(id)
    return { ...rowToProblem(row, cases), testCases: cases }
  }

  /** 列表（不含用例内容，避免大查询）；筛选条件可组合 */
  list(query: { keyword: string; difficulty: Difficulty | 'all'; tag: string }): Problem[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (query.keyword.trim() !== '') {
      conditions.push('(title LIKE ? OR description LIKE ?)')
      const like = `%${query.keyword.trim()}%`
      params.push(like, like)
    }
    if (query.difficulty !== 'all') {
      conditions.push('difficulty = ?')
      params.push(query.difficulty)
    }
    if (query.tag !== 'all' && query.tag !== '') {
      // tags 为 JSON 数组文本：匹配 "tag"（带引号保证整词，兼容多标签数组）
      conditions.push("tags LIKE ? ESCAPE '\\'")
      const escaped = query.tag.replace(/[\\%_]/g, (c) => `\\${c}`)
      params.push(`%"${escaped}"%`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM problems ${where} ORDER BY updated_at DESC`)
      .all(...params) as ProblemRow[]
    return rows.map((r) => rowToProblem(r, []))
  }

  delete(id: string): void {
    const res = this.db.prepare('DELETE FROM problems WHERE id=?').run(id)
    if (res.changes === 0) throw new Error(`题目不存在: ${id}`)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }
    return row.c
  }

  getCases(problemId: string): TestCase[] {
    const rows = this.db
      .prepare('SELECT * FROM test_cases WHERE problem_id=? ORDER BY "order"')
      .all(problemId) as TestCaseRow[]
    return rows.map((r) => ({
      id: r.id,
      problemId: r.problem_id,
      stdin: r.stdin,
      expectedStdout: r.expected_stdout,
      timeoutMs: r.timeout_ms,
      order: r.order
    }))
  }

  /** 全库标签去重列表（筛选下拉用） */
  listTags(): string[] {
    const rows = this.db.prepare('SELECT tags FROM problems').all() as { tags: string }[]
    const set = new Set<string>()
    for (const r of rows) {
      for (const t of JSON.parse(r.tags) as string[]) set.add(t)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }
}
