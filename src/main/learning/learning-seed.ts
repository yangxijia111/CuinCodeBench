import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { logger } from '../lib/logger'
import type { LearningRepository, LearningPathSeed } from '../db/repositories/learning-repository'

/**
 * 内置学习路线种子（docs/V1_2_LEARNING_MODEL.md §3）：
 * 首次升级到 v1.2 时幂等灌入「C 基础」路线，并把内置旧题一次性映射到知识点
 * （settings 标记 learning_v2_mapped，见 SettingsRepository）。
 */

const learningSeedSchema = z.object({
  path: z.object({
    slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'slug 仅允许小写字母/数字/连字符'),
    title: z.string().min(1).max(100),
    description: z.string().max(2_000)
  }),
  stages: z
    .array(
      z.object({
        title: z.string().min(1).max(100),
        description: z.string().max(2_000),
        knowledgePoints: z
          .array(
            z.object({
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
 * 1) 灌入内置路线；2) 显式映射内置题；3) tag 别名兜底映射。
 */
export function ensureLearningSeed(db: LearningRepository, seed: LearningPathSeed): void {
  db.ensureBuiltinPath(seed)
  const explicit = db.mapBuiltinProblems(seed.builtinProblemMap)
  const byTags = db.mapProblemsByTags()
  logger.info('学习路线已就绪', `stages=${seed.stages.length} 映射(显式/别名)=${explicit}/${byTags}`)
}

/** 便捷封装：解析 + 灌入（文件缺失时静默跳过） */
export function ensureLearningSeedFromFile(
  repo: LearningRepository,
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string
): void {
  const seedFile = resolveLearningSeedFile(isPackaged, appPath, resourcesPath)
  const seed = loadLearningPathSeed(seedFile)
  if (seed !== null) ensureLearningSeed(repo, seed)
}
