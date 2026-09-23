import { createHash } from 'crypto'
import { createReadStream, readdirSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from 'fs'
import Database from 'better-sqlite3'
import { join } from 'path'
import { openDatabase, currentVersion } from '../db/connection'
import { MIGRATIONS } from '../db/migrations'
import { initServices, closeServices, getServices } from '../services'
import { startJob, type RunningJob } from './backup-worker-client'
import { detectBackupFormat } from './backup-v2-format'
import { logger } from '../lib/logger'
import { AppError } from '../lib/app-error'

/**
 * 恢复协调器（docs/V1_3_BACKUP_V2_SPEC.md §5）：
 * staging（worker 内导入+校验）→ 文件级原子 swap → journal 自愈 → 维护模式。
 *
 * 不变量：
 * - 任意崩溃时刻，正式路径上要么是完整旧库要么是完整新库（rename 原子 + journal 状态表）；
 * - 旧库在恢复完全成功前绝不删除（.bak 回滚路径）；
 * - 维护模式期间业务 IPC 一律拒绝（ipc gate），UI 显示恢复中。
 */

// ============================================================
// 维护模式（ipc gate 消费）
// ============================================================
let maintenanceMode = false

export function isMaintenanceMode(): boolean {
  return maintenanceMode
}

/** 维护模式下仍放行的通道（备份自身 + 只读应用信息） */
const MAINTENANCE_ALLOWLIST = new Set([
  'backup.export',
  'backup.importPreview',
  'backup.confirmRestore',
  'backup.cancelImport',
  'backup.getRestoreStatus',
  'app.getInfo'
])

export function checkMaintenanceAllowed(channel: string): void {
  if (maintenanceMode && !MAINTENANCE_ALLOWLIST.has(channel)) {
    throw new AppError('busy', '正在恢复数据，请稍候（恢复完成后页面将自动刷新）')
  }
}

// ============================================================
// 恢复状态（renderer 轮询；避免 preload 事件通道）
// ============================================================
interface RestoreStatus {
  restoring: boolean
  phase: string
  processed: number
  total: number
}

let status: RestoreStatus = { restoring: false, phase: '', processed: 0, total: 0 }

export function getRestoreStatus(): RestoreStatus {
  return { ...status }
}

function updateStatus(phase: string, processed = 0, total = 0): void {
  status = { restoring: true, phase, processed, total }
}

// ============================================================
// restore journal（崩溃自愈，spec §5.3）
// ============================================================
type JournalPhase = 'swap-start' | 'swapped'

interface RestoreJournal {
  phase: JournalPhase
  dbPath: string
  bakPath: string
  stagingPath: string
  startedAt: number
}

function journalPath(dataDir: string): string {
  return join(dataDir, 'restore-state.json')
}

function writeJournal(dataDir: string, journal: RestoreJournal): void {
  writeFileSync(journalPath(dataDir), JSON.stringify(journal, null, 2), 'utf8')
}

function readJournal(dataDir: string): RestoreJournal | null {
  const p = journalPath(dataDir)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RestoreJournal
  } catch {
    // journal 损坏：当作无 journal（保守：保留现场，仅告警）
    logger.warn('restore journal 损坏，跳过自愈（保留现场）', p)
    return null
  }
}

function dbIntact(dbPath: string): boolean {
  // 注意：不能用 openDatabase（WAL pragma/migrations 会在非 SQLite 文件上抛错且
  // 泄漏内部句柄）——用原始只读连接校验，句柄在本函数内确定性地关闭
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const ok = db.pragma('integrity_check', { simple: true })
    return ok === 'ok'
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      // 未成功打开
    }
  }
}

/**
 * 启动时自愈（docs §5.3 状态表）。返回是否执行了恢复动作（供日志/测试断言）。
 */
export function recoverRestoreJournal(dataDir: string): string | null {
  const journal = readJournal(dataDir)
  if (journal === null) {
    cleanupStaleFiles(dataDir)
    return null
  }
  logger.warn('发现未完成的恢复流程，执行自愈', JSON.stringify(journal))
  const { dbPath, bakPath, stagingPath } = journal

  if (journal.phase === 'swap-start') {
    // A（db→bak）与 B（staging→db）之间崩溃：正式路径缺失 → 回滚 .bak
    if (!existsSync(dbPath) && existsSync(bakPath)) {
      renameSync(bakPath, dbPath)
      logger.info('自愈完成：旧库已还原', dbPath)
    } else if (existsSync(dbPath) && existsSync(bakPath)) {
      // rename db→bak 完成但 staging rename 之前出现了 dbPath？——不可能态，保守还原旧库
      if (dbIntact(bakPath)) {
        rmSync(dbPath, { force: true })
        renameSync(bakPath, dbPath)
        logger.info('自愈完成（歧义态按旧库还原）', dbPath)
      }
    }
  } else if (journal.phase === 'swapped') {
    // 已换库：正式库完整 → 收尾（删 .bak / staging）；损坏 → 回滚旧库
    if (existsSync(dbPath) && dbIntact(dbPath)) {
      logger.info('自愈完成：新库完整，清理备份', dbPath)
      try {
        if (existsSync(bakPath)) rmSync(bakPath, { force: true })
      } catch {
        // .bak 清理失败只告警
      }
    } else if (existsSync(bakPath)) {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true })
      renameSync(bakPath, dbPath)
      logger.info('自愈完成：新库损坏，已还原旧库', dbPath)
    }
  }
  // staging 残留清理
  for (const f of [stagingPath, `${stagingPath}-wal`, `${stagingPath}-shm`]) {
    try {
      if (existsSync(f)) rmSync(f, { force: true })
    } catch {
      // 尽力而为
    }
  }
  try {
    unlinkSync(journalPath(dataDir))
  } catch {
    // 尽力而为
  }
  cleanupStaleFiles(dataDir)
  return journal.phase
}

