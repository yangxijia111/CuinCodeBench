import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { MistakeRepository } from '../src/main/db/repositories/mistake-repository'
import { PracticeSessionService } from '../src/main/services/practice-session-service'
import { makeProblemInput } from './helpers'
import type { ProblemInput, RandomSessionConfig } from '../src/shared/types'

/**
 * P7 验收：随机练习过滤器与专项训练组题、判题 hook 回报、会话总结（docs/V1_2_ROADMAP.md P7）。
 */

const NOW = 1_800_000_000_000

describe('PracticeSessionService（随机练习 + 专项训练）', () => {
  let db: Database.Database
  let problems: ProblemRepository
  let history: HistoryRepository
  let learning: LearningRepository
  let svc: PracticeSessionService

  function makeProblem(title: string, overrides: Partial<ProblemInput> = {}): ProblemInput {
    return {
      ...makeProblemInput({ title, ...overrides }),
      testCases: [{ stdin: '', expectedStdout: '', timeoutMs: 5000 }]
    }
  }

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    problems = new ProblemRepository(db)
    history = new HistoryRepository(db)
    learning = new LearningRepository(db)
    svc = new PracticeSessionService(db)
    learning.ensureBuiltinPath({
      path: { slug: 'c-basics', title: 'C', description: '' },
      stages: [{ title: 's', description: '', knowledgePoints: [{ name: '数组', description: '', tags: [] }] }],
      builtinProblemMap: {}
    })
  })

  it('随机练习：size 截断 + 难度过滤', () => {
    for (let i = 0; i < 6; i++) {
      problems.create(makeProblem(`easy-${i}`, { difficulty: 'easy' }), true)
    }
    problems.create(makeProblem('hard-1', { difficulty: 'hard' }), true)

    const cfg: RandomSessionConfig = { difficulty: 'easy', size: 4 }
    const s = svc.createRandomSession(cfg, NOW)
    expect(s.items.length).toBe(4)
    expect(s.kind).toBe('random')
    // 全部是 easy 题
    for (const item of s.items) {
      const p = problems.getById(item.problemId)
      expect(p?.difficulty).toBe('easy')
    }
  })

  it('范围过滤：unsolved / mistakes / weak', () => {
    const solved = problems.create(makeProblem('solved'), true)
    const unsolved = problems.create(makeProblem('unsolved'), true)
    history.insertSubmission(
      { problemId: solved.id, language: 'c', code: 'x', status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 1 },
      []
    )
    // unsolved 是错题（失败两次 + mistake recompute）
    for (let i = 0; i < 2; i++) {
      history.insertSubmission(
        { problemId: unsolved.id, language: 'c', code: 'x', status: 'wrong_answer', passedCount: 0, totalCount: 1, durationMs: 1 },
        []
      )
    }
    new MistakeRepository(db).recompute(unsolved.id)

    const unsolvedSession = svc.createRandomSession({ scope: 'unsolved', size: 50 }, NOW)
    expect(unsolvedSession.items.map((i) => i.problemId)).toEqual([unsolved.id])

    const mistakeSession = svc.createRandomSession({ scope: 'mistakes', size: 50 }, NOW)
    expect(mistakeSession.items.map((i) => i.problemId)).toEqual([unsolved.id])

    // weak：知识点 score=0（未算）→ 绑定的题
    const weakProblem = problems.create(makeProblem('weak-p'), true)
    learning.bindProblem(weakProblem.id, 'kp:c-basics:0:0')
    const weakSession = svc.createRandomSession({ scope: 'weak', size: 50 }, NOW)
    expect(weakSession.items.map((i) => i.problemId)).toContain(weakProblem.id)

    void solved
  })

  it('语言过滤：初始代码含该语言的题才入选', () => {
    problems.create(
      makeProblem('only-c', {
        initialCode: { c: 'int main(){}', cpp: '', python: '' }
      }),
      true
    )
    problems.create(
      makeProblem('empty-c', {
        initialCode: { c: '', cpp: 'int main(){}', python: '' }
      }),
      true
    )
    const s = svc.createRandomSession({ language: 'c', size: 50 }, NOW)
    const ids = s.items.map((i) => problems.getById(i.problemId)?.title)
    expect(ids).toContain('only-c')
    expect(ids).not.toContain('empty-c')
  })

  it('专项训练：知识点内组题；知识点不存在报错', () => {
    for (let i = 0; i < 3; i++) {
      const p = problems.create(makeProblem(`kp-p-${i}`), true)
      learning.bindProblem(p.id, 'kp:c-basics:0:0')
    }
    const s = svc.createKpSession('kp:c-basics:0:0', 2, NOW)
    expect(s.kind).toBe('knowledge_point')
    expect(s.knowledgePointId).toBe('kp:c-basics:0:0')
    expect(s.items.length).toBe(2)

    expect(() => svc.createKpSession('kp:missing', 5, NOW)).toThrow(/不存在/)
  })

  it('无条件组题且空结果 → 明确报错', () => {
    expect(() => svc.createRandomSession({ scope: 'mistakes', size: 10 }, NOW)).toThrow(/没有符合条件的题目/)
  })

  it('判题 hook 回报 + 会话总结', () => {
    const p1 = problems.create(makeProblem('a'), true)
    const p2 = problems.create(makeProblem('b'), true)
    const s = svc.sessions.createSession('random', null, { size: 2 }, [p1.id, p2.id], NOW)

    // p1 两次提交（先错后对）→ accepted + 首次 AC 记录
    const bad = history.insertSubmission(
      { problemId: p1.id, language: 'c', code: 'x', status: 'wrong_answer', passedCount: 0, totalCount: 1, durationMs: 1 },
      []
    )
    svc.onSubmission(p1.id, false, bad, NOW)
    const good = history.insertSubmission(
      { problemId: p1.id, language: 'c', code: 'ok', status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 1 },
      []
    )
    svc.onSubmission(p1.id, true, good, NOW)
    // p2 一直没做 → 会话仍 active

    let after = svc.getSession(s.id)
    expect(after?.status).toBe('active')
    expect(after?.items[0]?.status).toBe('accepted')
    expect(after?.items[0]?.attempts).toBe(2)
    expect(after?.items[0]?.firstAcceptedSubmissionId).toBe(good)

    // p2 失败 → 全部有结果 → 会话自动收尾
    svc.onSubmission(p2.id, false, null, NOW)
    after = svc.getSession(s.id)
    expect(after?.status).toBe('finished')

    const sum = svc.summarize(s.id)
    expect(sum).toEqual({ total: 2, answered: 2, accepted: 1, firstAccepted: 1 })
  })
})
