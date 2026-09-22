import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { openDatabase } from '../src/main/db/connection'
import { LearningRepository, type LearningPathSeed } from '../src/main/db/repositories/learning-repository'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { makeProblemInput } from './helpers'

/**
 * v1.2.1 P1 回归：内置内容身份迁移（位置型 id → 稳定语义 id）。
 * 用真实发布的 seed v2 文件驱动，模拟真实 v1.2 库（mastery / review_items /
 * review_history / problem mapping / practice_sessions 全部挂在位置型 id 上），
 * 断言升级后所有数据仍绑定到原语义知识点（docs/V1_2_1_DEEP_AUDIT.md P1）。
 */

const realSeed = JSON.parse(
  readFileSync(join(process.cwd(), 'resources', 'seed-learning-path.json'), 'utf-8')
) as LearningPathSeed

/** 构造一个「v1.2 老库」：全部内置内容使用位置型 id，用户数据挂在上面 */
function makeLegacyV12Db(): { db: Database.Database; problems: ProblemRepository } {
  const db = openDatabase({ file: ':memory:' })
  const problems = new ProblemRepository(db)

  // 按 v1.2 的 ensureBuiltinPath 逻辑手工灌入位置型 id 的路线（名称与 seed v2 逐位一致）
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO learning_paths (id, slug, title, description, is_builtin, sort_order) VALUES ('lp:c-basics', 'c-basics', ?, ?, 1, 0)`
    ).run(realSeed.path.title, realSeed.path.description)
    const insStage = db.prepare(
      `INSERT INTO learning_stages (id, path_id, title, description, sort_order) VALUES (?, 'lp:c-basics', ?, ?, ?)`
    )
    const insKp = db.prepare(
      `INSERT INTO knowledge_points (id, stage_id, name, description, sort_order, tags) VALUES (?, ?, ?, ?, ?, ?)`
    )
    realSeed.stages.forEach((stage, si) => {
      const stageId = `ls:c-basics:${si}`
      insStage.run(stageId, stage.title, stage.description, si)
      stage.knowledgePoints.forEach((kp, ki) => {
        insKp.run(`kp:c-basics:${si}:${ki}`, stageId, kp.name, kp.description, ki, JSON.stringify(kp.tags))
      })
    })
  })
  tx()
  return { db, problems }
}

/** 在老库上挂用户数据：题目绑定 + mastery + review_items + review_history + 练习会话 */
function attachUserData(db: Database.Database, problems: ProblemRepository, legacyKpId: string): string {
  const p = problems.create(makeProblemInput({ title: '用户题' }), false)
  const now = 1_700_000_000_000
  db.prepare('INSERT INTO problem_knowledge_points (problem_id, knowledge_point_id) VALUES (?, ?)').run(p.id, legacyKpId)
  db.prepare(
    `INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES (?, 85, 'mastered', ?)`
  ).run(legacyKpId, now)
  db.prepare(
    `INSERT INTO review_items (id, target_type, target_id, last_reviewed_at, next_review_at, review_count, success_streak, failure_count, interval_days, created_at)
     VALUES ('ri-legacy-kp', 'knowledge_point', ?, ?, ?, 3, 2, 1, 14, ?)`
  ).run(legacyKpId, now, now + 86_400_000, now)
  db.prepare(
    `INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id) VALUES ('rh-1', 'ri-legacy-kp', 'good', ?, NULL)`
  ).run(now)
  db.prepare(
    `INSERT INTO practice_sessions (id, kind, knowledge_point_id, config, status, total, created_at, finished_at)
     VALUES ('ps-legacy', 'knowledge_point', ?, '{}', 'finished', 1, ?, ?)`
  ).run(legacyKpId, now, now + 1000)
  return p.id
}

describe('内置内容身份迁移（P1：位置型 id → 稳定语义 id）', () => {
  let db: Database.Database
  let learning: LearningRepository

  beforeEach(() => {
    const fixture = makeLegacyV12Db()
    db = fixture.db
    learning = new LearningRepository(db)
  })

  it('真实 v1.2 库（mastery/review/mapping/会话）升级：全部数据绑定到原语义知识点', () => {
    // 「输入输出」在 v1.2 是 kp:c-basics:0:0，seed v2 中 slug=io
    const legacyKpId = 'kp:c-basics:0:0'
    const semanticKpId = 'kp:c-basics:io'
    const problemId = attachUserData(db, new ProblemRepository(db), legacyKpId)

    const { stagesRenamed, kpsRenamed } = learning.migrateBuiltinContentIds(realSeed)
    expect(stagesRenamed).toBe(realSeed.stages.length) // 6 个阶段全部改名
    expect(kpsRenamed).toBe(realSeed.stages.reduce((n, s) => n + s.knowledgePoints.length, 0)) // 15 个 KP

    // mastery：仍指向「输入输出」的语义 id，分数/状态不丢
    const mastery = db.prepare('SELECT * FROM mastery WHERE knowledge_point_id = ?').get(semanticKpId) as
      | { score: number; status: string }
      | undefined
    expect(mastery).toMatchObject({ score: 85, status: 'mastered' })
    expect(db.prepare('SELECT COUNT(*) AS c FROM mastery').get()).toEqual({ c: 1 })

    // review_items：target_id 已改写，调度状态原样
    const ri = db
      .prepare(`SELECT * FROM review_items WHERE id = 'ri-legacy-kp'`)
      .get() as { target_id: string; review_count: number; interval_days: number }
    expect(ri.target_id).toBe(semanticKpId)
    expect(ri.review_count).toBe(3)
    expect(ri.interval_days).toBe(14)
    // review_history 仍挂在同一 review_item（id 未变）
    expect(db.prepare(`SELECT COUNT(*) AS c FROM review_history WHERE review_item_id = 'ri-legacy-kp'`).get()).toEqual({ c: 1 })

    // problem mapping 改写
    const mapping = db
      .prepare('SELECT knowledge_point_id AS k FROM problem_knowledge_points WHERE problem_id = ?')
      .get(problemId) as { k: string }
    expect(mapping.k).toBe(semanticKpId)

    // practice_sessions.knowledge_point_id 改写
    const ps = db.prepare(`SELECT knowledge_point_id AS k FROM practice_sessions WHERE id = 'ps-legacy'`).get() as { k: string }
    expect(ps.k).toBe(semanticKpId)

    // stage_id 全部改写为语义 stage id；无悬挂引用
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_points WHERE stage_id NOT IN (SELECT id FROM learning_stages)').get()).toEqual({ c: 0 })
    expect(learning.countDanglingReferences()).toBe(0)
    // 名称集合与总数不变
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_points').get()).toEqual({ c: 15 })
    expect(db.prepare(`SELECT name FROM knowledge_points WHERE id = ?`).get(semanticKpId)).toEqual({ name: '输入输出' })
  })

  it('迁移幂等：第二次执行零改名、数据不动', () => {
    attachUserData(db, new ProblemRepository(db), 'kp:c-basics:2:0')
    const first = learning.migrateBuiltinContentIds(realSeed)
    expect(first.kpsRenamed).toBeGreaterThan(0)
    const second = learning.migrateBuiltinContentIds(realSeed)
    expect(second.stagesRenamed).toBe(0)
    expect(second.kpsRenamed).toBe(0)
    expect(learning.countDanglingReferences()).toBe(0)
  })

  it('安全网：seed 与老库顺序不一致 → fail fast，零副作用', () => {
    attachUserData(db, new ProblemRepository(db), 'kp:c-basics:0:0')
    // 构造顺序错乱的 seed：把「变量与类型」放到「输入输出」前
    const shuffled: LearningPathSeed = {
      ...realSeed,
      stages: realSeed.stages.map((s, si) =>
        si === 0
          ? { ...s, knowledgePoints: [s.knowledgePoints[1] ?? s.knowledgePoints[0], s.knowledgePoints[0]] }
          : s
      )
    }
    expect(() => learning.migrateBuiltinContentIds(shuffled)).toThrow(/顺序不一致/)
    // 未发生任何改名
    expect(db.prepare(`SELECT COUNT(*) AS c FROM knowledge_points WHERE id = 'kp:c-basics:io'`).get()).toEqual({ c: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS c FROM mastery WHERE knowledge_point_id = 'kp:c-basics:0:0'`).get()).toEqual({ c: 1 })
    expect(learning.countDanglingReferences()).toBe(0)
  })

  it('内容迭代（ensureBuiltinPath v2 upsert）：改名/改描述/重排不破坏 mastery 绑定', () => {
    learning.migrateBuiltinContentIds(realSeed)
    learning.ensureBuiltinPath(realSeed)
    db.prepare(
      `INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES ('kp:c-basics:for-loop', 70, 'familiar', 123)`
    ).run()

    // seed v2.1：for 循环改名 + 描述更新 + 与 while 循环交换顺序 + 追加新 KP
    const evolved: LearningPathSeed = {
      ...realSeed,
      stages: realSeed.stages.map((s) =>
        s.slug === 'loops'
          ? {
              ...s,
              title: '循环与跳转',
              knowledgePoints: [
                { ...s.knowledgePoints[1], sortOrder: 0 } as (typeof s.knowledgePoints)[number],
                { ...s.knowledgePoints[0], name: 'for 计数循环', description: '更新后的描述' },
                { slug: 'nested-loop', name: '嵌套循环', description: '新增知识点', tags: ['循环'] }
              ]
            }
          : s
      )
    }
    learning.ensureBuiltinPath(evolved)

    // mastery 仍绑定 for-loop（id 不变），名称已更新
    expect(db.prepare(`SELECT COUNT(*) AS c FROM mastery WHERE knowledge_point_id = 'kp:c-basics:for-loop'`).get()).toEqual({ c: 1 })
    expect(db.prepare(`SELECT name FROM knowledge_points WHERE id = 'kp:c-basics:for-loop'`).get()).toEqual({ name: 'for 计数循环' })
    expect(db.prepare(`SELECT description FROM knowledge_points WHERE id = 'kp:c-basics:for-loop'`).get()).toEqual({ description: '更新后的描述' })
    // 顺序交换生效（for-loop sort_order=1）+ 新 KP 插入
    expect(db.prepare(`SELECT sort_order AS o FROM knowledge_points WHERE id = 'kp:c-basics:for-loop'`).get()).toEqual({ o: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS c FROM knowledge_points WHERE id = 'kp:c-basics:nested-loop'`).get()).toEqual({ c: 1 })
    // stage 标题更新
    expect(db.prepare(`SELECT title FROM learning_stages WHERE id = 'ls:c-basics:loops'`).get()).toEqual({ title: '循环与跳转' })
    expect(learning.countDanglingReferences()).toBe(0)
  })

  it('全新库（v1.2.1 直接安装）：无老 id 可迁移，直接以语义 id 灌入', () => {
    const freshDb = openDatabase({ file: ':memory:' })
    const freshLearning = new LearningRepository(freshDb)
    const { stagesRenamed, kpsRenamed } = freshLearning.migrateBuiltinContentIds(realSeed)
    expect(stagesRenamed).toBe(0)
    expect(kpsRenamed).toBe(0)
    freshLearning.ensureBuiltinPath(realSeed)
    const ids = (freshDb.prepare('SELECT id FROM knowledge_points ORDER BY id').all() as { id: string }[]).map((r) => r.id)
    expect(ids).toContain('kp:c-basics:io')
    expect(ids).toContain('kp:c-basics:struct')
    expect(ids.every((id) => !/:\d+:\d+$/.test(id))).toBe(true) // 无位置型 id
  })

  it('发布的 seed v2 满足不变量：slug 唯一、与 v1.2 顺序逐位同名（迁移安全网前提）', () => {
    const kpSlugs = new Set<string>()
    const stageSlugs = new Set<string>()
    for (const s of realSeed.stages) {
      expect(stageSlugs.has(s.slug)).toBe(false)
      stageSlugs.add(s.slug)
      for (const k of s.knowledgePoints) {
        expect(kpSlugs.has(k.slug)).toBe(false)
        kpSlugs.add(k.slug)
        expect(k.slug).toMatch(/^[a-z0-9-]+$/)
      }
    }
    expect(kpSlugs.size).toBe(15)
  })
})
