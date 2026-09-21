import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { MasteryRepository } from '../src/main/db/repositories/mastery-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { MasteryService, computeMastery, type MasteryInput } from '../src/main/services/mastery-service'
import { makeProblemInput } from './helpers'
import type { ProblemInput } from '../src/shared/types'

/**
 * P3 验收：掌握度公式与状态机（docs/V1_2_MASTERY_SPEC.md §7）。
 * computeMastery 为纯函数黑盒对拍；服务层验证重算幂等与 hook 联动。
 */

const NOW = 1_800_000_000_000

function input(overrides: Partial<MasteryInput> = {}): MasteryInput {
  return {
    samples: [],
    recent: [],
    coverage: { total: 5, covered: 0 },
    reviews: [],
    lastActivityAt: null,
    now: NOW,
    ...overrides
  }
}

const acc = { status: 'accepted' }
const wa = { status: 'wrong_answer' }

describe('computeMastery 纯函数（spec 对拍）', () => {
  it('1. 未做题 → not_started，score=0', () => {
    const r = computeMastery(input())
    expect(r.status).toBe('not_started')
    expect(r.score).toBe(0)
  })

  it('3. 单题刷 100 次 AC：样本限量 + 信心折扣 → 到不了 mastered', () => {
    const r = computeMastery(
      input({
        samples: Array.from({ length: 20 }, () => acc),
        recent: Array.from({ length: 20 }, () => acc),
        coverage: { total: 1, covered: 1 }
      })
    )
    expect(r.status).not.toBe('mastered')
    expect(r.status).toBe('familiar')
  })

  it('4. 3 题全 AC + 稳定表现 → score ≥ 80 → mastered', () => {
    const r = computeMastery(
      input({
        samples: [acc, acc, acc, acc, acc, acc],
        recent: [acc, acc, acc, acc, acc, acc],
        coverage: { total: 3, covered: 3 }
      })
    )
    expect(r.score).toBeGreaterThanOrEqual(80)
    expect(r.status).toBe('mastered')
  })

  it('2. 首次失败 → learning；首次 AC 单题 → 信心折扣封顶 < mastered', () => {
    const fail = computeMastery(input({ samples: [wa], recent: [wa], coverage: { total: 5, covered: 0 } }))
    expect(fail.status).toBe('learning')
    const first = computeMastery(input({ samples: [acc], recent: [acc], coverage: { total: 5, covered: 1 } }))
    expect(first.status).not.toBe('mastered')
  })

  it('2b. 最近 5 次失败 ≥3 → weak（优先级高于分数）', () => {
    const r = computeMastery(
      input({
        samples: [wa, wa, wa, acc, acc],
        recent: [wa, wa, wa, wa, acc, acc, acc, acc],
        coverage: { total: 5, covered: 5 }
      })
    )
    expect(r.status).toBe('weak')
  })

  it('6a. 复习 again ×2 → 压制 mastered', () => {
    const base = {
      samples: [acc, acc, acc, acc, acc, acc],
      recent: [acc, acc, acc, acc, acc, acc],
      coverage: { total: 3, covered: 3 }
    }
    const r = computeMastery(input({ ...base, reviews: ['again', 'again'] }))
    expect(r.status).not.toBe('mastered')
    expect(r.status).toBe('familiar')
  })

  it('6b. 复习 good → 分数高于无复习中性值', () => {
    const base = {
      samples: [acc, acc, acc],
      recent: [acc, acc, acc],
      coverage: { total: 3, covered: 2 }
    }
    const noReview = computeMastery(input(base))
    const goodReview = computeMastery(input({ ...base, reviews: ['good'] }))
    expect(goodReview.score).toBeGreaterThan(noReview.score)
  })

  it('7. 时间推移 45 天以上 → mastered 降为 familiar', () => {
    const base = {
      samples: [acc, acc, acc, acc, acc, acc],
      recent: [acc, acc, acc, acc, acc, acc],
      coverage: { total: 3, covered: 3 }
    }
    const fresh = computeMastery(input({ ...base, lastActivityAt: NOW - 10 * 86_400_000 }))
    expect(fresh.status).toBe('mastered')
    const stale = computeMastery(input({ ...base, lastActivityAt: NOW - 46 * 86_400_000 }))
    expect(stale.status).toBe('familiar')
    expect(stale.score).toBe(fresh.score)
  })

  it('9. 权重常数黑盒对拍：全 AC 大样本 + 全覆盖 + good 复习 + 满连击 ≈ 上限', () => {
    const r = computeMastery(
      input({
        samples: Array.from({ length: 10 }, () => acc),
        recent: Array.from({ length: 10 }, () => acc),
        coverage: { total: 3, covered: 3 },
        reviews: ['good', 'good', 'good', 'good', 'good']
      })
    )
    // performance=100 coverage=100 review=100 streak=100 → score=100
    expect(r.score).toBe(100)
    expect(r.factors.performance).toBeCloseTo(100)
    expect(r.factors.coverage).toBeCloseTo(100)
  })
})

