import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import {
  EASY_LADDER,
  GOOD_LADDER,
  AGAIN_REPEAT_MS,
  MAX_INTERVAL_DAYS,
  nextSchedule
} from '../src/main/review/review-scheduler'
import { ReviewService } from '../src/main/services/review-service'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { MistakeRepository } from '../src/main/db/repositories/mistake-repository'
import { makeProblemInput } from './helpers'
import type { ProblemInput } from '../src/shared/types'

/**
 * P4 验收：间隔复习调度与 Review Session（docs/V1_2_REVIEW_SPEC.md §8）。
 */

const NOW = 1_800_000_000_000
const DAY = 86_400_000

describe('nextSchedule 阶梯表对拍（spec §8.1）', () => {
  it('good/easy 全阶梯（streak 0→5 含封顶）', () => {
    let s = { intervalDays: 0, successStreak: 0 }
    const goodSeq: number[] = []
    const easySeq: number[] = []
    for (let i = 0; i < 8; i++) {
      const g = nextSchedule(s, 'good', NOW)
      expect(g.nextReviewAt).toBe(NOW + g.intervalDays * DAY)
      goodSeq.push(g.intervalDays)
      s = g
      const e = nextSchedule({ intervalDays: 0, successStreak: i }, 'easy', NOW)
      easySeq.push(e.intervalDays)
    }
    expect(goodSeq.slice(0, 6)).toEqual([...GOOD_LADDER])
    expect(goodSeq[5]).toBe(60)
    expect(goodSeq[6]).toBe(60)
    expect(easySeq[0]).toBe(EASY_LADDER[0])
    expect(easySeq[5]).toBe(EASY_LADDER[5])
  })

  it('2. again：interval=0、10 分钟后到期、streak 清零', () => {
    const s = nextSchedule({ intervalDays: 14, successStreak: 3 }, 'again', NOW)
    expect(s.intervalDays).toBe(0)
    expect(s.successStreak).toBe(0)
    expect(s.nextReviewAt).toBe(NOW + AGAIN_REPEAT_MS)
  })

  it('3. hard：0→1 天；10 天 → 12 天（round×1.2）；streak 不变', () => {
    const fromZero = nextSchedule({ intervalDays: 0, successStreak: 2 }, 'hard', NOW)
    expect(fromZero.intervalDays).toBe(1)
    const fromTen = nextSchedule({ intervalDays: 10, successStreak: 2 }, 'hard', NOW)
    expect(fromTen.intervalDays).toBe(12)
    expect(fromTen.successStreak).toBe(2)
    expect(fromTen.nextReviewAt).toBe(NOW + 12 * DAY)
  })

  it('4. 60 天上限不可突破（easy 满连击后仍为 60）', () => {
    const s = nextSchedule({ intervalDays: 60, successStreak: 5 }, 'easy', NOW)
    expect(s.intervalDays).toBeLessThanOrEqual(MAX_INTERVAL_DAYS)
    expect(s.intervalDays).toBe(60)
  })

  it('5. 再次 good 从 again 重置后回到阶梯起点（1 天）', () => {
    const reset = nextSchedule({ intervalDays: 30, successStreak: 4 }, 'again', NOW)
    const again = nextSchedule(reset, 'good', NOW)
    expect(again.intervalDays).toBe(1)
    expect(again.successStreak).toBe(1)
  })
})

