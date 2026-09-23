import { describe, expect, it } from 'vitest'
import {
  nextSchedule,
  effectiveNowForScheduling,
  AGAIN_REPEAT_MS,
  MAX_INTERVAL_DAYS
} from '../src/main/review/review-scheduler'
import { effectiveMasteryStatus } from '../src/main/mastery/mastery-status'
import { openDatabase } from '../src/main/db/connection'
import { ReviewService } from '../src/main/services/review-service'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { MasteryService } from '../src/main/services/mastery-service'
import { makeProblemInput } from './helpers'
import { randomUUID } from 'crypto'

/**
 * 时钟回拨语义测试（v1.3 P8，docs/V1_3_CLOCK_ROLLBACK_SPEC.md §7）。
 * 注入时钟：回拨 1 小时 / 1 天 / 30 天 / 60 天 / 恢复正常。
 * 不变量：nextReviewAt 不早于 lastReviewedAt（I1）、interval 不为负（I2）、
 * 计数不回退（I3）、回拨不制造掌握度衰减（§3）、墙钟展示按真实日期（§4）。
 */

const DAY_MS = 86_400_000

describe('时钟回拨：复习调度（effectiveNow）', () => {
  it('纯函数：effectiveNowForScheduling 取 max(now, lastActivityAt)', () => {
    expect(effectiveNowForScheduling(1_000, 500)).toBe(1_000)
    expect(effectiveNowForScheduling(1_000, 2_000)).toBe(2_000)
    expect(effectiveNowForScheduling(1_000, null)).toBe(1_000)
    expect(effectiveNowForScheduling(1_000, undefined)).toBe(1_000)
  })

  it.each([1 / 24, 1, 30, 60])('回拨 %.4f 天后评分 good：nextReviewAt ≥ lastReviewedAt（I1/I2）', (days) => {
    const lastReviewedAt = 1_000_000_000_000
    const rolledBack = lastReviewedAt - days * DAY_MS
    const current = { intervalDays: 3, successStreak: 2 }
    const next = nextSchedule(current, 'good', effectiveNowForScheduling(rolledBack, lastReviewedAt))
    expect(next.nextReviewAt).toBeGreaterThanOrEqual(lastReviewedAt)
    expect(next.intervalDays).toBeGreaterThanOrEqual(0)
    expect(next.successStreak).toBe(3) // I3：计数不回退
  })

  it('回拨后 again：10 分钟重现锚定在 lastReviewedAt（不早于上次学习）', () => {
    const lastReviewedAt = 1_000_000_000_000
    const rolledBack = lastReviewedAt - DAY_MS
    const next = nextSchedule({ intervalDays: 7, successStreak: 1 }, 'again', effectiveNowForScheduling(rolledBack, lastReviewedAt))
    expect(next.nextReviewAt).toBe(lastReviewedAt + AGAIN_REPEAT_MS)
    expect(next.successStreak).toBe(0)
  })

  it('正常时钟路径行为不变（无回归）', () => {
    const now = 1_000_000_000_000
    const lastReviewedAt = now - 3 * DAY_MS // 正常：now 更晚
    const next = nextSchedule({ intervalDays: 3, successStreak: 2 }, 'good', effectiveNowForScheduling(now, lastReviewedAt))
    // 与未引入 effectiveNow 时逐字段一致
    const direct = nextSchedule({ intervalDays: 3, successStreak: 2 }, 'good', now)
    expect(next).toEqual(direct)
    expect(next.intervalDays).toBe(7)
  })

  it('间隔阶梯封顶不因回拨溢出（MAX_INTERVAL_DAYS）', () => {
    const lastReviewedAt = 1_000_000_000_000
    const next = nextSchedule({ intervalDays: 60, successStreak: 5 }, 'easy', effectiveNowForScheduling(lastReviewedAt - 60 * DAY_MS, lastReviewedAt))
    expect(next.intervalDays).toBeLessThanOrEqual(MAX_INTERVAL_DAYS)
  })
})

