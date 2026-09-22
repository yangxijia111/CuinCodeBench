import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { logger } from '../lib/logger'
import type { LearningRepository, LearningPathSeed } from '../db/repositories/learning-repository'

/**
 * 内置学习路线种子（docs/V1_2_LEARNING_MODEL.md §3）：
 * 首次升级到 v1.2 时幂等灌入「C 基础」路线，并把内置旧题一次性映射到知识点
 * （settings 标记 learning_v2_mapped，见 SettingsRepository）。
 *
 * v1.2.1（P0-B）：marker 只在真正灌入成功后标记；失败（文件损坏/校验不过/DB 错误）
 * 与文件缺失都不标记——「下次启动重试」语义真实成立。
 */

const slugPattern = /^[a-z0-9-]+$/

const learningSeedSchema = z.object({
  // v2（v1.2.1 P1）：稳定语义 ID——stage/kp 各自携带 slug，数组顺序只决定展示排序
  seedVersion: z.literal(2),
  path: z.object({
    slug: z.string().min(1).max(50).regex(slugPattern, 'slug 仅允许小写字母/数字/连字符'),
    title: z.string().min(1).max(100),
    description: z.string().max(2_000)
  }),
  stages: z
    .array(
      z.object({
        slug: z.string().min(1).max(50).regex(slugPattern, 'slug 仅允许小写字母/数字/连字符'),
        title: z.string().min(1).max(100),
        description: z.string().max(2_000),
        knowledgePoints: z
          .array(
            z.object({
              slug: z.string().min(1).max(50).regex(slugPattern, 'slug 仅允许小写字母/数字/连字符'),
              name: z.string().min(1).max(50),
              description: z.string().max(2_000),
              tags: z.array(z.string().min(1).max(30)).max(20)
            })
          )
          .min(1)
      })
    )
    .min(1),
  builtinProblemMap: z.record(z.string().max(200), z.array(z.string().min(1).max(50)).max(10))
})

export function loadLearningPathSeed(seedFile: string): LearningPathSeed | null {
  // 种子文件缺失不视为致命错误（与题库种子一致）：路线为空但应用可用
  if (!existsSync(seedFile)) return null
  const raw = JSON.parse(readFileSync(seedFile, 'utf-8')) as unknown
  return learningSeedSchema.parse(raw)
}

export function resolveLearningSeedFile(
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string
): string {
  return isPackaged
    ? join(resourcesPath, 'seed-learning-path.json')
    : join(appPath, 'resources', 'seed-learning-path.json')
}

/**
 * 升级灌入入口（幂等，失败不阻塞启动）：
 * 1) 位置型 → 稳定语义 ID 迁移（v1.2 老库，单事务，无引用则跳过）；
 * 2) upsert 内置路线（新增插入 / 已存在更新内容与排序）；
 * 3) 显式映射内置题；4) tag 别名兜底映射。
 */
export function ensureLearningSeed(db: LearningRepository, seed: LearningPathSeed): void {
  const renamed = db.migrateBuiltinContentIds(seed)
  db.ensureBuiltinPath(seed)
  const explicit = db.mapBuiltinProblems(seed.builtinProblemMap, seed.path.slug)
  const byTags = db.mapProblemsByTags()
  logger.info(
    '学习路线已就绪',
    `stages=${seed.stages.length} id迁移(阶段/知识点)=${renamed.stagesRenamed}/${renamed.kpsRenamed} 映射(显式/别名)=${explicit}/${byTags}`
  )
}

/** seed 步骤的三种终态 */
export type LearningSeedOutcome =
  /** 灌入成功（或 marker 已存在跳过） */
  | 'seeded'
  /** 种子文件缺失：跳过本次，下次启动再试 */
  | 'missing'
  /** 灌入失败：不标记 marker，下次启动重试 */
  | 'failed'

/** marker 语义的最小接口（结构化类型，避免与 services 层循环依赖） */
export interface SeedMarkerStore {
  hasMarker(key: string): boolean
  markMarker(key: string): void
}

/**
 * 启动步骤封装（v1.2.1 P0-B）：marker 只在成功后标记。
 * - marker 已存在 → 直接 seeded（跳过）
 * - 文件缺失 → missing（不标记，下次重试；打包异常时不应永久放弃）
 * - 任一异常 → failed（不标记，下次启动真实重试）
 */
export function runLearningSeedStep(
  settings: SeedMarkerStore,
  repo: LearningRepository,
  markerKey: string,
  seedFile: string
): LearningSeedOutcome {
  if (settings.hasMarker(markerKey)) return 'seeded'
  try {
    const seed = loadLearningPathSeed(seedFile)
    if (seed === null) {
      logger.warn('学习路线种子文件缺失，下次启动重试', seedFile)
      return 'missing'
    }
    ensureLearningSeed(repo, seed)
    settings.markMarker(markerKey)
    return 'seeded'
  } catch (err) {
    logger.error('学习路线灌入失败（下次启动重试）', err instanceof Error ? err.stack : String(err))
    return 'failed'
  }
}

/** 便捷封装：解析 + 灌入（文件缺失时静默跳过；异常向上抛出由调用方决定重试语义） */
export function ensureLearningSeedFromFile(
  repo: LearningRepository,
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string
): void {
  const seedFile = resolveLearningSeedFile(isPackaged, appPath, resourcesPath)
  const seed = loadLearningPathSeed(seedFile)
  if (seed !== null) ensureLearningSeed(repo, seed)
  else logger.warn('学习路线种子文件缺失', seedFile)
}
