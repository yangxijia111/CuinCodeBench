import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { StatsRepository } from '../src/main/db/repositories/stats-repository'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { localDayStartMs, toLocalDayKey } from '../src/shared/local-calendar-day'
import { makeProblemInput } from './helpers'

/**
 * P6 验收：Dashboard 2.0 聚合（今日复习/到期/错题待复习/掌握度列表/7 与 30 天趋势）。
 */

describe('Dashboard 2.0（stats.getDashboardV2）', () => {
  let db: Database.Database
  let stats: StatsRepository
  let history: HistoryRepository
  // 以真实时钟为基准（SQL 的 DATE('now','localtime') 用当前时间），避免跨日偏移
  const NOW = Date.now() + 60_000
  const DAY = 86_400_000

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    stats = new StatsRepository(db)
    history = new HistoryRepository(db)
    new LearningRepository(db).ensureBuiltinPath({
      seedVersion: 2,
      path: { slug: 'c-basics', title: 'C', description: '' },
      stages: [
        { slug: 's0', title: 's', description: '', knowledgePoints: [{ slug: 'array', name: '数组', description: '', tags: [] }] }
      ],
      builtinProblemMap: {}
    })
  })

  it('空库：全部指标为零、掌握度列表含 not_started 项、趋势为连续 N 天', () => {
    const d = stats.getDashboardV2(NOW)
    expect(d.todayReviews).toBe(0)
    expect(d.dueReviewCount).toBe(0)
    expect(d.mistakeDueCount).toBe(0)
    expect(d.masteryList).toHaveLength(1)
    expect(d.masteryList[0]).toMatchObject({ name: '数组', score: 0, status: 'not_started' })
    expect(d.trend7).toHaveLength(7)
    expect(d.trend30).toHaveLength(30)
    expect(d.trend7.every((p) => p.submissions === 0 && p.accepted === 0 && p.reviews === 0)).toBe(true)
    // 趋势序列最后一天是今天（本地日历）
    const today = new Date()
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(d.trend7[d.trend7.length - 1]?.day).toBe(key)
  })

  it('提交落库后：今日提交/趋势/AC 统计正确', () => {
    const p = new ProblemRepository(db).create(makeProblemInput(), true)
    // 今天 3 次提交 2 AC
    for (const status of ['accepted', 'wrong_answer', 'accepted'] as const) {
      history.insertSubmission(
        { problemId: p.id, language: 'c', code: 'x', status, passedCount: 1, totalCount: 1, durationMs: 1 },
        []
      )
    }
    // 昨天 1 次 AC（NOW - 1 天对齐）
    const yesterday = NOW - DAY
    db
      .prepare(
        `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
         VALUES ('old1', ?, 'c', 'x', 'accepted', 1, 1, 1, ?)`
      )
      .run(p.id, yesterday - 3600_000)

    const d = stats.getDashboardV2(NOW)
    expect(d.todaySubmissions).toBe(3)
    const todayPoint = d.trend7[d.trend7.length - 1]
    expect(todayPoint?.submissions).toBe(3)
    expect(todayPoint?.accepted).toBe(2)
    const total7 = d.trend7.reduce((n, p2) => n + p2.submissions, 0)
    expect(total7).toBeGreaterThanOrEqual(4)
  })

  it('复习评分与到期计数正确', () => {
    const now = Date.now()
    // 两条评分都锚定「今天本地 00:00:01」之后：now-1h 在午夜后运行会落到昨天
    // （CI 曾在纽约 00:01 触发跨日假失败）
    const todayEarly = localDayStartMs(toLocalDayKey(now)) + 1000
    db
      .prepare(
        `INSERT INTO review_items (id, target_type, target_id, next_review_at, created_at)
         VALUES ('ri-due', 'problem', 'p1', ?, ?)`
      )
      .run(now - 1000, now)
    db
      .prepare(
        `INSERT INTO review_items (id, target_type, target_id, next_review_at, created_at)
         VALUES ('ri-future', 'knowledge_point', 'kp1', ?, ?)`
      )
      .run(now + DAY, now)
    // 今日复习评分 ×2（均在今天本地日界内）
    db
      .prepare(
        `INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id)
         VALUES ('rh1', 'ri-due', 'good', ?, NULL)`
      )
      .run(now)
    db
      .prepare(
        `INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id)
         VALUES ('rh2', 'ri-due', 'again', ?, NULL)`
      )
      .run(todayEarly)

    const d = stats.getDashboardV2(now)
    expect(d.dueReviewCount).toBe(1)
    expect(d.todayReviews).toBe(2)
    const todayPoint = d.trend7[d.trend7.length - 1]
    expect(todayPoint?.reviews).toBe(2)
  })

  it('错题待复习计数：failed≥2 未掌握', () => {
    const problems = new ProblemRepository(db)
    const p = problems.create(makeProblemInput(), true)
    const p2 = problems.create(makeProblemInput({ title: '已掌握题' }), true)
    db.prepare(
      `INSERT INTO mistake_book (problem_id, failed_count, mastered) VALUES (?, 3, 0)`
    ).run(p.id)
    db.prepare(
      `INSERT INTO mistake_book (problem_id, failed_count, mastered) VALUES (?, 5, 1)`
    ).run(p2.id)
    const d = stats.getDashboardV2(NOW)
    expect(d.mistakeDueCount).toBe(1)
  })
})
