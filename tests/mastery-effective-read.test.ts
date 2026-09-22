import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { MasteryRepository } from '../src/main/db/repositories/mastery-repository'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { ReviewRepository } from '../src/main/db/repositories/review-repository'
import { MasteryService, computeMastery } from '../src/main/services/mastery-service'
import { effectiveMasteryStatus } from '../src/main/mastery/mastery-status'
import { StatsRepository } from '../src/main/db/repositories/stats-repository'
import { makeProblemInput } from './helpers'

/**
 * v1.2.1 P1-B 回归：掌握度时间衰减闭环（effective on read）。
 * 修复前缺陷：45 天衰减只在 computeMastery（写路径重算）里发生，mastery 是持久化
 * 缓存——用户 45 天不打开应用，重新打开后 Dashboard/列表读到的仍是 mastered。
 */

const DAY = 86_400_000
const KP_ID = 'kp:c-basics:io'

function setup(): {
  db: Database.Database
  problems: ProblemRepository
  learning: LearningRepository
  masteryRepo: MasteryRepository
  svc: MasteryService
} {
  const db = openDatabase({ file: ':memory:' })
  const learning = new LearningRepository(db)
  learning.ensureBuiltinPath({
    seedVersion: 2,
    path: { slug: 'c-basics', title: 'C', description: '' },
    stages: [
      {
        slug: 'getting-started',
        title: '起步',
        description: '',
        knowledgePoints: [{ slug: 'io', name: '输入输出', description: '', tags: [] }]
      }
    ],
    builtinProblemMap: {}
  })
  return {
    db,
    problems: new ProblemRepository(db),
    learning,
    masteryRepo: new MasteryRepository(db),
    svc: new MasteryService({ mastery: new MasteryRepository(db), learning })
  }
}

describe('effectiveMasteryStatus 纯函数（确定性）', () => {
  const t = 1_700_000_000_000
  it('mastered + 超 45 天无活动 → familiar（严格大于；恰好 45 天未超期）', () => {
    expect(effectiveMasteryStatus('mastered', t - 45 * DAY - 1, t)).toBe('familiar')
    expect(effectiveMasteryStatus('mastered', t - 45 * DAY, t)).toBe('mastered') // 边界：恰好 45 天不衰减（>）
  })
  it('mastered + 恰好未超 45 天 → 保持 mastered', () => {
    expect(effectiveMasteryStatus('mastered', t - 45 * DAY + 1, t)).toBe('mastered')
    expect(effectiveMasteryStatus('mastered', t, t)).toBe('mastered')
  })
  it('非 mastered 状态不衰减；无活动记录（null）不衰减', () => {
    expect(effectiveMasteryStatus('familiar', t - 300 * DAY, t)).toBe('familiar')
    expect(effectiveMasteryStatus('learning', t - 300 * DAY, t)).toBe('learning')
    expect(effectiveMasteryStatus('mastered', null, t)).toBe('mastered')
  })
  it('确定性：同输入同输出', () => {
    for (let i = 0; i < 5; i++) {
      expect(effectiveMasteryStatus('mastered', t - 46 * DAY, t + i)).toBe('familiar')
    }
  })
})

describe('MasteryService.list / getEffective（effective on read，注入时钟）', () => {
  let ctx: ReturnType<typeof setup>
  const T0 = 1_700_000_000_000

  beforeEach(() => {
    ctx = setup()
  })

  /** 灌一个 mastered 知识点（3 题全 AC，最后活动时刻 = activityAt） */
  function seedMastered(activityAt: number): void {
    const history = new HistoryRepository(ctx.db)
    for (let i = 0; i < 3; i++) {
      const p = ctx.problems.create(makeProblemInput({ title: `题${i}` }), true)
      ctx.learning.bindProblem(p.id, KP_ID)
      history.insertSubmission(
        { problemId: p.id, language: 'c', code: 'x', status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 1 },
        []
      )
    }
    // 修正提交时间到 activityAt（insertSubmission 用 Date.now()）
    ctx.db.prepare(`UPDATE submissions SET created_at = ?`).run(activityAt)
    ctx.svc.recalc(KP_ID, activityAt)
    expect(ctx.masteryRepo.get(KP_ID)?.status).toBe('mastered')
  }

  it('45 天后重新打开应用：读路径显示 familiar，库内仍是 mastered（不写库）', () => {
    seedMastered(T0)
    const later = T0 + 46 * DAY

    // 读侧（effective on read）
    const list = ctx.svc.list(later)
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('familiar')
    expect(list[0]?.score).toBe(ctx.masteryRepo.get(KP_ID)?.score) // 分数不变
    expect(ctx.svc.getEffective(KP_ID, later)?.status).toBe('familiar')

    // 库内物化状态未被读路径改写
    expect(ctx.masteryRepo.get(KP_ID)?.status).toBe('mastered')
    expect(ctx.masteryRepo.get(KP_ID)?.updatedAt).toBe(T0)
  })

  it('未超期：读路径与库内一致（mastered）', () => {
    seedMastered(T0)
    expect(ctx.svc.list(T0 + 30 * DAY)[0]?.status).toBe('mastered')
    expect(ctx.svc.getEffective(KP_ID, T0 + 44 * DAY)?.status).toBe('mastered')
  })

  it('读侧与写侧（computeMastery）规则一致：同输入同结果', () => {
    seedMastered(T0)
    const later = T0 + 46 * DAY
    const writeSide = computeMastery({
      samples: [{ status: 'accepted' }],
      recent: [{ status: 'accepted' }],
      coverage: { total: 3, covered: 3 },
      reviews: [],
      lastActivityAt: T0,
      now: later
    })
    // 写侧重算在 later 时刻会因 stale 降级；读侧对同一物化行给出相同状态
    expect(writeSide.status).toBe('familiar')
    expect(ctx.svc.getEffective(KP_ID, later)?.status).toBe(writeSide.status)
  })

  it('复习活动会刷新 lastActivity：复习后不衰减', () => {
    seedMastered(T0)
    const reviewAt = T0 + 40 * DAY
    const reviews = new ReviewRepository(ctx.db)
    const item = reviews.create('knowledge_point', KP_ID, reviewAt, reviewAt)
    reviews.applyGrade(item.id, 'good', { intervalDays: 30, successStreak: 1, nextReviewAt: reviewAt + 30 * DAY }, reviewAt, null)
    ctx.svc.recalc(KP_ID, reviewAt)

    // 距复习 6 天（距提交 46 天）→ 以最后活动（复习）为准，不衰减
    expect(ctx.svc.getEffective(KP_ID, reviewAt + 6 * DAY)?.status).toBe('mastered')
  })

  it('Dashboard masteryList 同样走 effective（读路径闭环）', () => {
    seedMastered(T0)
    const stats = new StatsRepository(ctx.db)
    const dash = stats.getDashboardV2(T0 + 46 * DAY)
    expect(dash.masteryList[0]?.status).toBe('familiar')
    const dashFresh = stats.getDashboardV2(T0 + 10 * DAY)
    expect(dashFresh.masteryList[0]?.status).toBe('mastered')
  })
})