describe('ReviewService（集成，注入时钟）', () => {
  let db: Database.Database
  let svc: ReviewService
  let problems: ProblemRepository
  let history: HistoryRepository
  let learning: LearningRepository

  function makeProblem(title: string): ProblemInput {
    return { ...makeProblemInput({ title }), testCases: [{ stdin: '', expectedStdout: '', timeoutMs: 5000 }] }
  }

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    svc = new ReviewService(db)
    problems = new ProblemRepository(db)
    history = new HistoryRepository(db)
    learning = new LearningRepository(db)
    learning.ensureBuiltinPath({
      path: { slug: 'c-basics', title: 'C', description: '' },
      stages: [
        {
          title: 's',
          description: '',
          knowledgePoints: [
            { name: 'kpA', description: '', tags: [] },
            { name: 'kpB', description: '', tags: [] }
          ]
        }
      ],
      builtinProblemMap: {}
    })
  })

  function makeMistake(problemId: string, now: number): void {
    // 失败两次 → 进入错题本（mistake threshold = 2）→ 模拟 judge hook
    for (let i = 0; i < 2; i++) {
      const sid = history.insertSubmission(
        { problemId, language: 'c', code: 'x', status: 'wrong_answer', passedCount: 0, totalCount: 1, durationMs: 1 },
        []
      )
      void sid
    }
    new MistakeRepository(db).recompute(problemId)
    svc.onSubmission(problemId, false, null, now)
  }

  it('6. 错题入选即到期；标记掌握删除；再次失败重建', () => {
    const p = problems.create(makeProblem('A'))
    makeMistake(p.id, NOW)

    const item = svc.reviews.getByTarget('problem', p.id)
    expect(item).not.toBeNull()
    expect(item!.nextReviewAt).toBeLessThanOrEqual(NOW)

    svc.onMistakeMastered(p.id)
    expect(svc.reviews.getByTarget('problem', p.id)).toBeNull()

    // 再次失败重建（新一次错题聚合：recompute 模拟 + hook）
    makeMistake(p.id, NOW + DAY)
    expect(svc.reviews.getByTarget('problem', p.id)).not.toBeNull()
  })

  it('知识点首次提交建项且次日到期；重复提交不重复建', () => {
    const p = problems.create(makeProblem('A'))
    learning.bindProblem(p.id, 'kp:c-basics:0:0')
    svc.onSubmission(p.id, true, 'sid', NOW)

    const item = svc.reviews.getByTarget('knowledge_point', 'kp:c-basics:0:0')
    expect(item).not.toBeNull()
    expect(item!.nextReviewAt).toBe(NOW + DAY)

    svc.onSubmission(p.id, true, 'sid2', NOW + 1000)
    const again = svc.reviews.getByTarget('knowledge_point', 'kp:c-basics:0:0')
    expect(again!.id).toBe(item!.id)
  })

  it('7. 组题：错题优先、知识点展开、会话去重、数量截断', () => {
    // 两个错题 + 两个知识点（各 2 题）
    const m1 = problems.create(makeProblem('M1'))
    const m2 = problems.create(makeProblem('M2'))
    makeMistake(m1.id, NOW)
    makeMistake(m2.id, NOW)

    for (const [ki, name] of [
      [0, 'a'],
      [1, 'b']
    ] as const) {
      const kpId = `kp:c-basics:0:${ki}`
      for (let j = 0; j < 2; j++) {
        const p = problems.create(makeProblem(`KP${name}-${j}`))
        learning.bindProblem(p.id, kpId)
        svc.onSubmission(p.id, true, null, NOW)
      }
    }

    const { session, created } = svc.startSession(3, NOW + DAY)
    expect(created).toBe(true)
    expect(session).not.toBeNull()
    expect(session!.items.length).toBe(3)
    const ids = session!.items.map((i) => i.problemId)
    expect(new Set(ids).size).toBe(ids.length)
    // 错题最优先：两个错题都入选
    expect(ids).toContain(m1.id)
    expect(ids).toContain(m2.id)
  })

  it('8. 完整 session 流：作答 → 自动等级 → 调度推进 → 当日不再出现', () => {
    const p = problems.create(makeProblem('A'))
    makeMistake(p.id, NOW)

    const { session } = svc.startSession(5, NOW + 1000)
    expect(session).not.toBeNull()
    const sid = session!.id

    // 模拟判题 hook：该题 AC（单题会话 → hook 自动收尾并按默认映射评分推进）
    const accepted = history.insertSubmission(
      { problemId: p.id, language: 'c', code: 'ok', status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 1 },
      []
    )
    svc.onSubmission(p.id, true, accepted, NOW + 2000)

    const updated = svc.sessions.getSession(sid)
    expect(updated!.items[0].status).toBe('accepted')
    expect(updated!.status).toBe('finished')

    // 错题项调度推进：good 首次 → 1 天后
    const item = svc.reviews.getByTarget('problem', p.id)
    expect(item!.intervalDays).toBe(1)
    expect(item!.successStreak).toBe(1)
    expect(item!.nextReviewAt).toBe(NOW + 2000 + DAY)

    // 当日不再到期
    expect(svc.reviews.listDue(NOW + 2000).filter((i) => i.targetId === p.id)).toHaveLength(0)
  })

  it('review history 追加可查', () => {
    const p = problems.create(makeProblem('A'))
    makeMistake(p.id, NOW)
    svc.startSession(5, NOW + 1000)
    // 模拟作答通过（judge hook 报告）→ 会话自动收尾评分
    svc.onSubmission(p.id, true, null, NOW + 1500)
    // hook 自动收尾评分后，手动 finishSession 不应重复评分（幂等）

    const item = svc.reviews.getByTarget('problem', p.id)
    const hist = svc.reviews.listHistory(item!.id)
    expect(hist).toHaveLength(1)
    expect(hist[0].result).toBe('good')
    expect(hist[0].submissionId).toBeNull()
  })

  it('复用未完成会话：再次 startSession 不重复组题', () => {
    const p = problems.create(makeProblem('A'))
    makeMistake(p.id, NOW)
    const first = svc.startSession(5, NOW + 1000)
    const second = svc.startSession(5, NOW + 2000)
    expect(second.created).toBe(false)
    expect(second.session!.id).toBe(first.session!.id)
  })
})
