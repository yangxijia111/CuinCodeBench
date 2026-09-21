import type Database from 'better-sqlite3'
import type { KnowledgePoint, LearningPath, LearningStage } from '@shared/types'

/**
 * 学习路线仓储：内置路线幂等灌入、题目↔知识点绑定、进度聚合（docs/V1_2_LEARNING_MODEL.md）。
 * 内置数据使用确定性 id（slug/索引派生），重启与备份恢复后幂等不冲突。
 */

/** seed-learning-path.json 的内存结构（schema 校验见 learning-seed.ts） */
export interface LearningPathSeed {
  path: { slug: string; title: string; description: string }
  stages: {
    title: string
    description: string
    knowledgePoints: { name: string; description: string; tags: string[] }[]
  }[]
  /** 内置题目标题 → 知识点名列表（一次性映射） */
  builtinProblemMap: Record<string, string[]>
}

/** 内置数据的确定性 id 约定（导出/恢复保持一致） */
export function builtinPathId(slug: string): string {
  return `lp:${slug}`
}
export function builtinStageId(slug: string, stageIndex: number): string {
  return `ls:${slug}:${stageIndex}`
}
export function builtinKpId(slug: string, stageIndex: number, kpIndex: number): string {
  return `kp:${slug}:${stageIndex}:${kpIndex}`
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

  /** 幂等灌入一条内置路线（含阶段与知识点），存在即跳过 */
  ensureBuiltinPath(seed: LearningPathSeed): void {
    const tx = this.db.transaction(() => {
      const pathId = builtinPathId(seed.path.slug)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO learning_paths (id, slug, title, description, is_builtin, sort_order)
           VALUES (?, ?, ?, ?, 1, 0)`
        )
        .run(pathId, seed.path.slug, seed.path.title, seed.path.description)
      const insStage = this.db.prepare(
        `INSERT OR IGNORE INTO learning_stages (id, path_id, title, description, sort_order)
         VALUES (?, ?, ?, ?, ?)`
      )
      const insKp = this.db.prepare(
        `INSERT OR IGNORE INTO knowledge_points (id, stage_id, name, description, sort_order, tags)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      seed.stages.forEach((stage, si) => {
        const stageId = builtinStageId(seed.path.slug, si)
        insStage.run(stageId, pathId, stage.title, stage.description, si)
        stage.knowledgePoints.forEach((kp, ki) => {
          insKp.run(builtinKpId(seed.path.slug, si, ki), stageId, kp.name, kp.description, ki, JSON.stringify(kp.tags))
        })
      })
    })
    tx()
  }

  /** 内置题目按显式映射绑定知识点（标题匹配 is_builtin=1 的题；幂等） */
  mapBuiltinProblems(map: Record<string, string[]>): number {
    const nameToId = new Map<string, string>()
    for (const row of this.db
      .prepare(
        `SELECT k.id, k.name FROM knowledge_points k
         JOIN learning_stages s ON s.id = k.stage_id
         JOIN learning_paths p ON p.id = s.path_id
         WHERE p.slug = 'c-basics'`
      )
      .all() as { id: string; name: string }[]) {
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
}
