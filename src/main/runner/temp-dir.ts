import { mkdir, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { TEMP_ROOT_NAME } from '@shared/constants'

/**
 * 临时工作目录：每次运行独立目录，结束后清理（FR-R4 / SECURITY §3.4）。
 * Windows 文件锁：删除失败延迟重试（WIN-5）。
 */

const RM_MAX_RETRIES = 5
const RM_RETRY_DELAY_MS = 150

/** 临时目录根：os.tmpdir()/cuincodebench */
export function tempRoot(): string {
  return join(tmpdir(), TEMP_ROOT_NAME)
}

/** 在独立临时目录中执行任务；无论成败均清理 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tempRoot(), randomUUID())
  await mkdir(dir, { recursive: true })
  try {
    return await fn(dir)
  } finally {
    await removeDirWithRetry(dir)
  }
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= RM_MAX_RETRIES; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return
    } catch (err) {
      if (attempt === RM_MAX_RETRIES) {
        // 清理失败不阻塞业务，仅记录（目录位于系统临时区，系统会兜底回收）
        console.warn(`[temp-dir] 清理失败（放弃）: ${dir}`, err instanceof Error ? err.message : err)
        return
      }
      await sleep(RM_RETRY_DELAY_MS * attempt)
    }
  }
}

/** 启动时清扫上次运行遗留的临时目录（进程被强杀时的残留） */
export async function cleanLegacyTempDirs(): Promise<number> {
  const root = tempRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    await removeDirWithRetry(join(root, entry))
    removed++
  }
  return removed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