describe('时钟回拨：掌握度（elapsed 钳制）', () => {
  it('回拨 60 天（now < lastActivityAt）不衰减 mastered', () => {
    const lastActivityAt = 1_000_000_000_000
    const rolledBack = lastActivityAt - 60 * DAY_MS
    expect(effectiveMasteryStatus('mastered', lastActivityAt, rolledBack)).toBe('mastered')
  })

  it('回拨 30 天（<45 天阈值）不衰减', () => {
    const lastActivityAt = 1_000_000_000_000
    const rolledBack = lastActivityAt - 30 * DAY_MS
    expect(effectiveMasteryStatus('mastered', lastActivityAt, rolledBack)).toBe('mastered')
  })

  it('正常时钟 46 天仍正常衰减（无回归）', () => {
    const now = 1_000_000_000_000
    expect(effectiveMasteryStatus('mastered', now - 46 * DAY_MS, now)).toBe('familiar')
    expect(effectiveMasteryStatus('mastered', now - 44 * DAY_MS, now)).toBe('mastered')
  })

  it('回拨不提升非 mastered 状态、不影响 score 语义', () => {
    const lastActivityAt = 1_000_000_000_000
    expect(effectiveMasteryStatus('weak', lastActivityAt, lastActivityAt - 90 * DAY_MS)).toBe('weak')
    expect(effectiveMasteryStatus('familiar', lastActivityAt, lastActivityAt - 90 * DAY_MS)).toBe('familiar')
  })
})

