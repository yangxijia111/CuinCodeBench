import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { StatsRepository } from '../src/main/db/repositories/stats-repository'
import { MistakeRepository } from '../src/main/db/repositories/mistake-repository'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { ReviewService } from '../src/main/services/review-service'
import { makeProblemInput } from './helpers'
import type { ProblemInput } from '../src/shared/types'

/**
 * 性能门禁（docs/V1_2_PRODUCT.md §5 / V1_2_ROADMAP.md P9）：
 * 100 题目 / 10000 提交 / 大量错误与复习数据下，核心查询应在宽松阈值（2s）内完成。
 * 数据在运行时动态生成，不提交任何数据文件。
 * 索引依据：idx_submissions_problem(problem_id, created_at DESC)、idx_submissions_created、
 * idx_review_due(next_review_at)、idx_pkk_kp 等（docs/V1_2_LEARNING_MODEL.md §2）。
 */

const PROBLEMS = 100
const SUBMISSIONS = 10_000
const TIMEOUT_MS = 2_000

function makeProblem(title: string): ProblemInput {
  return { ...makeProblemInput({ title }), testCases: [{ stdin: '', expectedStdout: '', timeoutMs: 5000 }] }
}

async function timed<T>(fn: () => T): Promise<{ result: T; ms: number }> {
  const start = performance.now()
  const result = fn()
  if (result instanceof Promise) await result
  return { result, ms: performance.now() - start }
}

describe.skipIf(process.env['CCB_SKIP_PERF'] === '1')('性能（100 题 / 10000 提交）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    const problems = new ProblemRepository(db)
    const learning = new LearningRepository(db)
    learning.ensureBuiltinPath({
      path: { slug: 'c-basics', title: 'C', description: '' },
      stages: [
        {
          title: 's',
          description: '',
          knowledgePoints: [
            { name: 'kp-a', description: '', tags: [] },
            { name: 'kp-b', description: '', tags: [] }
          ]
        }
      ],
      builtinProblemMap: {}
    })

    const ids: string[] = []
    for (let i = 0; i < PROBLEMS; i++) {
      const p = problems.create(makeProblem(`题-${i}`), true)
      ids.push(p.id)
      // 每题绑定知识点（一半 a 一半 b）
      learning.bindProblem(p.id, i % 2 === 0 ? 'kp:c-basics:0:0' : 'kp:c-basics:0:1')
    }

    // 批量灌 10000 提交 + 约 3000 错误记录（单事务）
    const insertSub = db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES (?, ?, 'c', 'x', ?, ?, 3, ?, ?)`
    )
    const insertErr = db.prepare(
      `INSERT INTO error_records (id, submission_id, problem_id, language, error_type, message, created_at)
       VALUES (?, ?, ?, 'c', 'wrong_answer', 'm', ?)`
    )
    const now = Date.now()
    const tx = db.transaction(() => {
      for (let i = 0; i < SUBMISSIONS; i++) {
        const pid = ids[i % PROBLEMS]
        const status = i % 3 === 0 ? 'accepted' : 'wrong_answer'
        const sid = `perf-s-${i}`
        insertSub.run(sid, pid, status, status === 'accepted' ? 3 : 0, 10 + (i % 100), now - i * 3600_000)
        if (status !== 'accepted') insertErr.run(`perf-e-${i}`, sid, pid, now - i * 3600_000)
      }
      // 错题聚合行
      db.exec(`
        INSERT INTO mistake_book (problem_id, failed_count, last_error_type, error_type_counts)
        SELECT problem_id, COUNT(*), 'wrong_answer', '{}' FROM submissions
        WHERE status != 'accepted' GROUP BY problem_id HAVING COUNT(*) >= 2;
      `)
      // 复习项：一半错题到期
      db.exec(`
        INSERT INTO review_items (id, target_type, target_id, next_review_at, created_at)
        SELECT 'ri-p-' || problem_id, 'problem', problem_id, ${Date.now() - 1000}, ${Date.now()}
        FROM mistake_book LIMIT 40;
      `)
    })
    tx()
  })

  it('getDashboardV2（含趋势聚合）< 2s', async () => {
    const stats = new StatsRepository(db)
    const { ms } = await timed(() => stats.getDashboardV2(Date.now()))
    expect(ms).toBeLessThan(TIMEOUT_MS)
  })

  it('错题列表 < 2s', async () => {
    const mistakes = new MistakeRepository(db)
    const { result, ms } = await timed(() => mistakes.listUnmastered())
    expect(result.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(TIMEOUT_MS)
  })

  it('复习到期队列 < 2s', async () => {
    const svc = new ReviewService(db)
    const { result, ms } = await timed(() => svc.reviews.listDue(Date.now()))
    expect(result.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(TIMEOUT_MS)
  })

  it('学习路线进度聚合 < 2s', async () => {
    const learning = new LearningRepository(db)
    const { result, ms } = await timed(() => learning.aggregateKpProgress())
    expect(result.length).toBe(2)
    expect(ms).toBeLessThan(TIMEOUT_MS)
  })

  it('题库列表（关键词搜索）< 2s', async () => {
    const problems = new ProblemRepository(db)
    const { result, ms } = await timed(() => problems.list({ keyword: '题-1', difficulty: 'all', tag: 'all' }))
    expect(result.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(TIMEOUT_MS)
  })
})
