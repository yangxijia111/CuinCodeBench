import type Database from 'better-sqlite3'
import type { KnowledgePoint, LearningPath, LearningStage } from '@shared/types'

/**
 * 学习路线仓储：内置路线幂等灌入、题目↔知识点绑定、进度聚合（docs/V1_2_LEARNING_MODEL.md）。
 * 内置数据使用确定性 id（slug/索引派生），重启与备份恢复后幂等不冲突。
 */

/** seed-learning-path.json（v2）的内存结构（schema 校验见 learning-seed.ts） */
export interface LearningPathSeed {
  /** 种子格式版本（v2 = 稳定语义 ID；v1.2 为位置型 ID，已由迁移重写） */
  seedVersion: 2
  path: { slug: string; title: string; description: string }
  stages: {
    /** 阶段稳定标识（长期身份，禁止用数组下标） */
    slug: string
    title: string
    description: string
    knowledgePoints: {
      /** 知识点稳定标识（长期身份，禁止用数组下标） */
      slug: string
      name: string
      description: string
      tags: string[]
    }[]
  }[]
  /** 内置题目标题 → 知识点名列表（一次性映射） */
  builtinProblemMap: Record<string, string[]>
}

/**
 * 内置数据的确定性 id 约定（v1.2.1 P1：稳定语义 ID，与数组顺序解耦）。
 * v1.2 及之前使用位置型 id（ls:{slug}:{index} / kp:{slug}:{i}:{j}）——插入/重排会
 * 使既有 mastery / review / mapping 的语义漂移，已由 migrateBuiltinContentIds 重写。
 */
export function builtinPathId(slug: string): string {
  return `lp:${slug}`
}
export function builtinStageId(pathSlug: string, stageSlug: string): string {
  return `ls:${pathSlug}:${stageSlug}`
}
export function builtinKpId(pathSlug: string, kpSlug: string): string {
  return `kp:${pathSlug}:${kpSlug}`
}

/** v1.2 位置型 id（仅迁移识别用，禁止新代码生成） */
export function legacyBuiltinStageId(pathSlug: string, stageIndex: number): string {
  return `ls:${pathSlug}:${stageIndex}`
}
export function legacyBuiltinKpId(pathSlug: string, stageIndex: number, kpIndex: number): string {
  return `kp:${pathSlug}:${stageIndex}:${kpIndex}`
}

interface PathRow {
  id: string
  slug: string
  title: string
  description: string
  is_builtin: number
  sort_order: number
}

interface StageRow {
  id: string
  path_id: string
  title: string
  description: string
  sort_order: number
}

interface KpRow {
  id: string
  stage_id: string
  name: string
  description: string
  sort_order: number
  tags: string
}

function rowToPath(r: PathRow): LearningPath {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    isBuiltin: r.is_builtin === 1,
    sortOrder: r.sort_order
  }
}

function rowToStage(r: StageRow): LearningStage {
  return { id: r.id, pathId: r.path_id, title: r.title, description: r.description, sortOrder: r.sort_order }
}

function rowToKp(r: KpRow): KnowledgePoint {
  return {
    id: r.id,
    stageId: r.stage_id,
    name: r.name,
    description: r.description,
    sortOrder: r.sort_order,
    tags: JSON.parse(r.tags) as string[]
  }
}

