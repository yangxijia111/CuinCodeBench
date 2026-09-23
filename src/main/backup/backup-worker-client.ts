import { Worker } from 'worker_threads'
import { existsSync } from 'fs'
import { join } from 'path'
import { AppError } from '../lib/app-error'
import {
  runJob,
  type BackupJob,
  type BackupJobResult
} from './backup-worker'

/**
 * worker 客户端（docs/V1_3_BACKUP_V2_SPEC.md §4）：
 * - worker 文件存在（打包/dev 构建产物）→ worker_threads 执行；
 * - 文件缺失（vitest 直跑 src 等场景）→ inline 执行同一 runJob（行为一致）；
 * - 进度回调 + 协作式取消 + worker 异常退出清理。
 */

export interface RunJobOptions {
  onProgress?: (p: { phase: string; processed: number; total: number }) => void
}

export interface RunningJob {
  promise: Promise<BackupJobResult>
  cancel: () => void
}

/** worker bundle 路径（electron-vite 多入口产物 out/main/backup-worker.js） */
function workerScriptPath(): string | null {
  const p = join(__dirname, 'backup-worker.js')
  return existsSync(p) ? p : null
}

export function isWorkerAvailable(): boolean {
  return workerScriptPath() !== null
}

export function startJob(job: BackupJob, opts: RunJobOptions = {}): RunningJob {
  const script = workerScriptPath()
  if (script === null) {
    // inline 降级：同一 runJob 在当前线程执行（测试/异常环境）。
    // 先 yield 一拍再执行：与 worker 的异步启动语义一致，否则同步执行会
    // 在调用方拿到 RunningJob 之前跑完，cancel() 永远迟到
    let cancelled = false
    const promise = new Promise<BackupJobResult>((resolveJob, rejectJob) => {
      setImmediate(() => {
        runJob(job, (msg) => opts.onProgress?.(msg), () => cancelled).then(resolveJob, rejectJob)
      })
    }).catch((err: unknown) => {
      if (cancelled) {
        throw new AppError('cancelled', '操作已取消')
      }
      throw err instanceof Error ? err : new Error(String(err))
    })
    return { promise, cancel: () => { cancelled = true } }
  }

  let worker: Worker | null = new Worker(script, { workerData: job })
  let cancelledByUser = false
  const promise = new Promise<BackupJobResult>((resolve, reject) => {
    worker?.on('message', (msg: { type?: string; phase?: string; processed?: number; total?: number; result?: BackupJobResult; message?: string }) => {
      if (msg.type === 'progress') {
        opts.onProgress?.({ phase: msg.phase ?? '', processed: msg.processed ?? 0, total: msg.total ?? 0 })
        return
      }
      if (msg.type === 'done') {
        resolve(msg.result ?? {})
        return
      }
      if (msg.type === 'error') {
        reject(new AppError(cancelledByUser ? 'cancelled' : 'internal', msg.message ?? '备份任务失败'))
      }
    })
    worker?.on('error', (err: Error) => {
      reject(new AppError('internal', `备份工作线程异常：${err.message}`))
    })
    worker?.on('exit', () => {
      worker = null
      if (cancelledByUser) {
        reject(new AppError('cancelled', '操作已取消'))
        return
      }
      // 非正常退出且没有提前 resolve/reject：worker 崩溃
      setImmediate(() => {
        reject(new AppError('internal', '备份工作线程异常退出，正式数据未改动'))
      })
    })
  })
  // 正常完成后显式终止引用（exit 已发生，防御性调用避免悬挂句柄）
  void promise
    .catch(() => {})
    .finally(() => {
      if (worker !== null) {
        worker.terminate().catch(() => {})
        worker = null
      }
    })
  return {
    promise,
    cancel: () => {
      cancelledByUser = true
      worker?.postMessage({ type: 'cancel' })
    }
  }
}
