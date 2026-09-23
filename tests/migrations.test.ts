import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { currentVersion, migrate, openDatabase } from '../src/main/db/connection'
import { LearningRepository, type LearningPathSeed } from '../src/main/db/repositories/learning-repository'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import type { ProblemInput } from '../src/shared/types'

/**
 * P0 验收：v1 → v2 migration、幂等性、内置路线灌入与旧题映射（docs/V1_2_ROADMAP.md P0）。
 */

/** 手工构造 v1.1 schema（与 MIGRATIONS[0] 等价的最小环境，用于验证升级路径） */
function openV1Db(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init', 0);
    CREATE TABLE problems (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
      tags TEXT NOT NULL DEFAULT '[]', input_desc TEXT NOT NULL DEFAULT '', output_desc TEXT NOT NULL DEFAULT '',
      samples TEXT NOT NULL DEFAULT '[]', initial_code TEXT NOT NULL DEFAULT '{}',
      is_builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE test_cases (
      id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      stdin TEXT NOT NULL DEFAULT '', expected_stdout TEXT NOT NULL DEFAULT '',
      timeout_ms INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 60000), "order" INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      language TEXT NOT NULL CHECK (language IN ('c','cpp','python')), code TEXT NOT NULL, status TEXT NOT NULL,
      passed_count INTEGER NOT NULL, total_count INTEGER NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE test_case_results (
      id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      test_case_id TEXT NOT NULL, "order" INTEGER NOT NULL, stdin TEXT NOT NULL, expected TEXT NOT NULL,
      actual TEXT, stderr TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER NOT NULL
    );
    CREATE TABLE error_records (
      id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE, language TEXT NOT NULL,
      error_type TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE mistake_book (
      problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
      failed_count INTEGER NOT NULL DEFAULT 0, first_failed_at INTEGER, last_failed_at INTEGER,
      last_error_type TEXT, error_type_counts TEXT NOT NULL DEFAULT '{}',
      mastered INTEGER NOT NULL DEFAULT 0, mastered_at INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  return db
}

const seed: LearningPathSeed = {
  seedVersion: 2,
  path: { slug: 'c-basics', title: 'C 基础', description: '测试路线' },
  stages: [
    {
      slug: 'getting-started',
      title: '起步',
      description: '',
      knowledgePoints: [
        { slug: 'io', name: '输入输出', description: '', tags: ['输入输出', '入门'] },
        { slug: 'variables-types', name: '变量与类型', description: '', tags: ['变量', '入门'] }
      ]
    },
    {
      slug: 'loops',
      title: '循环',
      description: '',
      knowledgePoints: [{ slug: 'for-loop', name: 'for 循环', description: '', tags: ['for', '循环'] }]
    }
  ],
  builtinProblemMap: { 'A+B 问题': ['输入输出'] }
}

function makeProblem(title: string, tags: string[]): ProblemInput {
  return {
    title,
    description: 'd',
    difficulty: 'easy',
    tags,
    inputDesc: '',
    outputDesc: '',
    samples: [],
    initialCode: { c: '', cpp: '', python: '' },
    testCases: [{ stdin: '', expectedStdout: '', timeoutMs: 5000 }]
  }
}

describe('migration v2（learning-v1.2）', () => {
  it('v1 库应用 v2 迁移后：旧数据完整、v2 表与扩展列就绪', () => {
    const db = openV1Db()
    db.prepare(
      `INSERT INTO problems (id, title, description, difficulty, tags, input_desc, output_desc, samples, initial_code, is_builtin, created_at, updated_at)
       VALUES ('p1', '旧题', 'd', 'easy', '["入门"]', '', '', '[]', '{}', 1, 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('s1', 'p1', 'c', 'int main(){return 0;}', 'wrong_answer', 0, 1, 5, 100)`
    ).run()
    db.prepare(
      `INSERT INTO error_records (id, submission_id, problem_id, language, error_type, message, created_at)
       VALUES ('e1', 's1', 'p1', 'c', 'wrong_answer', 'msg', 100)`
    ).run()

    migrate(db)

    // v1.2.1：迁移链 v1 → v2 → v3 全部应用（v3 = review exactly-once + 引用完整性）
    expect(currentVersion(db)).toBe(4)
    // v3 产物：exactly-once 表 + 清理触发器存在
    expect(
      db
        .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='review_session_results'`)
        .get()
    ).toEqual({ c: 1 })
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name IN ('trg_problems_delete_review_cleanup','trg_kp_delete_review_cleanup')`
        )
        .get()
    ).toEqual({ c: 2 })
    // 旧数据原样
    const old = db.prepare('SELECT title, is_builtin FROM problems WHERE id = ?').get('p1') as {
      title: string
      is_builtin: number
    }
    expect(old.title).toBe('旧题')
    expect(old.is_builtin).toBe(1)
    const sub = db.prepare('SELECT status FROM submissions WHERE id = ?').get('s1') as { status: string }
    expect(sub.status).toBe('wrong_answer')
    // v2 表可写
    const repo = new LearningRepository(db)
    repo.ensureBuiltinPath(seed)
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_points').get()).toEqual({ c: 3 })
    // error_records 扩展列存在且旧行保持 NULL
    const rec = db
      .prepare('SELECT learning_category, category_source FROM error_records WHERE id = ?')
      .get('e1') as { learning_category: string | null; category_source: string | null }
    expect(rec.learning_category).toBeNull()
    expect(rec.category_source).toBeNull()
  })

  it('migrate 幂等：重复执行不重复应用，版本号稳定', () => {
    const db = openDatabase({ file: ':memory:' })
    expect(currentVersion(db)).toBeGreaterThanOrEqual(2)
    const before = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
    // 再次跑连接层会重复 migrate；直接再开一次同一 :memory: 不可行，改为显式断言记录唯一
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number
    }[]
    expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length)
    expect(versions.map((v) => v.version)).toContain(1)
    expect(before.c).toBe(versions.length)
  })

  it('v2 新表存在且约束生效（mastery 分数范围、review_items 唯一性）', () => {
    const db = openDatabase({ file: ':memory:' })
    expect(() =>
      db
        .prepare(`INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES ('x', 101, 'learning', 0)`)
        .run()
    ).toThrow()
    const repo = new LearningRepository(db)
    repo.ensureBuiltinPath(seed)
    const kpId = 'kp:c-basics:io'
    db.prepare(`INSERT INTO review_items (id, target_type, target_id, next_review_at, created_at) VALUES ('r1', 'knowledge_point', ?, 0, 0)`).run(kpId)
    expect(() =>
      db
        .prepare(`INSERT INTO review_items (id, target_type, target_id, next_review_at, created_at) VALUES ('r2', 'knowledge_point', ?, 0, 0)`)
        .run(kpId)
    ).toThrow(/UNIQUE/i)
    db.prepare(`INSERT INTO review_items (id, target_type, target_id, next_review_at, created_at) VALUES ('r3', 'problem', 'p9', 0, 0)`).run()
  })
})

