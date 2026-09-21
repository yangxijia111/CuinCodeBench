import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, currentVersion } from '../src/main/db/connection'
import { ProblemRepository, type ProblemWithCases } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository, type NewSubmission } from '../src/main/db/repositories/history-repository'
import { MistakeRepository } from '../src/main/db/repositories/mistake-repository'
import { SettingsRepository } from '../src/main/db/repositories/settings-repository'
import { StatsRepository } from '../src/main/db/repositories/stats-repository'
import { makeProblemInput } from './helpers'
import type Database from 'better-sqlite3'

/**
 * 数据层单元测试（内存库）：migration / CRUD / 级联 / 统计口径。
 * 对应 TEST_PLAN §1.4；覆盖 NFR-2、FR-H3。
 */

let db: Database.Database
let problems: ProblemRepository
let history: HistoryRepository
let mistakes: MistakeRepository
let settings: SettingsRepository
let stats: StatsRepository

beforeEach(() => {
  db = openDatabase({ file: ':memory:' })
  problems = new ProblemRepository(db)
  history = new HistoryRepository(db)
  mistakes = new MistakeRepository(db)
  settings = new SettingsRepository(db)
  stats = new StatsRepository(db)
})

describe('migration', () => {
  it('首次打开应用迁移至当前版本（v1.2 = 2）', () => {
    expect(currentVersion(db)).toBe(2)
  })

  it('重复迁移幂等', () => {
    // 重新执行迁移逻辑不应报错也不应重复建表
    expect(() => db.exec('SELECT 1')).not.toThrow()
    expect(currentVersion(db)).toBe(2)
  })

  it('全部核心表存在', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    for (const t of [
      'problems',
      'test_cases',
      'submissions',
      'test_case_results',
      'error_records',
      'mistake_book',
      'settings',
      'schema_migrations',
      // v1.2 学习体验表
      'learning_paths',
      'learning_stages',
      'knowledge_points',
      'problem_knowledge_points',
      'mastery',
      'review_items',
      'review_history',
      'mistake_notes',
      'practice_sessions',
      'practice_session_items'
    ]) {
      expect(tables).toContain(t)
    }
  })
})

describe('problem-repository CRUD', () => {
  it('创建并读取聚合（含用例）', () => {
    const created = problems.create(makeProblemInput())
    const loaded = problems.getById(created.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.title).toBe('测试题 A+B')
    expect(loaded?.tags).toEqual(['入门', '数学'])
    expect(loaded?.testCases).toHaveLength(3)
    expect(loaded?.testCases[0]?.stdin).toBe('1 2')
    expect(loaded?.testCases.map((t) => t.order)).toEqual([0, 1, 2])
    expect(loaded?.initialCode.python).toContain('print')
  })

  it('更新题目并整体替换用例', () => {
    const created = problems.create(makeProblemInput())
    const updated = problems.update(created.id, {
      ...makeProblemInput({ title: '改名了' }),
      testCases: [{ stdin: '5 5', expectedStdout: '10', timeoutMs: 3000 }]
    })
    expect(updated.title).toBe('改名了')
    expect(updated.testCases).toHaveLength(1)
    expect(updated.testCases[0]?.timeoutMs).toBe(3000)
  })

  it('删除题目级联删除用例', () => {
    const created = problems.create(makeProblemInput())
    problems.delete(created.id)
    expect(problems.getById(created.id)).toBeNull()
    const caseCount = (
      db.prepare('SELECT COUNT(*) AS c FROM test_cases WHERE problem_id=?').get(created.id) as {
        c: number
      }
    ).c
    expect(caseCount).toBe(0)
  })

  it('删除不存在的题目抛错', () => {
    expect(() => problems.delete('nope')).toThrow()
  })

  it('列表：关键词/难度/标签组合筛选', () => {
    problems.create(makeProblemInput({ title: '两数之和', difficulty: 'medium', tags: ['数组'] }))
    problems.create(makeProblemInput({ title: '回文判断', difficulty: 'easy', tags: ['字符串'] }))
    problems.create(makeProblemInput({ title: '排序练习', difficulty: 'hard', tags: ['数组', '排序'] }))

    expect(problems.list({ keyword: '之和', difficulty: 'all', tag: 'all' })).toHaveLength(1)
    expect(problems.list({ keyword: '', difficulty: 'easy', tag: 'all' })).toHaveLength(1)
    expect(problems.list({ keyword: '', difficulty: 'all', tag: '数组' })).toHaveLength(2)
    expect(problems.list({ keyword: '', difficulty: 'medium', tag: '数组' })).toHaveLength(1)
    expect(problems.list({ keyword: '', difficulty: 'all', tag: 'all' })).toHaveLength(3)
  })

  it('listTags 去重排序（zh-CN 拼音序）', () => {
    problems.create(makeProblemInput({ tags: ['数组', '数学'] }))
    problems.create(makeProblemInput({ tags: ['数组', '字符串'] }))
    expect(problems.listTags()).toEqual(['数学', '数组', '字符串'])
  })
})