export class LearningRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * v1.2 位置型 id → v2 稳定语义 id 的数据迁移（P1，高风险，单事务）。
   *
   * 映射依据：v1.2 的 id = (path.slug, stage 数组序, kp 数组序)，seed v2 按相同
   * 数组顺序携带 slug，一一对应。级联更新全部引用方：
   * knowledge_points.stage_id / problem_knowledge_points / mastery /
   * review_items(target_id) / practice_sessions.knowledge_point_id。
   *
   * 事务内先关外键（SQLite 的 PRAGMA foreign_keys 在事务内是 no-op，必须在事务外切换），
   * 手动改完子表后恢复。幂等：旧 id 不存在（已迁移/全新库）即跳过。
   * 失败整体回滚，不留半迁移状态。
   */
  migrateBuiltinContentIds(seed: LearningPathSeed): { stagesRenamed: number; kpsRenamed: number } {
    const pathSlug = seed.path.slug
    let stagesRenamed = 0
    let kpsRenamed = 0
    const stageExists = this.db.prepare('SELECT 1 AS ok FROM learning_stages WHERE id = ?')
    const kpExists = this.db.prepare('SELECT 1 AS ok FROM knowledge_points WHERE id = ?')
    const stageName = this.db.prepare('SELECT title AS t FROM learning_stages WHERE id = ?')
    const kpName = this.db.prepare('SELECT name AS n FROM knowledge_points WHERE id = ?')

    // 安全网：映射按数组位置对应（v1.2 顺序 ↔ seed v2 顺序）。改名前核对旧 id 的
    // 名称与 seed 中同位置条目一致——seed 若相对 v1.2 发生插入/重排，此处 fail fast，
    // 不会把 mastery/review 迁到错误语义上（事务未开始，无部分状态）。
    const mismatches: string[] = []
    seed.stages.forEach((stage, si) => {
      const legacyStage = stageName.get(legacyBuiltinStageId(pathSlug, si)) as { t: string } | undefined
      if (legacyStage !== undefined && legacyStage.t !== stage.title) {
        mismatches.push(`stage[${si}] 数据库="${legacyStage.t}" seed="${stage.title}"`)
      }
      stage.knowledgePoints.forEach((kp, ki) => {
        const legacyKp = kpName.get(legacyBuiltinKpId(pathSlug, si, ki)) as { n: string } | undefined
        if (legacyKp !== undefined && legacyKp.n !== kp.name) {
          mismatches.push(`kp[${si}][${ki}] 数据库="${legacyKp.n}" seed="${kp.name}"`)
        }
      })
    })
    if (mismatches.length > 0) {
      throw new Error(
        `内置内容 id 迁移中止：seed 与 v1.2 数据顺序不一致（${mismatches.join('；')}）。` +
          '请勿在 seed 中相对 v1.2 插入/重排条目，只能追加或改内容。'
      )
    }

    const renameStage = (oldId: string, newId: string): void => {
      if (oldId === newId || stageExists.get(oldId) === undefined || stageExists.get(newId) !== undefined) return
      this.db.prepare('UPDATE learning_stages SET id = ? WHERE id = ?').run(newId, oldId)
      this.db.prepare('UPDATE knowledge_points SET stage_id = ? WHERE stage_id = ?').run(newId, oldId)
      stagesRenamed++
    }
    const renameKp = (oldId: string, newId: string): void => {
      if (oldId === newId || kpExists.get(oldId) === undefined || kpExists.get(newId) !== undefined) return
      this.db.prepare('UPDATE knowledge_points SET id = ? WHERE id = ?').run(newId, oldId)
      this.db.prepare('UPDATE problem_knowledge_points SET knowledge_point_id = ? WHERE knowledge_point_id = ?').run(newId, oldId)
      this.db.prepare('UPDATE mastery SET knowledge_point_id = ? WHERE knowledge_point_id = ?').run(newId, oldId)
      this.db
        .prepare(`UPDATE review_items SET target_id = ? WHERE target_type = 'knowledge_point' AND target_id = ?`)
        .run(newId, oldId)
      this.db.prepare('UPDATE practice_sessions SET knowledge_point_id = ? WHERE knowledge_point_id = ?').run(newId, oldId)
      kpsRenamed++
    }

    const tx = this.db.transaction(() => {
      seed.stages.forEach((stage, si) => {
        renameStage(legacyBuiltinStageId(pathSlug, si), builtinStageId(pathSlug, stage.slug))
        stage.knowledgePoints.forEach((kp, ki) => {
          renameKp(legacyBuiltinKpId(pathSlug, si, ki), builtinKpId(pathSlug, kp.slug))
        })
      })
    })
    // 事务外切外键开关；异常时恢复 ON 再上抛（连接层约定 foreign_keys=ON）
    this.db.pragma('foreign_keys = OFF')
    try {
      tx()
    } finally {
      this.db.pragma('foreign_keys = ON')
    }
    if (stagesRenamed > 0 || kpsRenamed > 0) {
      // 迁移后完整性自检：发现悬挂引用立即失败（整体已回滚或需人工介入）
      const dangling = this.countDanglingReferences()
      if (dangling > 0) {
        throw new Error(`内置内容 id 迁移后存在 ${dangling} 条悬挂引用（事务已回滚或数据异常）`)
      }
    }
    return { stagesRenamed, kpsRenamed }
  }

  /** 引用完整性计数（migrate 自检与测试用） */
  countDanglingReferences(): number {
    const q = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c
    return (
      q(`SELECT COUNT(*) AS c FROM knowledge_points WHERE stage_id NOT IN (SELECT id FROM learning_stages)`) +
      q(`SELECT COUNT(*) AS c FROM problem_knowledge_points WHERE knowledge_point_id NOT IN (SELECT id FROM knowledge_points)`) +
      q(`SELECT COUNT(*) AS c FROM problem_knowledge_points WHERE problem_id NOT IN (SELECT id FROM problems)`) +
      q(`SELECT COUNT(*) AS c FROM mastery WHERE knowledge_point_id NOT IN (SELECT id FROM knowledge_points)`) +
      q(`SELECT COUNT(*) AS c FROM review_items WHERE target_type = 'knowledge_point' AND target_id NOT IN (SELECT id FROM knowledge_points)`) +
      q(`SELECT COUNT(*) AS c FROM review_items WHERE target_type = 'problem' AND target_id NOT IN (SELECT id FROM problems)`) +
      q(`SELECT COUNT(*) AS c FROM practice_sessions WHERE knowledge_point_id IS NOT NULL AND knowledge_point_id NOT IN (SELECT id FROM knowledge_points)`)
    )
  }

  /**
   * 幂等灌入/更新一条内置路线（v2 语义：按稳定 id upsert）。
   * - 新增 stage/kp → 插入；
   * - 已存在（同 id）→ 更新 title/description/sort_order/tags（内容迭代不破坏引用）；
   * - seed 中移除的 kp 不删除（保留用户 mastery/review 数据）。
   */
  ensureBuiltinPath(seed: LearningPathSeed): void {
    const tx = this.db.transaction(() => {
      const pathId = builtinPathId(seed.path.slug)
      this.db
        .prepare(
          `INSERT INTO learning_paths (id, slug, title, description, is_builtin, sort_order)
           VALUES (?, ?, ?, ?, 1, 0)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description`
        )
        .run(pathId, seed.path.slug, seed.path.title, seed.path.description)
      const upsertStage = this.db.prepare(
        `INSERT INTO learning_stages (id, path_id, title, description, sort_order)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, sort_order = excluded.sort_order`
      )
      const upsertKp = this.db.prepare(
        `INSERT INTO knowledge_points (id, stage_id, name, description, sort_order, tags)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, sort_order = excluded.sort_order, tags = excluded.tags`
      )
      seed.stages.forEach((stage, si) => {
        const stageId = builtinStageId(seed.path.slug, stage.slug)
        upsertStage.run(stageId, pathId, stage.title, stage.description, si)
        stage.knowledgePoints.forEach((kp, ki) => {
          upsertKp.run(builtinKpId(seed.path.slug, kp.slug), stageId, kp.name, kp.description, ki, JSON.stringify(kp.tags))
        })
      })
    })
    tx()
  }

  /** 内置题目按显式映射绑定知识点（标题匹配 is_builtin=1 的题；幂等；pathSlug 参数化） */
  mapBuiltinProblems(map: Record<string, string[]>, pathSlug: string): number {
    const nameToId = new Map<string, string>()
    for (const row of this.db
      .prepare(
        `SELECT k.id, k.name FROM knowledge_points k
         JOIN learning_stages s ON s.id = k.stage_id
         JOIN learning_paths p ON p.id = s.path_id
         WHERE p.slug = ?`
      )
      .all(pathSlug) as { id: string; name: string }[]) {
      nameToId.set(row.name, row.id)
    }
    const findProblem = this.db.prepare(
      'SELECT id FROM problems WHERE title = ? AND is_builtin = 1 ORDER BY created_at LIMIT 1'
    )
    const bind = this.db.prepare(
      `INSERT OR IGNORE INTO problem_knowledge_points (problem_id, knowledge_point_id) VALUES (?, ?)`
    )
    let bound = 0
    const tx = this.db.transaction(() => {
      for (const [title, kpNames] of Object.entries(map)) {
        const problem = findProblem.get(title) as { id: string } | undefined
        if (!problem) continue
        for (const name of kpNames) {
          const kpId = nameToId.get(name)
          if (kpId === undefined) continue
          const res = bind.run(problem.id, kpId)
          bound += res.changes
        }
      }
    })
    tx()
    return bound
  }

  /** 按别名 tags 兜底映射（题目 tag/标题命中知识点别名即绑定；幂等） */
  mapProblemsByTags(problemIds?: string[]): number {
    const kps = this.listKnowledgePoints()
    const targets =
      problemIds ??
      (this.db.prepare('SELECT id FROM problems WHERE is_builtin = 1').all() as { id: string }[]).map((r) => r.id)
    const getProblem = this.db.prepare('SELECT title, tags FROM problems WHERE id = ?')
    const bind = this.db.prepare(
      `INSERT OR IGNORE INTO problem_knowledge_points (problem_id, knowledge_point_id) VALUES (?, ?)`
    )
    let bound = 0
    const tx = this.db.transaction(() => {
      for (const pid of targets) {
        const p = getProblem.get(pid) as { title: string; tags: string } | undefined
        if (!p) continue
        const tags = JSON.parse(p.tags) as string[]
        const haystack = [...tags, p.title].map((s) => s.toLowerCase())
        for (const kp of kps) {
          const hit = kp.tags.some((alias) => haystack.includes(alias.toLowerCase()))
          if (!hit) continue
          bound += bind.run(pid, kp.id).changes
        }
      }
    })
    tx()
    return bound
  }

  listPaths(): LearningPath[] {
    const rows = this.db.prepare('SELECT * FROM learning_paths ORDER BY sort_order, title').all() as PathRow[]
    return rows.map(rowToPath)
  }

  getPathBySlug(slug: string): LearningPath | null {
    const row = this.db.prepare('SELECT * FROM learning_paths WHERE slug = ?').get(slug) as PathRow | undefined
    return row ? rowToPath(row) : null
  }

  listStages(pathId: string): LearningStage[] {
    const rows = this.db
      .prepare('SELECT * FROM learning_stages WHERE path_id = ? ORDER BY sort_order')
      .all(pathId) as StageRow[]
    return rows.map(rowToStage)
  }

  listKnowledgePoints(stageId?: string): KnowledgePoint[] {
    const rows =
      stageId === undefined
        ? (this.db.prepare('SELECT * FROM knowledge_points ORDER BY stage_id, sort_order').all() as KpRow[])
        : (this.db
            .prepare('SELECT * FROM knowledge_points WHERE stage_id = ? ORDER BY sort_order')
            .all(stageId) as KpRow[])
    return rows.map(rowToKp)
  }

  getKnowledgePoint(id: string): KnowledgePoint | null {
    const row = this.db.prepare('SELECT * FROM knowledge_points WHERE id = ?').get(id) as KpRow | undefined
    return row ? rowToKp(row) : null
  }

  /** 绑定/解绑题目与知识点（幂等） */
  bindProblem(problemId: string, knowledgePointId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO problem_knowledge_points (problem_id, knowledge_point_id) VALUES (?, ?)`
      )
      .run(problemId, knowledgePointId)
  }

  unbindProblem(problemId: string, knowledgePointId: string): void {
    this.db
      .prepare(`DELETE FROM problem_knowledge_points WHERE problem_id = ? AND knowledge_point_id = ?`)
      .run(problemId, knowledgePointId)
  }

  /** 知识点绑定的题目 id 列表 */
  problemIdsForKp(kpId: string): string[] {
    return (
      this.db
        .prepare('SELECT problem_id FROM problem_knowledge_points WHERE knowledge_point_id = ?')
        .all(kpId) as { problem_id: string }[]
    ).map((r) => r.problem_id)
  }

  knowledgePointIdsForProblem(problemId: string): string[] {
    return (
      this.db
        .prepare('SELECT knowledge_point_id FROM problem_knowledge_points WHERE problem_id = ?')
        .all(problemId) as { knowledge_point_id: string }[]
    ).map((r) => r.knowledge_point_id)
  }

  /** 知识点搜索（搜索增强：名称匹配） */
  searchKnowledgePoints(keyword: string): KnowledgePoint[] {
    const like = `%${keyword.trim()}%`
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_points WHERE name LIKE ? ORDER BY sort_order`)
      .all(like) as KpRow[]
    return rows.map(rowToKp)
  }

  /** 事务包装（绑定批量操作原子性） */
  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn)
  }

  /** 一次聚合查询：每个知识点的绑定题目数与已通过题目数（accepted = 任一提交通过） */
  aggregateKpProgress(): { kp: string; total: number; accepted: number }[] {
    return this.db
      .prepare(
        `SELECT pkp.knowledge_point_id AS kp,
                COUNT(DISTINCT p.id) AS total,
                COUNT(DISTINCT CASE WHEN acc.problem_id IS NOT NULL THEN p.id END) AS accepted
         FROM problem_knowledge_points pkp
         JOIN problems p ON p.id = pkp.problem_id
         LEFT JOIN (SELECT DISTINCT problem_id FROM submissions WHERE status = 'accepted') acc
           ON acc.problem_id = p.id
         GROUP BY pkp.knowledge_point_id`
      )
      .all() as { kp: string; total: number; accepted: number }[]
  }

  /** 知识点下题目明细（含通过状态与尝试次数），供路线页展开 */
  problemsForKp(kpId: string): {
    id: string
    title: string
    difficulty: string
    accepted: boolean
    attempts: number
  }[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.difficulty,
                CASE WHEN acc.problem_id IS NOT NULL THEN 1 ELSE 0 END AS accepted_int,
                COALESCE(att.attempts, 0) AS attempts
         FROM problem_knowledge_points pkp
         JOIN problems p ON p.id = pkp.problem_id
         LEFT JOIN (SELECT DISTINCT problem_id FROM submissions WHERE status = 'accepted') acc
           ON acc.problem_id = p.id
         LEFT JOIN (SELECT problem_id, COUNT(*) AS attempts FROM submissions GROUP BY problem_id) att
           ON att.problem_id = p.id
         WHERE pkp.knowledge_point_id = ?
         ORDER BY p.created_at`
      )
      .all(kpId) as { id: string; title: string; difficulty: string; accepted_int: number; attempts: number }[]
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      difficulty: r.difficulty,
      accepted: r.accepted_int === 1,
      attempts: r.attempts
    }))
  }
}