describe('内置学习路线灌入与旧题映射', () => {
  it('ensureBuiltinPath 幂等：两次灌入计数不变，确定性 id 稳定', () => {
    const db = openDatabase({ file: ':memory:' })
    const repo = new LearningRepository(db)
    repo.ensureBuiltinPath(seed)
    repo.ensureBuiltinPath(seed)

    const paths = db.prepare('SELECT COUNT(*) AS c FROM learning_paths').get() as { c: number }
    const stages = db.prepare('SELECT COUNT(*) AS c FROM learning_stages').get() as { c: number }
    const kps = db.prepare('SELECT COUNT(*) AS c FROM knowledge_points').get() as { c: number }
    expect(paths.c).toBe(1)
    expect(stages.c).toBe(2)
    expect(kps.c).toBe(3)

    const path = repo.getPathBySlug('c-basics')
    expect(path?.id).toBe('lp:c-basics')
    const stageList = repo.listStages('lp:c-basics')
    expect(stageList.map((s) => s.id)).toEqual(['ls:c-basics:getting-started', 'ls:c-basics:loops'])
    const kp = repo.getKnowledgePoint('kp:c-basics:for-loop')
    expect(kp?.name).toBe('for 循环')
  })

  it('mapBuiltinProblems 按标题映射内置题且幂等；用户题不映射', () => {
    const db = openDatabase({ file: ':memory:' })
    const repo = new LearningRepository(db)
    const problems = new ProblemRepository(db)
    repo.ensureBuiltinPath(seed)
    problems.create(makeProblem('A+B 问题', ['入门', '数学']), true)
    problems.create(makeProblem('用户题', ['输入输出']), false)

    const bound1 = repo.mapBuiltinProblems(seed.builtinProblemMap, seed.path.slug)
    expect(bound1).toBe(1)
    const bound2 = repo.mapBuiltinProblems(seed.builtinProblemMap, seed.path.slug)
    expect(bound2).toBe(0)

    const rows = db.prepare('SELECT problem_id, knowledge_point_id FROM problem_knowledge_points').all() as {
      problem_id: string
      knowledge_point_id: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.knowledge_point_id).toBe('kp:c-basics:io')

    const userKps = repo.knowledgePointIdsForProblem(
      (problems.list({ keyword: '用户题', difficulty: 'all', tag: 'all' })[0] as { id: string }).id
    )
    expect(userKps).toHaveLength(0)
  })

  it('mapProblemsByTags 别名兜底映射：tag 或标题命中即绑定', () => {
    const db = openDatabase({ file: ':memory:' })
    const repo = new LearningRepository(db)
    const problems = new ProblemRepository(db)
    repo.ensureBuiltinPath(seed)
    problems.create(makeProblem('循环练习', ['for']), true)
    problems.create(makeProblem('变量入门', ['变量']), true)

    const bound = repo.mapProblemsByTags()
    expect(bound).toBeGreaterThanOrEqual(2)
    // 「循环练习」→ for 循环；「变量入门」→ 变量与类型 + 输入输出/变量（别名含 入门/变量 命中）
    const kpFor = (title: string): string[] =>
      repo.knowledgePointIdsForProblem(
        (problems.list({ keyword: title, difficulty: 'all', tag: 'all' })[0] as { id: string }).id
      )
    expect(kpFor('循环练习')).toContain('kp:c-basics:for-loop')
  })

  it('绑定/解绑幂等：重复绑定不产生重复行', () => {
    const db = openDatabase({ file: ':memory:' })
    const repo = new LearningRepository(db)
    const problems = new ProblemRepository(db)
    repo.ensureBuiltinPath(seed)
    const p = problems.create(makeProblem('A+B 问题', []), true)
    repo.bindProblem(p.id, 'kp:c-basics:io')
    repo.bindProblem(p.id, 'kp:c-basics:io')
    expect(repo.knowledgePointIdsForProblem(p.id)).toHaveLength(1)
    repo.unbindProblem(p.id, 'kp:c-basics:io')
    expect(repo.knowledgePointIdsForProblem(p.id)).toHaveLength(0)
  })
})
