import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { problemInputSchema } from '@shared/schemas'
import type { ProblemInput } from '@shared/types'

/**
 * 种子题库：首次启动（题库为空）时灌入（FR-P6）。
 * JSON 文件位置由调用方解析（dev 为项目 resources/，打包后为 process.resourcesPath）。
 * 注意：种子文件是内部资源，格式为 { problems: [...] }，与导出信封格式不同。
 */

const seedFileSchema = z.object({
  problems: z.array(problemInputSchema).min(1)
})

export function loadSeedProblems(seedFile: string): ProblemInput[] {
  if (!existsSync(seedFile)) {
    // 种子文件缺失不视为致命错误：题库仍可用
    return []
  }
  const raw = JSON.parse(readFileSync(seedFile, 'utf-8')) as unknown
  return seedFileSchema.parse(raw).problems
}

export function resolveSeedFile(isPackaged: boolean, appPath: string, resourcesPath: string): string {
  return isPackaged ? join(resourcesPath, 'seed-problems.json') : join(appPath, 'resources', 'seed-problems.json')
}