describe('history-repository', () => {
  let problem: ProblemWithCases

  beforeEach(() => {
    problem = problems.create(makeProblemInput())
  })

  function makeSub(overrides: Partial<NewSubmission> = {}): NewSubmission {
    return {
      problemId: problem.id,
      language: 'python',
      code: 'print(1)',
      status: 'accepted',
      passedCount: 3,
      totalCount: 3,
      durationMs: 42,
      ...overrides
    }
  }

  it('写入提交与明细并可读回', () => {
    const results = problem.testCases.map((tc, i) => ({
      testCaseId: tc.id,
      order: i,
      stdin: tc.stdin,
      expected: tc.expectedStdout,
      actual: tc.expectedStdout,
      stderr: '',
      status: 'accepted' as const,
      exitCode: 0,
      durationMs: 10 + i
    }))
    const id = history.insertSubmission(makeSub(), results)
    const detail = history.getById(id)
    expect(detail).not.toBeNull()
    expect(detail?.submission.status).toBe('accepted')
    expect(detail?.submission.problemTitle).toBe('测试题 A+B')
    expect(detail?.results).toHaveLength(3)
    expect(detail?.results[2]?.durationMs).toBe(12)
  })

  it('按题目分页查询历史', () => {
    for (let i = 0; i < 5; i++) {
      history.insertSubmission(makeSub({ status: 'wrong_answer', passedCount: i }), [])
    }
    const page1 = history.list({ problemId: problem.id, limit: 2, offset: 0 })
    const page2 = history.list({ problemId: problem.id, limit: 2, offset: 2 })
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page1[0]?.createdAt).toBeGreaterThanOrEqual(page2[0]?.createdAt ?? 0)
  })

  it('每题统计：尝试次数与首次通过时间', () => {
    history.insertSubmission(makeSub({ status: 'wrong_answer', passedCount: 1 }), [])
    history.insertSubmission(makeSub({ status: 'compile_error', passedCount: 0 }), [])
    history.insertSubmission(makeSub({ status: 'accepted', passedCount: 3 }), [])

    const s = history.getProblemStats(problem.id)
    expect(s.attempts).toBe(3)
    expect(s.acceptedCount).toBe(1)
    expect(s.firstAcceptedAt).not.toBeNull()
  })

  it('无通过时 firstAcceptedAt 为 null', () => {
    history.insertSubmission(makeSub({ status: 'wrong_answer' }), [])
    const s = history.getProblemStats(problem.id)
    expect(s.attempts).toBe(1)
    expect(s.firstAcceptedAt).toBeNull()
  })
})

