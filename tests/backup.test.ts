import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { MistakeRepository } from '../src/main/db/repositories/mistake-repository'
import { LearningRepository } from '../src/main/db/repositories/learning-repository'
import { BackupRepository } from '../src/main/db/repositories/backup-repository'
import { StatsRepository } from '../src/main/db/repositories/stats-repository'
import { BackupService } from '../src/main/services/backup-service'
import { makeProblemInput } from './helpers'

/**
 * P1 验收：完整备份与恢复（docs/V1_2_BACKUP_SPEC.md §8）。
 * 覆盖：全量数据往返一致、空库、统计一致、损坏 JSON、版本错误、字段缺失、
 * 交叉引用断裂、重复主键、事务中途失败注入、verify 失败注入。
 */

function buildFullData(db: Database.Database): void {
  const problems = new ProblemRepository(db)
  const history = new HistoryRepository(db)
  const mistakes = new MistakeRepository(db)
  const learning = new LearningRepository(db)

  learning.ensureBuiltinPath({
    seedVersion: 2,
    path: { slug: 'c-basics', title: 'C 基础', description: '' },
    stages: [
      {
        slug: 'getting-started',
        title: '起步',
        description: '',
        knowledgePoints: [{ slug: 'io', name: '输入输出', description: '', tags: ['io'] }]
      }
    ],
    builtinProblemMap: {}
  })

  const p1 = problems.create(makeProblemInput(), true)
  const p2 = problems.create(makeProblemInput({ title: '第二题', tags: ['数组'] }), true)
  learning.bindProblem(p1.id, 'kp:c-basics:io')

  // p1：失败两次（进错题本）+ AC 一次；p2：AC 一次
  for (const status of ['wrong_answer', 'compile_error'] as const) {
    const sid = history.insertSubmission(
      {
        problemId: p1.id,
        language: 'c',
        code: `// fail ${status}`,
        status,
        passedCount: 0,
        totalCount: 3,
        durationMs: 10
      },
      [
        {
          testCaseId: p1.testCases[0].id,
          order: 0,
          stdin: '1 2',
          expected: '3',
          actual: status === 'wrong_answer' ? '9' : null,
          stderr: 'err-out',
          status,
          exitCode: status === 'wrong_answer' ? 0 : 1,
          durationMs: 5
        }
      ]
    )
    history.insertErrorRecord({
      submissionId: sid,
      problemId: p1.id,
      language: 'c',
      errorType: status,
      message: 'msg-' + status
    })
  }
  mistakes.recompute(p1.id)
  mistakes.setMastered(p1.id, false)

  const acId = history.insertSubmission(
    { problemId: p1.id, language: 'python', code: 'print(3)', status: 'accepted', passedCount: 3, totalCount: 3, durationMs: 7 },
    []
  )
  void acId
  history.insertSubmission(
    { problemId: p2.id, language: 'cpp', code: 'x', status: 'accepted', passedCount: 3, totalCount: 3, durationMs: 7 },
    []
  )

  // v1.2 表直接写入（review/mastery/notes/session 的备份往返）
  db.prepare(
    `INSERT INTO review_items (id, target_type, target_id, last_reviewed_at, next_review_at, review_count, success_streak, failure_count, interval_days, created_at)
     VALUES ('ri1', 'problem', ?, NULL, 1000, 2, 1, 1, 3, 500)`
  ).run(p1.id)
  db.prepare(
    `INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id) VALUES ('rh1', 'ri1', 'good', 900, NULL)`
  ).run()
  db.prepare(
    `INSERT INTO mistake_notes (problem_id, note, updated_at) VALUES (?, '忘记 switch break', 800)`
  ).run(p1.id)
  db.prepare(
    `INSERT INTO error_records (id, submission_id, problem_id, language, error_type, message, created_at, learning_category, category_source)
     VALUES ('er-cat', (SELECT id FROM submissions LIMIT 1), ?, 'c', 'compile_error', 'm', 700, 'syntax', 'auto')`
  ).run(p1.id)
  db.prepare(
    `INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES ('kp:c-basics:io', 72, 'familiar', 600)`
  ).run()
  db.prepare(
    `INSERT INTO practice_sessions (id, kind, knowledge_point_id, config, status, total, created_at, finished_at)
     VALUES ('ps1', 'knowledge_point', 'kp:c-basics:io', '{"size":10}', 'finished', 1, 400, 450)`
  ).run()
  db.prepare(
    `INSERT INTO practice_session_items (id, session_id, problem_id, sort_order, status, attempts, first_accepted_submission_id, first_result_at)
     VALUES ('psi1', 'ps1', ?, 0, 'accepted', 1, NULL, 440)`
  ).run(p1.id)
  // v1.2.1：会话评分 exactly-once 记录（备份往返）
  db.prepare(
    `INSERT INTO review_session_results (session_id, review_item_id, grade, submission_id, graded_at)
     VALUES ('ps1', 'ri1', 'good', NULL, 460)`
  ).run()
}

