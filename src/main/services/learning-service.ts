import type Database from 'better-sqlite3'
import type { KnowledgePointProgress, MasteryInfo, PathProgress, StageProgress } from '@shared/types'
import { LearningRepository } from '../db/repositories/learning-repository'
import { AppError } from '../lib/app-error'

/**
 * 学习路线服务（docs/V1_2_LEARNING_MODEL.md）：
 * 路径/阶段/知识点聚合进度展示；题目↔知识点绑定（变更后由判题流重算掌握度）。
 * 掌握度展示依赖注入的读取器（v1.2.1 P1-B 起为 effective 视图——45 天无活动
 * mastered 读作 familiar；结构化类型，仓储与 effective 视图均可注入）。
 */

interface KpProgressRow {
  kp: string
  total: number
  accepted: number
}

export interface MasteryReader {
  get(knowledgePointId: string): MasteryInfo | null
}

export class LearningService {
  private readonly repo: LearningRepository
  private readonly mastery: MasteryReader | null

  constructor(db: Database.Database, deps: { mastery?: MasteryReader } = {}) {
    this.repo = new LearningRepository(db)
    this.mastery = deps.mastery ?? null
  }

  listPaths(): PathProgress[] {
    return this.repo.listPaths().map((p) => this.getPathProgress(p.id))
  }

  /** 单条路线的完整进度（阶段 → 知识点 → 完成度/掌握度） */
  getPathProgress(pathId: string): PathProgress {
    const path = this.repo.listPaths().find((p) => p.id === pathId)
    if (path === undefined) throw new AppError('not_found', `学习路线不存在: ${pathId}`)

    // 一次聚合查询：每个知识点的题目数与已通过题目数（无 N+1）
    const rows = this.repo.aggregateKpProgress() as KpProgressRow[]
    const byKp = new Map(rows.map((r) => [r.kp, r]))

    const stages: StageProgress[] = this.repo.listStages(path.id).map((stage) => {
      const kps: KnowledgePointProgress[] = this.repo.listKnowledgePoints(stage.id).map((kp) => {
        const r = byKp.get(kp.id)
        return {
          knowledgePoint: kp,
          totalProblems: r?.total ?? 0,
          acceptedProblems: r?.accepted ?? 0,
          mastery: this.mastery?.get(kp.id) ?? null
        }
      })
      return {
        ...stage,
        knowledgePoints: kps,
        totalProblems: kps.reduce((n, k) => n + k.totalProblems, 0),
        acceptedProblems: kps.reduce((n, k) => n + k.acceptedProblems, 0)
      }
    })

    return {
      ...path,
      stages,
      totalProblems: stages.reduce((n, s) => n + s.totalProblems, 0),
      acceptedProblems: stages.reduce((n, s) => n + s.acceptedProblems, 0)
    }
  }

  /** 知识点下的题目列表（含通过状态，供路线页展开与专项训练） */
  listKpProblems(kpId: string): {
    id: string
    title: string
    difficulty: string
    accepted: boolean
    attempts: number
  }[] {
    const kp = this.repo.getKnowledgePoint(kpId)
    if (kp === null) throw new AppError('not_found', `知识点不存在: ${kpId}`)
    return this.repo.problemsForKp(kpId)
  }

  bindProblem(problemId: string, knowledgePointIds: string[]): void {
    const tx = this.repo.transaction(() => {
      for (const kpId of knowledgePointIds) {
        if (this.repo.getKnowledgePoint(kpId) === null) {
          throw new AppError('not_found', `知识点不存在: ${kpId}`)
        }
        this.repo.bindProblem(problemId, kpId)
      }
    })
    tx()
  }

  unbindProblem(problemId: string, knowledgePointId: string): void {
    this.repo.unbindProblem(problemId, knowledgePointId)
  }

  knowledgePointIdsForProblem(problemId: string): string[] {
    return this.repo.knowledgePointIdsForProblem(problemId)
  }

  /** 知识点搜索（搜索增强用） */
  searchKnowledgePoints(keyword: string) {
    return this.repo.searchKnowledgePoints(keyword)
  }
}