describe('时钟回拨：ReviewService 端到端（注入时钟）', () => {
  interface Fixture {
    svc: ReviewService
    problemId: string
    kpId: string
    db: ReturnType<typeof openDatabase>
  }

  function buildFixture(): Fixture {
    const db = openDatabase({ file: ':memory:' })
    const problems = new ProblemRepository(db)
    const learning = new LearningRepository(db)
    const p = problems.create(makeProblemInput(), false)
    const kpId = `kp-${randomUUID()}`
    db.prepare(
      `INSERT INTO learning_paths (id, slug, title, description, is_builtin, sort_order) VALUES (?, ?, ?, ?, 0, 0)`
    ).run(`lp-${randomUUID()}`, 'probe', '探针', '')
    const pathId = (db.prepare('SELECT id FROM learning_paths WHERE slug = ?').get('probe') as { id: string }).id
    db.prepare(
      `INSERT INTO learning_stages (id, path_id, title, description, sort_order) VALUES (?, ?, ?, '', 0)`
    ).run(`st-${randomUUID()}`, pathId, '阶段')
    const stageId = (db.prepare('SELECT id FROM learning_stages WHERE path_id = ?').get(pathId) as { id: string }).id
    db.prepare(
      `INSERT INTO knowledge_points (id, stage_id, name, description, sort_order, tags) VALUES (?, ?, ?, '', 0, '[]')`
    ).run(kpId, stageId, '探针知识点')
    learning.bindProblem(p.id, kpId)
    const svc = new ReviewService(db)
    return { svc, problemId: p.id, kpId, db }
  }

  /** 直接创建 problem 复习项（绕过错题本阈值；onSubmission 建项需失败≥2 次） */
  function seedReviewItem(fx: Fixture, t0: number): string {
    fx.svc.reviews.create('problem', fx.problemId, t0 + DAY_MS, t0)
    return fx.svc.reviews.getByTarget('problem', fx.problemId)!.id
  }

  it('回拨 30 天后 finishSession：nextReviewAt 不早于 lastReviewedAt，计数推进正常', () => {
    const fx = buildFixture()
    const t0 = 1_700_000_000_000
    const reviewItemId = seedReviewItem(fx, t0)
    const item = fx.svc.reviews.getById(reviewItemId)
    expect(item!.nextReviewAt).toBe(t0 + DAY_MS)

    // 组题（到期）→ 系统时钟回拨 30 天后 AC 提交 → 自动收尾按提交时刻评分
    fx.svc.startSession(10, t0 + 2 * DAY_MS)
    const rolledBack = t0 + 2 * DAY_MS - 30 * DAY_MS
    fx.svc.onSubmission(fx.problemId, true, null, rolledBack)

    const after = fx.svc.reviews.getById(reviewItemId)
    expect(after).not.toBeNull()
    // 锚点：lastReviewedAt 为空 → createdAt（t0）≥ 回拨时刻 → nextReviewAt 不早于 createdAt
    expect(after!.nextReviewAt).toBeGreaterThanOrEqual(t0) // I1
    expect(after!.nextReviewAt).toBeGreaterThanOrEqual(after!.lastReviewedAt ?? 0)
    expect(after!.reviewCount).toBe(1) // I3
    fx.db.close()
  })

  it('回拨 → 评分 → 时钟恢复正常 → 再次评分：时间线连续不双计', () => {
    const fx = buildFixture()
    const t0 = 1_700_000_000_000
    seedReviewItem(fx, t0)
    // 第一次评分（正常时钟，t0+1d 到期后提交 AC）
    fx.svc.startSession(10, t0 + DAY_MS + 3_600_000)
    fx.svc.onSubmission(fx.problemId, true, null, t0 + DAY_MS + 3_600_000)
    const item1 = fx.svc.reviews.getByTarget('problem', fx.problemId)!
    expect(item1.reviewCount).toBe(1)
    const afterFirst = item1.nextReviewAt

    // 第二轮：回拨 1 小时后 AC 提交（首次 good → nextReviewAt = t0+1d+1d = t0+2d，已到期）
    fx.svc.startSession(10, t0 + 2 * DAY_MS + 3_600_000)
    fx.svc.onSubmission(fx.problemId, true, null, t0 + 2 * DAY_MS + 3_600_000 - 3_600_000)
    const item2 = fx.svc.reviews.getById(item1.id)!
    expect(item2.reviewCount).toBe(2)
    expect(item2.nextReviewAt).toBeGreaterThanOrEqual(item2.lastReviewedAt ?? 0) // I1

    // 时钟恢复后评分：调度继续前进
    fx.svc.startSession(10, item2.nextReviewAt + 3_600_000)
    fx.svc.onSubmission(fx.problemId, true, null, item2.nextReviewAt + 2 * 3_600_000)
    const item3 = fx.svc.reviews.getById(item1.id)!
    expect(item3.reviewCount).toBe(3)
    expect(item3.nextReviewAt).toBeGreaterThan(afterFirst)
    fx.db.close()
  })

  it('again + 回拨组合：当日重现时间不早于上次学习', () => {
    const fx = buildFixture()
    const t0 = 1_700_000_000_000
    seedReviewItem(fx, t0)
    fx.svc.startSession(10, t0 + DAY_MS)
    // 回拨 1 小时后失败提交 → again（自动收尾）
    fx.svc.onSubmission(fx.problemId, false, null, t0 + DAY_MS - 60 * 60_000)
    const item = fx.svc.reviews.getByTarget('problem', fx.problemId)!
    expect(item.nextReviewAt).toBeGreaterThanOrEqual(item.lastReviewedAt ?? 0)
    expect(item.successStreak).toBe(0)
    expect(item.reviewCount).toBe(1)
    fx.db.close()
  })

  it('回拨期间 due 判定按墙钟：未来项不因回拨批量到期（I4）', () => {
    const fx = buildFixture()
    const t0 = 1_700_000_000_000
    seedReviewItem(fx, t0)
    // 回拨 12 小时：复习项（t0+1d 到期）不应出现在到期清单
    const overview = fx.svc.todayOverview(t0 + 12 * 3600_000)
    expect(overview.dueCount).toBe(0)
    fx.db.close()
  })
})