describe('备份与恢复（BackupService）', () => {
  let source: Database.Database
  let target: Database.Database

  beforeEach(() => {
    source = openDatabase({ file: ':memory:' })
    target = openDatabase({ file: ':memory:' })
  })

  it('全量数据导出 → 校验 → 恢复到空库：逐表完全一致', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')

    const svcB = new BackupService(target)
    const { envelope, summary } = svcB.validate(json)
    expect(summary.counts.problems).toBe(2)
    expect(summary.counts.submissions).toBe(4)
    svcB.restore(envelope)

    // 深度对比：恢复后的全量读取与源库完全一致（含 id 与时间戳）
    const dataA = new BackupRepository(source).readAll()
    const dataB = new BackupRepository(target).readAll()
    expect(JSON.stringify(dataB)).toBe(JSON.stringify(dataA))
  })

  it('恢复后统计一致性：Dashboard 计数与源库相同', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')

    const svcB = new BackupService(target)
    const { envelope } = svcB.validate(json)
    svcB.restore(envelope)

    const dA = new StatsRepository(source).getDashboard()
    const dB = new StatsRepository(target).getDashboard()
    expect(dB.totalSubmissions).toBe(dA.totalSubmissions)
    expect(dB.acceptedProblems).toBe(dA.acceptedProblems)
    expect(dB.totalProblemsInBank).toBe(dA.totalProblemsInBank)
    expect(dB.languageCounts).toEqual(dA.languageCounts)
  })

  it('v1 备份兼容：缺失 reviewSessionResults 字段可导入恢复（optional schema）', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    // 构造 v1 备份：删除 v1.2.1 新增字段
    const envelope = JSON.parse(json) as { data: Record<string, unknown> }
    delete envelope.data['reviewSessionResults']
    const stripped = JSON.stringify(envelope)

    const svcB = new BackupService(target)
    const { envelope: parsed } = svcB.validate(stripped)
    svcB.restore(parsed)
    expect(new BackupRepository(target).counts().reviewSessionResults).toBe(0)
    // 其余数据完整
    expect(new BackupRepository(target).counts().reviewItems).toBe(1)
    expect(new BackupRepository(target).counts().practiceSessions).toBe(1)
  })

  it('空数据库：备份 → 恢复到另一空库 → 一致（计数全零）', () => {
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const svcB = new BackupService(target)
    const { envelope, summary } = svcB.validate(json)
    expect(summary.counts.problems).toBe(0)
    svcB.restore(envelope)
    const counts = new BackupRepository(target).counts()
    expect(counts.problems).toBe(0)
    expect(counts.submissions).toBe(0)
  })

  it('损坏 JSON → 明确报错，原数据无损', () => {
    buildFullData(source)
    const before = JSON.stringify(new BackupRepository(source).readAll())
    const svc = new BackupService(source)
    expect(() => svc.validate('{not valid json')).toThrow(/JSON/)
    expect(JSON.stringify(new BackupRepository(source).readAll())).toBe(before)
  })

  it('format 错误（题目导出文件误当备份）→ 拒绝并提示', () => {
    const svc = new BackupService(source)
    const problemsJson = JSON.stringify({
      format: 'cuincodebench.problems',
      version: 1,
      problems: [makeProblemInput()]
    })
    expect(() => svc.validate(problemsJson)).toThrow(/完整备份|题目导出/)
  })

  it('version 过新 → 明确拒绝；version 缺失 → schema 拒绝', () => {
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const envelope = JSON.parse(json) as Record<string, unknown>

    const newer = JSON.stringify({ ...envelope, version: 99 })
    expect(() => new BackupService(source).validate(newer)).toThrow(/版本过新/)

    const noVersion = JSON.stringify({ ...envelope, version: undefined })
    expect(() => new BackupService(source).validate(noVersion)).toThrow()
  })

  it('字段缺失（题目缺 testCases）→ schema 拒绝', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const envelope = JSON.parse(json) as { data: { problems: Record<string, unknown>[] } }
    if (envelope.data.problems.length > 0) {
      delete envelope.data.problems[0].testCases
    }
    expect(() => new BackupService(source).validate(JSON.stringify(envelope))).toThrow()
  })

  it('交叉引用断裂（提交指向不存在的题目）→ 拒绝', () => {
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const envelope = JSON.parse(json) as {
      data: { submissions: Array<{ problemId: string } & Record<string, unknown>> }
    }
    envelope.data.submissions.push({
      problemId: 'nonexistent-problem',
      id: 'x1',
      language: 'c',
      code: 'x',
      status: 'accepted',
      passedCount: 0,
      totalCount: 1,
      durationMs: 1,
      createdAt: 1,
      results: []
    })
    expect(() => new BackupService(source).validate(JSON.stringify(envelope))).toThrow(/引用断裂|不存在/)
  })

  it('重复主键数据 → 恢复抛错且整体回滚（原数据逐表一致）', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const envelope = JSON.parse(json) as { data: { problems: unknown[] } }
    envelope.data.problems.push(JSON.parse(JSON.stringify(envelope.data.problems[0])) as never)

    // 恢复目标库先放一条数据，验证回滚后不丢
    new ProblemRepository(target).create(makeProblemInput({ title: '恢复前已有' }), false)
    const beforeCounts = new BackupRepository(target).counts()

    const svcB = new BackupService(target)
    const parsed = svcB.validate(JSON.stringify(envelope))
    expect(() => svcB.restore(parsed.envelope)).toThrow()

    const afterCounts = new BackupRepository(target).counts()
    expect(JSON.stringify(afterCounts)).toBe(JSON.stringify(beforeCounts))
    expect(
      new ProblemRepository(target).list({ keyword: '恢复前已有', difficulty: 'all', tag: 'all' })
    ).toHaveLength(1)
  })

  it('事务中途失败注入（writeAll 抛错）→ 整体回滚', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')

    new ProblemRepository(target).create(makeProblemInput({ title: '恢复前已有' }), false)
    const beforeCounts = new BackupRepository(target).counts()
    const beforeData = JSON.stringify(new BackupRepository(target).readAll())

    const svcB = new BackupService(target)
    const { envelope } = svcB.validate(json)
    const spy = vi.spyOn(BackupRepository.prototype, 'writeAll').mockImplementationOnce(() => {
      throw new Error('injected mid-restore failure')
    })
    expect(() => svcB.restore(envelope)).toThrow('injected mid-restore failure')
    spy.mockRestore()

    expect(JSON.stringify(new BackupRepository(target).readAll())).toBe(beforeData)
    expect(JSON.stringify(new BackupRepository(target).counts())).toBe(JSON.stringify(beforeCounts))
  })

  it('verify 计数失败注入 → 抛错回滚', () => {
    buildFullData(source)
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const beforeData = JSON.stringify(new BackupRepository(target).readAll())

    const svcB = new BackupService(target)
    const { envelope } = svcB.validate(json)
    const spy = vi
      .spyOn(BackupRepository, 'expectedCounts')
      .mockImplementationOnce((data) => {
        // spyOn 保留原实现：Once 消耗后，内部这次递归调用走真实逻辑
        const real = BackupRepository.expectedCounts(data)
        return { ...real, problems: real.problems + 999 }
      })
    expect(() => svcB.restore(envelope)).toThrow(/恢复校验失败/)
    spy.mockRestore()

    expect(JSON.stringify(new BackupRepository(target).readAll())).toBe(beforeData)
  })

  it('settings 特例：备份缺失标记键时保留本地值（防种子重灌）', () => {
    buildFullData(source)
    // 本地有 seeded 标记；备份去掉 seeded
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')
    const envelope = JSON.parse(json) as { data: { settings: Record<string, string> } }
    delete envelope.data.settings['seeded']

    target
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('seeded', '1')
    const svcB = new BackupService(target)
    const { envelope: validated } = svcB.validate(JSON.stringify(envelope))
    svcB.restore(validated)

    const row = target.prepare('SELECT value FROM settings WHERE key = ?').get('seeded') as {
      value: string
    }
    expect(row.value).toBe('1')
  })

  it('恢复完成后 marker 键以备份为准（备份含 seeded 则覆盖本地）', () => {
    buildFullData(source)
    source.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('seeded', '1')
    const svcA = new BackupService(source)
    const { json } = svcA.exportJson('1.2.0-test')

    const svcB = new BackupService(target)
    const { envelope } = svcB.validate(json)
    svcB.restore(envelope)
    const row = target.prepare('SELECT value FROM settings WHERE key = ?').get('seeded') as {
      value: string
    }
    expect(row.value).toBe('1')
  })
})
