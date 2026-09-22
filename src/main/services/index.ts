import type Database from 'better-sqlite3'
import { problemInputSchema, problemImportEnvelopeSchema } from '@shared/schemas'
import type {
  AppSettings,
  LanguageId,
  Problem,
  ProblemInput,
  ProblemQuery,
  ProblemStats
} from '@shared/types'
import { ProblemRepository, type ProblemWithCases } from '../db/repositories/problem-repository'
import { HistoryRepository } from '../db/repositories/history-repository'
import { MistakeRepository } from '../db/repositories/mistake-repository'
import { SettingsRepository } from '../db/repositories/settings-repository'
import { StatsRepository } from '../db/repositories/stats-repository'
import { LearningRepository } from '../db/repositories/learning-repository'
import { MasteryRepository } from '../db/repositories/mastery-repository'
import { LearningService } from './learning-service'
import { MasteryService } from './mastery-service'
import { ReviewService } from './review-service'
import { MistakeReviewService } from './mistake-review-service'
import { AppError } from '../lib/app-error'

/**
 * 题库服务：CRUD / 搜索筛选 / JSON 导入导出（FR-P1–P5）。
 * 校验经 zod（shared/schemas），领域错误用 AppError 表达。
 */

/** 导出信封（docs/DATA_SPEC.md §3） */
export interface ExportEnvelope {
  format: 'cuincodebench.problems'
  version: 1
  exportedAt: number
  problems: (ProblemInput & { id: string; isBuiltin: boolean })[]
}

export class ProblemService {
  constructor(private readonly repo: ProblemRepository) {}

  list(query: ProblemQuery): Problem[] {
    return this.repo.list(query)
  }

  get(id: string): ProblemWithCases | null {
    return this.repo.getById(id)
  }

  create(input: unknown, isBuiltin = false): ProblemWithCases {
    const parsed = problemInputSchema.parse(input)
    return this.repo.create(parsed, isBuiltin)
  }

  update(id: string, input: unknown): ProblemWithCases {
    const parsed = problemInputSchema.parse(input)
    return this.repo.update(id, parsed)
  }

  remove(id: string): void {
    this.repo.delete(id)
  }

  listTags(): string[] {
    return this.repo.listTags()
  }

  /** 导出：null 表示全部题目 */
  exportJson(problemIds: string[] | null): string {
    const all = problemIds ?? this.repo.list({ keyword: '', difficulty: 'all', tag: 'all' }).map((p) => p.id)
    const problems = all
      .map((id) => this.repo.getById(id))
      .filter((p): p is ProblemWithCases => p !== null)
      .map((p) => this.toExportProblem(p))
    const envelope: ExportEnvelope = {
      format: 'cuincodebench.problems',
      version: 1,
      exportedAt: Date.now(),
      problems
    }
    return JSON.stringify(envelope, null, 2)
  }

  private toExportProblem(p: ProblemWithCases): ExportEnvelope['problems'][number] {
    return {
      id: p.id,
      isBuiltin: p.isBuiltin,
      title: p.title,
      description: p.description,
      difficulty: p.difficulty,
      tags: p.tags,
      inputDesc: p.inputDesc,
      outputDesc: p.outputDesc,
      samples: p.samples,
      initialCode: p.initialCode,
      testCases: p.testCases.map((tc) => ({
        stdin: tc.stdin,
        expectedStdout: tc.expectedStdout,
        timeoutMs: tc.timeoutMs
      }))
    }
  }

  /** 导入：校验信封与每题结构，全部合法后单事务落库（任一题失败整体回滚） */
  importJson(jsonText: string): { imported: number } {
    let raw: unknown
    try {
      raw = JSON.parse(jsonText)
    } catch {
      throw new AppError('validation', 'JSON 解析失败：不是合法的 JSON 文本')
    }
    const envelope = problemImportEnvelopeSchema.parse(raw)
    this.repo.createMany(envelope.problems, false)
    return { imported: envelope.problems.length }
  }

  count(): number {
    return this.repo.count()
  }
}

/**
 * 设置服务（P2 起供编辑器使用）。
 */
export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  get(): AppSettings {
    return this.repo.get()
  }

  update(patch: Partial<AppSettings>): AppSettings {
    return this.repo.update(patch)
  }

  hasSeeded(): boolean {
    return this.repo.hasSeeded()
  }

  markSeeded(): void {
    this.repo.markSeeded()
  }

  /** 通用一次性标记（v1.2 升级灌入用） */
  hasMarker(key: string): boolean {
    return this.repo.hasMarker(key)
  }

  markMarker(key: string): void {
    this.repo.markMarker(key)
  }
}

/**
 * 服务容器：main 进程单例。
 */
export interface ServiceContext {
  db: Database.Database
  problems: ProblemService
  settings: SettingsService
  history: HistoryRepository
  mistakes: MistakeRepository
  stats: StatsRepository
  /** v1.2：学习路线服务（掌握度注入后由 P3 重算联动） */
  learning: LearningService
  /** v1.2：学习路线仓储（种子灌入等底层访问） */
  learningRepo: LearningRepository
  /** v1.2：掌握度仓储（mastery-service 于 P3 在此之上实现） */
  mastery: MasteryRepository
  /** v1.2：掌握度服务（判题落库后重算 hook） */
  masterySvc: MasteryService
  /** v1.2：间隔复习服务 */
  reviewSvc: ReviewService
  /** v1.2：错题复盘服务（错误历史/笔记/学习分类） */
  mistakeReview: MistakeReviewService
  /** 语言列表便捷访问 */
  languages: LanguageId[]
  /** 每题统计 */
  problemStats: (problemId: string) => ProblemStats
}

let ctx: ServiceContext | null = null

export function initServices(db: Database.Database): ServiceContext {
  const problems = new ProblemService(new ProblemRepository(db))
  const masteryRepo = new MasteryRepository(db)
  const masterySvc = new MasteryService({
    mastery: masteryRepo,
    learning: new LearningRepository(db)
  })
  const reviewSvc = new ReviewService(db)
  // 复习完成 → 受影响知识点掌握度重算（桥接，避免循环依赖）
  reviewSvc.masteryRecalc = (kpId, now) => masterySvc.recalc(kpId, now)
  ctx = {
    db,
    problems,
    settings: new SettingsService(new SettingsRepository(db)),
    history: new HistoryRepository(db),
    mistakes: new MistakeRepository(db),
    stats: new StatsRepository(db),
    learning: new LearningService(db, { mastery: masteryRepo }),
    learningRepo: new LearningRepository(db),
    mastery: masteryRepo,
    masterySvc,
    reviewSvc,
    mistakeReview: new MistakeReviewService(db),
    languages: ['c', 'cpp', 'python'],
    problemStats: (problemId) => new HistoryRepository(db).getProblemStats(problemId)
  }
  return ctx
}

export function getServices(): ServiceContext {
  if (!ctx) throw new Error('服务未初始化（initServices 未调用）')
  return ctx
}

/** 应用退出时显式关闭数据库（WAL 检查点落地；H8） */
export function closeServices(): void {
  if (ctx !== null) {
    try {
      ctx.db.close()
    } finally {
      ctx = null
    }
  }
}