describe('mistake-repository', () => {
  let problem: ProblemWithCases

  beforeEach(() => {
    problem = problems.create(makeProblemInput())
  })

  function submit(status: 'accepted' | 'wrong_answer' | 'runtime_error'): void {
    history.insertSubmission(
      {
        problemId: problem.id,
        language: 'c',
        code: 'int main(){return 0;}',
        status,
        passedCount: status === 'accepted' ? 3 : 1,
        totalCount: 3,
        durationMs: 5
      },
      []
    )
    mistakes.recompute(problem.id)
  }

  it('失败 1 次不进入错题列表，失败 2 次进入', () => {
    submit('wrong_answer')
    expect(mistakes.listUnmastered()).toHaveLength(0)
    submit('runtime_error')
    const entries = mistakes.listUnmastered()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.failedCount).toBe(2)
    expect(entries[0]?.lastErrorType).toBe('runtime_error')
    expect(entries[0]?.errorTypeCounts).toEqual([
      { type: 'runtime_error', count: 1 },
      { type: 'wrong_answer', count: 1 }
    ])
  })

  it('AC 后错题保留，mastered 后隐藏', () => {
    submit('wrong_answer')
    submit('wrong_answer')
    submit('accepted')
    expect(mistakes.listUnmastered()).toHaveLength(1)
    mistakes.setMastered(problem.id, true)
    expect(mistakes.listUnmastered()).toHaveLength(0)
    expect(mistakes.listAll()).toHaveLength(1)
    // 取消掌握后重新可见
    mistakes.setMastered(problem.id, false)
    expect(mistakes.listUnmastered()).toHaveLength(1)
  })

  it('无失败记录时聚合条目被清除', () => {
    submit('accepted')
    submit('accepted')
    expect(mistakes.listAll()).toHaveLength(0)
    const rows = db.prepare('SELECT COUNT(*) AS c FROM mistake_book').get() as { c: number }
    expect(rows.c).toBe(0)
  })

  it('setMastered 不存在的条目抛错', () => {
    expect(() => mistakes.setMastered('nope', true)).toThrow()
  })
})

describe('settings-repository', () => {
  it('默认值与更新合并', () => {
    const s0 = settings.get()
    expect(s0.fontSize).toBe(14)
    expect(s0.judgeTimeoutDefaultMs).toBe(5000)

    const s1 = settings.update({ fontSize: 18 })
    expect(s1.fontSize).toBe(18)
    expect(s1.tabSize).toBe(4)
    expect(settings.get().fontSize).toBe(18)
  })
})

describe('stats-repository', () => {
  it('空库指标全零', () => {
    const d = stats.getDashboard()
    expect(d.totalSubmissions).toBe(0)
    expect(d.accuracy).toBe(0)
    expect(d.streakDays).toBe(0)
    expect(d.totalProblemsInBank).toBe(0)
  })

  it('正确率/做题数/Accepted 数口径', () => {
    const p1 = problems.create(makeProblemInput())
    const p2 = problems.create(makeProblemInput({ title: '第二题' }))
    const sub = (problemId: string, status: 'accepted' | 'wrong_answer'): void => {
      history.insertSubmission(
        {
          problemId,
          language: 'cpp',
          code: 'x',
          status,
          passedCount: status === 'accepted' ? 1 : 0,
          totalCount: 1,
          durationMs: 1
        },
        []
      )
    }
    sub(p1.id, 'accepted')
    sub(p1.id, 'wrong_answer')
    sub(p2.id, 'wrong_answer')

    const d = stats.getDashboard()
    expect(d.totalSubmissions).toBe(3)
    expect(d.accuracy).toBeCloseTo(1 / 3)
    expect(d.totalProblemsAttempted).toBe(2)
    expect(d.acceptedProblems).toBe(1)
    expect(d.languageCounts.cpp).toBe(3)
    expect(d.todaySubmissions).toBe(3)
  })

  it('连续天数：今天提交记 1 天', () => {
    const p = problems.create(makeProblemInput())
    history.insertSubmission(
      {
        problemId: p.id,
        language: 'python',
        code: 'x',
        status: 'accepted',
        passedCount: 1,
        totalCount: 1,
        durationMs: 1
      },
      []
    )
    expect(stats.getDashboard().streakDays).toBe(1)
  })

  it('错误类型 Top 聚合', () => {
    const p = problems.create(makeProblemInput())
    const id1 = history.insertSubmission(
      {
        problemId: p.id,
        language: 'python',
        code: 'x',
        status: 'runtime_error',
        passedCount: 0,
        totalCount: 1,
        durationMs: 1
      },
      []
    )
    const id2 = history.insertSubmission(
      {
        problemId: p.id,
        language: 'python',
        code: 'x',
        status: 'runtime_error',
        passedCount: 0,
        totalCount: 1,
        durationMs: 1
      },
      []
    )
    history.insertErrorRecord({
      submissionId: id1,
      problemId: p.id,
      language: 'python',
      errorType: 'runtime_error',
      message: 'ZeroDivisionError'
    })
    history.insertErrorRecord({
      submissionId: id2,
      problemId: p.id,
      language: 'python',
      errorType: 'runtime_error',
      message: 'ValueError'
    })
    const d = stats.getDashboard()
    expect(d.errorTypeCounts[0]).toEqual({ type: 'runtime_error', count: 2 })
  })
})
