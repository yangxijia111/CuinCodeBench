import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { MistakeReviewService, autoCategory } from '../src/main/services/mistake-review-service'
import { makeProblemInput } from './helpers'

/**
 * P5 验收：错题复盘——错误历史、首末错误代码、笔记、学习错误分类（docs/V1_2_ROADMAP.md P5）。
 */

describe('autoCategory 自动分类规则（spec §6）', () => {
  it('compile_error → syntax；time_limit_exceeded → algorithm；其余 unknown', () => {
    expect(autoCategory('compile_error')).toBe('syntax')
    expect(autoCategory('time_limit_exceeded')).toBe('algorithm')
    expect(autoCategory('wrong_answer')).toBe('unknown')
    expect(autoCategory('runtime_error')).toBe('unknown')
    expect(autoCategory('output_limit_exceeded')).toBe('unknown')
  })
})

describe('MistakeReviewService', () => {
  let db: Database.Database
  let problems: ProblemRepository
  let history: HistoryRepository
  let svc: MistakeReviewService
  let pid: string

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    problems = new ProblemRepository(db)
    history = new HistoryRepository(db)
    svc = new MistakeReviewService(db)
    pid = problems.create(makeProblemInput(), true).id
  })

  it('错误历史：失败提交时间倒序 + 错误信息；AC 提交不出现', () => {
    const s1 = history.insertSubmission(
      { problemId: pid, language: 'c', code: 'code-v1', status: 'wrong_answer', passedCount: 0, totalCount: 3, durationMs: 1 },
      []
    )
    history.insertErrorRecord({ submissionId: s1, problemId: pid, language: 'c', errorType: 'wrong_answer', message: 'WA-msg' })
    history.insertSubmission(
      { problemId: pid, language: 'c', code: 'ac', status: 'accepted', passedCount: 3, totalCount: 3, durationMs: 1 },
      []
    )

    const h = svc.getHistory(pid)
    expect(h).toHaveLength(1)
    expect(h[0]?.code).toBe('code-v1')
    expect(h[0]?.message).toBe('WA-msg')
    expect(h[0]?.status).toBe('wrong_answer')
  })

  it('首次/最近错误代码取自失败提交的两端', () => {
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('s1', ?, 'c', 'FIRST', 'wrong_answer', 0, 1, 1, 100)`
    ).run(pid)
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('s2', ?, 'c', 'OK', 'accepted', 1, 1, 1, 200)`
    ).run(pid)
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('s3', ?, 'c', 'LATEST', 'runtime_error', 0, 1, 1, 300)`
    ).run(pid)

    const { firstCode, latestCode } = svc.firstAndLatestCode(pid)
    expect(firstCode).toBe('FIRST')
    expect(latestCode).toBe('LATEST')
  })

  it('无错误历史时 first/latest 为 null', () => {
    const r = svc.firstAndLatestCode(pid)
    expect(r.firstCode).toBeNull()
    expect(r.latestCode).toBeNull()
  })

  it('笔记：保存/更新/读取；题目不存在报错', () => {
    const n1 = svc.setNote(pid, '忘记 break', 100)
    expect(n1.note).toBe('忘记 break')
    svc.setNote(pid, '忘记 switch 的 break；数组边界多跑一轮', 200)
    const n = svc.getNote(pid)
    expect(n?.note).toContain('switch')
    expect(n?.updatedAt).toBe(200)
    expect(() => svc.setNote('nope', 'x', 1)).toThrow(/不存在/)
  })

  it('手动分类：更新最近一条错误记录并标记 manual；无记录报错', () => {
    const s1 = history.insertSubmission(
      { problemId: pid, language: 'c', code: 'x', status: 'wrong_answer', passedCount: 0, totalCount: 3, durationMs: 1 },
      []
    )
    history.insertErrorRecord({
      submissionId: s1, problemId: pid, language: 'c', errorType: 'wrong_answer', message: 'm',
      learningCategory: 'syntax'
    })

    svc.setCategory(pid, 'off_by_one', 100)
    expect(svc.latestCategory(pid)).toBe('off_by_one')
    const row = db
      .prepare('SELECT learning_category, category_source FROM error_records WHERE submission_id = ?')
      .get(s1) as { learning_category: string; category_source: string }
    expect(row.learning_category).toBe('off_by_one')
    expect(row.category_source).toBe('manual')

    expect(() => svc.setCategory('nope', 'loop', 1)).toThrow(/没有错误记录/)
  })

  it('insertErrorRecord 自动分类：syntax 落库为 auto，unknown 不落库', () => {
    const s1 = history.insertSubmission(
      { problemId: pid, language: 'c', code: 'x', status: 'compile_error', passedCount: 0, totalCount: 3, durationMs: 1 },
      []
    )
    history.insertErrorRecord({
      submissionId: s1, problemId: pid, language: 'c', errorType: 'compile_error', message: 'm',
      learningCategory: 'syntax'
    })
    const s2 = history.insertSubmission(
      { problemId: pid, language: 'c', code: 'y', status: 'wrong_answer', passedCount: 0, totalCount: 3, durationMs: 1 },
      []
    )
    history.insertErrorRecord({
      submissionId: s2, problemId: pid, language: 'c', errorType: 'wrong_answer', message: 'm2',
      learningCategory: 'unknown'
    })

    const rows = db
      .prepare('SELECT submission_id, learning_category, category_source FROM error_records ORDER BY created_at')
      .all() as { submission_id: string; learning_category: string | null; category_source: string | null }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.learning_category).toBe('syntax')
    expect(rows[0]?.category_source).toBe('auto')
    expect(rows[1]?.learning_category).toBeNull()
    expect(rows[1]?.category_source).toBeNull()
  })
})
