import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { LearningService } from '../src/main/services/learning-service'
import { makeProblemInput } from './helpers'
import type { ProblemInput } from '../src/shared/types'

/**
 * P2 验收：学习路线进度聚合 / 知识点题目明细 / 绑定级联（docs/V1_2_ROADMAP.md P2）。
 */

const SEED = {
  path: { slug: 'c-basics', title: 'C 基础', description: '' },
  stages: [
    {
      title: '起步',
      description: '',
      knowledgePoints: [
        { name: '输入输出', description: '', tags: ['io'] },
        { name: '变量与类型', description: '', tags: ['变量'] }
      ]
    },
    {
      title: '循环',
      description: '',
      knowledgePoints: [{ name: 'for 循环', description: '', tags: ['for'] }]
    }
  ],
  builtinProblemMap: {}
}

function makeProblem(title: string): ProblemInput {
  return { ...makeProblemInput({ title }), testCases: [{ stdin: '', expectedStdout: '', timeoutMs: 5000 }] }
}

describe('学习路线（LearningService）', () => {
  let db: Database.Database
  let repo: LearningRepository
  let problems: ProblemRepository
  let history: HistoryRepository
  let service: LearningService

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    repo = new LearningRepository(db)
    problems = new ProblemRepository(db)
    history = new HistoryRepository(db)
    service = new LearningService(db)
    repo.ensureBuiltinPath(SEED)
  })

  function submitAccepted(problemId: string): void {
    history.insertSubmission(
      { problemId, language: 'c', code: 'x', status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 1 },
      []
    )
  }

  it('空路线：知识点题目数为 0，进度 0%', () => {
    const progress = service.getPathProgress('lp:c-basics')
    expect(progress.stages).toHaveLength(2)
    expect(progress.totalProblems).toBe(0)
    expect(progress.stages[0]?.knowledgePoints[0]?.totalProblems).toBe(0)
    expect(progress.stages[0]?.knowledgePoints[0]?.mastery).toBeNull()
  })

  it('绑定题目后进度聚合正确；AC 后完成度提升', () => {
    const p1 = problems.create(makeProblem('题目一'), true)
    const p2 = problems.create(makeProblem('题目二'), true)
    repo.bindProblem(p1.id, 'kp:c-basics:0:0')
    repo.bindProblem(p2.id, 'kp:c-basics:0:0')
    repo.bindProblem(p1.id, 'kp:c-basics:1:0')

    let progress = service.getPathProgress('lp:c-basics')
    expect(progress.totalProblems).toBe(3)
    expect(progress.stages[0]?.knowledgePoints[0]).toMatchObject({ totalProblems: 2, acceptedProblems: 0 })

    submitAccepted(p1.id)
    progress = service.getPathProgress('lp:c-basics')
    // p1 AC：知识点「输入输出」与「for 循环」各 +1
    expect(progress.stages[0]?.knowledgePoints[0]?.acceptedProblems).toBe(1)
    expect(progress.stages[1]?.knowledgePoints[0]?.acceptedProblems).toBe(1)
    expect(progress.acceptedProblems).toBe(2)
  })

  it('listKpProblems 返回通过状态与尝试次数；未绑定知识点报错', () => {
    const p1 = problems.create(makeProblem('题目一'), true)
    repo.bindProblem(p1.id, 'kp:c-basics:0:0')
    history.insertSubmission(
      { problemId: p1.id, language: 'c', code: 'x', status: 'wrong_answer', passedCount: 0, totalCount: 1, durationMs: 1 },
      []
    )
    submitAccepted(p1.id)

    const list = service.listKpProblems('kp:c-basics:0:0')
    expect(list).toHaveLength(1)
    expect(list[0]?.accepted).toBe(true)
    expect(list[0]?.attempts).toBe(2)

    expect(() => service.listKpProblems('kp:missing')).toThrow(/不存在/)
  })

  it('bindProblem 校验知识点存在性并幂等', () => {
    const p1 = problems.create(makeProblem('题目一'), true)
    expect(() => service.bindProblem(p1.id, ['kp:missing'])).toThrow(/不存在/)
    service.bindProblem(p1.id, ['kp:c-basics:0:0'])
    service.bindProblem(p1.id, ['kp:c-basics:0:0'])
    expect(repo.knowledgePointIdsForProblem(p1.id)).toHaveLength(1)
  })

  it('解绑后进度回落', () => {
    const p1 = problems.create(makeProblem('题目一'), true)
    repo.bindProblem(p1.id, 'kp:c-basics:0:0')
    service.unbindProblem(p1.id, 'kp:c-basics:0:0')
    const progress = service.getPathProgress('lp:c-basics')
    expect(progress.totalProblems).toBe(0)
  })

  it('listPaths 汇总全部路线', () => {
    const p1 = problems.create(makeProblem('题目一'), true)
    repo.bindProblem(p1.id, 'kp:c-basics:0:0')
    const paths = service.listPaths()
    expect(paths).toHaveLength(1)
    expect(paths[0]?.slug).toBe('c-basics')
    expect(paths[0]?.totalProblems).toBe(1)
  })
})

describe('P8 搜索增强（problem-repository.list）', () => {
  let db: Database.Database
  let repo: LearningRepository
  let problems: ProblemRepository

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    repo = new LearningRepository(db)
    problems = new ProblemRepository(db)
    repo.ensureBuiltinPath(SEED)
  })

  it('关键词覆盖标签与知识点名称；knowledgePointId 与难度组合', () => {
    const a = problems.create({ ...makeProblem('求和'), tags: ['前缀和'] }, true)
    repo.bindProblem(a.id, 'kp:c-basics:0:0')

    // 知识点名称「输入输出」可搜到绑定题
    const byKpName = problems.list({ keyword: '输入输出', difficulty: 'all', tag: 'all' })
    expect(byKpName.map((p) => p.id)).toEqual([a.id])
    // 标签关键词
    const byTagKw = problems.list({ keyword: '前缀和', difficulty: 'all', tag: 'all' })
    expect(byTagKw.map((p) => p.id)).toEqual([a.id])
    // knowledgePointId 筛选（组合知识点 + 难度）
    const combo = problems.list({ keyword: '', difficulty: 'all', tag: 'all', knowledgePointId: 'kp:c-basics:0:0' })
    expect(combo.map((p) => p.id)).toEqual([a.id])
    // 未绑定该知识点的题不出现在结果中（b 未绑定任何知识点）
    const other = problems.list({ keyword: '', difficulty: 'all', tag: 'all', knowledgePointId: 'kp:c-basics:0:1' })
    expect(other).toEqual([])
  })
})