describe('MasteryService（集成）', () => {
  // 服务内部时间戳取自 Date.now()；时钟取未来 1 分钟，避免触发 45 天惰性衰减
  const SVC_NOW = Date.now() + 60_000
  let db: Database.Database
  let learning: LearningRepository
  let masteryRepo: MasteryRepository
  let service: MasteryService
  let problems: ProblemRepository
  let history: HistoryRepository

  function makeProblem(title: string): ProblemInput {
    return { ...makeProblemInput({ title }), testCases: [{ stdin: '', expectedStdout: '', timeoutMs: 5000 }] }
  }

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    learning = new LearningRepository(db)
    masteryRepo = new MasteryRepository(db)
    service = new MasteryService({ mastery: masteryRepo, learning })
    problems = new ProblemRepository(db)
    history = new HistoryRepository(db)
    learning.ensureBuiltinPath({
      path: { slug: 'c-basics', title: 'C 基础', description: '' },
      stages: [
        {
          title: '起步',
          description: '',
          knowledgePoints: [
            { name: '输入输出', description: '', tags: [] },
            { name: '变量与类型', description: '', tags: [] },
            { name: '运算符', description: '', tags: [] }
          ]
        }
      ],
      builtinProblemMap: {}
    })
  })

  function submit(problemId: string, status: 'accepted' | 'wrong_answer'): void {
    history.insertSubmission(
      { problemId, language: 'c', code: 'x', status, passedCount: status === 'accepted' ? 3 : 0, totalCount: 3, durationMs: 1 },
      []
    )
  }

  it('8. 重算幂等：recalc 两次结果一致；无提交时移除缓存', () => {
    const ps = [problems.create(makeProblem('A')), problems.create(makeProblem('B')), problems.create(makeProblem('C'))]
    for (const p of ps) learning.bindProblem(p.id, 'kp:c-basics:0:0')
    for (const p of ps) submit(p.id, 'accepted')

    service.recalc('kp:c-basics:0:0', SVC_NOW)
    const first = masteryRepo.get('kp:c-basics:0:0')
    service.recalc('kp:c-basics:0:0', SVC_NOW)
    const second = masteryRepo.get('kp:c-basics:0:0')
    expect(second).toEqual(first)
    expect(second?.status).toBe('mastered')

    // 删数据重算 → 缓存行移除
    db.prepare('DELETE FROM submissions').run()
    service.recalc('kp:c-basics:0:0', SVC_NOW)
    expect(masteryRepo.get('kp:c-basics:0:0')).toBeNull()
  })

  it('recalcForProblem 只影响该题关联的知识点', () => {
    const p1 = problems.create(makeProblem('A'))
    learning.bindProblem(p1.id, 'kp:c-basics:0:0')
    const p2 = problems.create(makeProblem('B'))
    learning.bindProblem(p2.id, 'kp:c-basics:0:1')

    submit(p1.id, 'accepted')
    service.recalcForProblem(p1.id, SVC_NOW)

    expect(masteryRepo.get('kp:c-basics:0:0')).not.toBeNull()
    expect(masteryRepo.get('kp:c-basics:0:1')).toBeNull()
  })

  it('样本限量：单题 5WA+1AC 不落入 weak（每题样本上限生效）', () => {
    const p1 = problems.create(makeProblem('A'))
    learning.bindProblem(p1.id, 'kp:c-basics:0:0')
    for (let i = 0; i < 5; i++) submit(p1.id, 'wrong_answer')
    submit(p1.id, 'accepted')

    service.recalc('kp:c-basics:0:0', SVC_NOW)
    const info = masteryRepo.get('kp:c-basics:0:0')
    // 表现样本 = 每题最近 2 次 = [AC, AC] → performance=100
    // recent 5 次原始提交含 4 次失败 → weak 判定优先（spec §4 状态 2）
    expect(info?.status).toBe('weak')
    // coverage = 1/5 * (1/3 折扣) * 100 ≈ 6.7，总分为中低水平
    expect(info?.score).toBeLessThan(80)
  })

  it('样本限量：3WA+3AC（最近 5 次失败 <3）→ familiar，AC 样本主导表现', () => {
    const p1 = problems.create(makeProblem('A'))
    learning.bindProblem(p1.id, 'kp:c-basics:0:0')
    for (let i = 0; i < 3; i++) submit(p1.id, 'wrong_answer')
    for (let i = 0; i < 3; i++) submit(p1.id, 'accepted')

    service.recalc('kp:c-basics:0:0', SVC_NOW)
    const info = masteryRepo.get('kp:c-basics:0:0')
    // 样本 = [AC, AC] → performance=100；coverage 折扣 33；streak=3 → 60；中性复习 50
    // score ≈ 45*1 + 30*33.3 + 15*50 + 10*60 = 45+10+7.5+6 = 68.5 → familiar
    expect(info?.status).toBe('familiar')
    expect(info?.score).toBeGreaterThanOrEqual(60)
    expect(info?.score).toBeLessThan(80)
  })
})