/** >24h 的 staging/.bak 残留清理（防泄漏；新近文件可能是用户手动保留物，不动） */
export function cleanupStaleFiles(dataDir: string): number {
  let removed = 0
  const DAY_MS = 86_400_000
  let entries: string[]
  try {
    entries = readdirSync(dataDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const isStaging = /^restore-staging-\d+\.sqlite($|-wal$|-shm$)/.test(entry)
    const isBak = /^cuincodebench\.db\.bak-\d{4}-\d{2}-\d{2}T/.test(entry)
    if (!isStaging && !isBak) continue
    const full = join(dataDir, entry)
    try {
      if (Date.now() - statSync(full).mtimeMs > DAY_MS) {
        rmSync(full, { force: true })
        removed++
      }
    } catch {
      // 尽力而为
    }
  }
  return removed
}

// ============================================================
// 恢复编排
// ============================================================

export interface PendingRestore {
  path: string
  kind: 'v1' | 'v2'
  fileSha256: string
  summary: {
    createdAt: number
    appVersion: string | null
    counts: Record<string, number>
  }
}

export interface RestoreDeps {
  dataDir: string
  appVersion: string
  /** 当前库文件路径 */
  dbPath: string
  /** 恢复成功后的 UI 通知（renderer reload）；由 ipc 层注入（有 electron 上下文） */
  onRestored?: () => void
  /** 恢复后的内置内容迁移（seed 重跑；依赖 app 路径上下文，由 ipc 层注入） */
  postRestoreMigrate?: () => void
}

export interface RestoreProgress {
  phase: string
  processed: number
  total: number
}

let pending: PendingRestore | null = null
let activeJob: RunningJob | null = null
let restoring = false

export function setPendingRestore(p: PendingRestore | null): void {
  pending = p
}

export function getPendingRestore(): PendingRestore | null {
  return pending
}

export function cancelPendingRestore(): void {
  activeJob?.cancel()
  pending = null
}

export function isRestoring(): boolean {
  return restoring
}

/** 选择备份文件后的 preview 校验（worker/inline）。返回摘要并缓存 pending。 */
export async function previewRestore(
  filePath: string,
  opts: { onProgress?: (p: RestoreProgress) => void } = {}
): Promise<PendingRestore> {
  const head = readFileSync(filePath).subarray(0, 4096)
  const detected = detectBackupFormat(head)
  if (detected.kind === 'unknown') {
    throw new AppError('validation', detected.reason)
  }
  const kind = detected.kind
  // 全文件流式 hash（防调包基准；分块恒定内存）
  const fileSha256 = await new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath)
    const hash = createHash('sha256')
    stream.on('data', (c: Buffer) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
  const job = startJob(
    { kind: 'preview', filePath, backupKind: kind },
    { onProgress: (p) => opts.onProgress?.(p) }
  )
  activeJob = job
  try {
    const result = await job.promise
    const preview = result.preview
    if (preview === undefined) throw new AppError('internal', '备份预览失败：未知结果')
    const pendingRestore: PendingRestore = {
      path: filePath,
      kind,
      fileSha256,
      summary: {
        createdAt: preview.summary.createdAt,
        appVersion: preview.summary.appVersion,
        counts: preview.summary.counts
      }
    }
    pending = pendingRestore
    return pendingRestore
  } finally {
    activeJob = null
  }
}

/**
 * 确认恢复：staging（worker）→ 原子 swap → reopen → smoke → 清理。
 * 任一失败：回滚 rename + 重开旧库 + 解除维护模式（正式数据不丢）。
 */
export async function confirmRestore(
  deps: RestoreDeps,
  opts: { onProgress?: (p: RestoreProgress) => void } = {}
): Promise<{ counts: Record<string, number> }> {
  const current = pending
  if (current === null) {
    throw new AppError('validation', '没有待恢复的备份：请重新选择备份文件')
  }
  if (restoring) {
    throw new AppError('busy', '恢复正在进行中')
  }
  restoring = true
  maintenanceMode = true
  const bakPath = join(deps.dataDir, `cuincodebench.db.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const stagingPath = join(deps.dataDir, `restore-staging-${Date.now()}.sqlite`)

  try {
    // —— 防调包复验（preview → confirm 之间文件必须未变）——
    if (!existsSync(current.path)) {
      pending = null
      throw new AppError('validation', '备份文件已不存在，请重新选择')
    }
    const digest = await new Promise<string>((resolve, reject) => {
      const stream = createReadStream(current.path)
      const hash = createHash('sha256')
      stream.on('data', (c: Buffer) => hash.update(c))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
    if (digest !== current.fileSha256) {
      pending = null
      throw new AppError('validation', '备份文件在确认前被修改，已取消恢复；请重新导入')
    }

    // —— 1) staging 导入 + 校验（worker）——
    updateStatus('staging', 0, 1)
    opts.onProgress?.({ phase: 'staging', processed: 0, total: 1 })
    const job = startJob(
      {
        kind: 'restore',
        filePath: current.path,
        stagingPath,
        backupKind: current.kind
      },
      { onProgress: (p) => {
          updateStatus(p.phase, p.processed, p.total)
          opts.onProgress?.(p)
        } }
    )
    activeJob = job
    let stagingCounts: Record<string, number>
    try {
      const result = await job.promise
      if (result.restore === undefined) throw new AppError('internal', 'staging 导入失败：未知结果')
      stagingCounts = result.restore.countsByTable
    } finally {
      activeJob = null
    }

    // —— 2) swap（journal 保护；步骤见 spec §5.2）——
    updateStatus('swap', 0, 1)
    writeJournal(deps.dataDir, {
      phase: 'swap-start',
      dbPath: deps.dbPath,
      bakPath,
      stagingPath,
      startedAt: Date.now()
    })

    closeServices()
    let swapped = false
    try {
      if (!existsSync(deps.dbPath)) {
        throw new AppError('internal', '数据库文件不存在，无法执行恢复切换')
      }
      renameSync(deps.dbPath, bakPath) // A：旧库让位
      renameSync(stagingPath, deps.dbPath) // B：新库就位
      writeJournal(deps.dataDir, {
        phase: 'swapped',
        dbPath: deps.dbPath,
        bakPath,
        stagingPath,
        startedAt: Date.now()
      })
      swapped = true
    } catch (swapErr) {
      // rename 失败：恢复现场（旧库回位）
      try {
        if (!existsSync(deps.dbPath) && existsSync(bakPath)) renameSync(bakPath, deps.dbPath)
      } catch {
        // 回滚失败由上层 reopen 抛错兜底
      }
      throw swapErr
    }

    // —— 3) reopen + 迁移 + smoke ——
    updateStatus('reopen', 0, 1)
    try {
      const db = openDatabase({ dataDir: deps.dataDir })
      const version = currentVersion(db)
      if (version !== MIGRATIONS.length) {
        throw new AppError('internal', `恢复后 schema 版本异常（${version}）`)
      }
      initServices(db)
      // smoke：可查询 + 计数与 staging 一致
      const smoke = (getServices().db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c
      if (smoke !== (stagingCounts['problems'] ?? 0)) {
        throw new AppError('internal', '恢复 smoke 校验失败（题库计数不符）')
      }
    } catch (reopenErr) {
      // reopen/smoke 失败：回滚旧库
      try {
        closeServices()
      } catch {
        // 未初始化
      }
      if (swapped && existsSync(bakPath)) {
        if (existsSync(deps.dbPath)) rmSync(deps.dbPath, { force: true })
        renameSync(bakPath, deps.dbPath)
      }
      const db = openDatabase({ dataDir: deps.dataDir })
      initServices(db)
      throw reopenErr
    }

    // —— 4) 收尾 ——
    status = { restoring: false, phase: 'done', processed: 1, total: 1 }
    try {
      unlinkSync(journalPath(deps.dataDir))
    } catch {
      // 尽力而为
    }
    try {
      if (existsSync(bakPath)) rmSync(bakPath, { force: true })
    } catch {
      // .bak 删除失败只告警（保守：宁可多留备份）
      logger.warn('恢复后删除 .bak 失败（已保留）', bakPath)
    }
    // 恢复后内置内容迁移（seed 重跑；失败下次启动重试，不阻断成功结果）
    try {
      deps.postRestoreMigrate?.()
    } catch (err) {
      logger.warn('恢复后内置内容迁移失败（下次启动重试）', err instanceof Error ? err.message : String(err))
    }
    pending = null
    const { counts } = { counts: stagingCounts }
    logger.info('备份恢复完成（staging + 原子切换）', JSON.stringify(stagingCounts))
    deps.onRestored?.()
    return { counts }
  } catch (err) {
    status = { restoring: false, phase: 'failed', processed: 0, total: 0 }
    // journal 兜底自愈（覆盖 staging 阶段失败/swap 中途异常的现场清理）
    try {
      recoverRestoreJournal(deps.dataDir)
    } catch {
      // 自愈失败保留现场（下次启动重试）
    }
    throw err
  } finally {
    restoring = false
    maintenanceMode = false
  }
}