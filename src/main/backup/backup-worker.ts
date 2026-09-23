import { parentPort, workerData } from 'worker_threads'
import { existsSync, readFileSync, rmSync, statSync } from 'fs'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/connection'
import { exportBackupV2 } from './backup-v2-export'
import { validateBackupV2 } from './backup-v2-import'
import { detectBackupFormat } from './backup-v2-format'
import { StagingWriter, verifyStaging } from './staging-writer'
import { BackupService, type BackupSummary } from '../services/backup-service'
import { BackupRepository } from '../db/repositories/backup-repository'
import type { V2RecordType } from './backup-v2-format'

/**
 * 备份 worker（docs/V1_3_BACKUP_V2_SPEC.md §4）：
 * worker_threads 入口 + 可 inline 执行的任务实现（runJob）。
 * 同一套 runJob 双模式：worker 内（生产，主进程零大对象）/ inline（测试、
 * worker 文件缺失的降级），保证测试与生产行为一致。
 *
 * 协议：workerData = job；postMessage({type:'progress'|'done'|'error'})；
 * 父端可 postMessage({type:'cancel'})（协作式，批次间检查）。
 */

export interface BackupJob {
  kind: 'export' | 'preview' | 'restore'
  /** export：源库文件路径（worker 自持只读连接） */
  dbPath?: string
  /** export：目标文件 */
  outPath?: string
  /** preview/restore：备份文件 */
  filePath?: string
  /** restore：staging 库路径（新文件） */
  stagingPath?: string
  appVersion?: string
  schemaVersion?: number
  /** preview/restore 的格式（主进程 head 检测后指定） */
  backupKind?: 'v1' | 'v2'
}

export interface WorkerProgress {
  type: 'progress'
  phase: string
  processed: number
  total: number
}

export interface BackupJobResult {
  export?: { counts: Record<string, number>; bodySha256: string; bodyBytes: number }
  preview?: { kind: 'v1' | 'v2'; summary: BackupSummary }
  restore?: { countsByTable: Record<string, number> }
}

const THROTTLE_MS = 100
const V1_MAX_BYTES = 512 * 1024 * 1024

/** v2 记录类型 → 表名（计数对拍用） */
const TABLE_OF: Record<V2RecordType, string> = {
  setting: 'settings',
  learning_path: 'learning_paths',
  problem: 'problems',
  problem_knowledge: 'problem_knowledge_points',
  submission: 'submissions',
  error_record: 'error_records',
  mistake_book: 'mistake_book',
  mistake_note: 'mistake_notes',
  mastery: 'mastery',
  review_item: 'review_items',
  review_history: 'review_history',
  practice_session: 'practice_sessions',
  review_session_result: 'review_session_results'
}

function countsByTable(db: Database.Database): Record<string, number> {
  const actual: Record<string, number> = {}
  for (const table of new Set(Object.values(TABLE_OF))) {
    actual[table] = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  }
  return actual
}

/** v1 Counts 键（camelCase）→ 表名（staging 对拍口径） */
const COUNTS_KEY_TO_TABLE: Record<string, string> = {
  problems: 'problems',
  submissions: 'submissions',
  testCaseResults: 'test_case_results',
  errorRecords: 'error_records',
  mistakeBook: 'mistake_book',
  mistakeNotes: 'mistake_notes',
  learningPaths: 'learning_paths',
  learningStages: 'learning_stages',
  knowledgePoints: 'knowledge_points',
  problemKnowledge: 'problem_knowledge_points',
  mastery: 'mastery',
  reviewItems: 'review_items',
  reviewHistory: 'review_history',
  reviewSessionResults: 'review_session_results',
  practiceSessions: 'practice_sessions',
  practiceSessionItems: 'practice_session_items',
  settings: 'settings'
}

function countsKeyToTable(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(counts)) {
    const table = COUNTS_KEY_TO_TABLE[k]
    if (table !== undefined) out[table] = v
  }
  return out
}

function detectKind(filePath: string): 'v1' | 'v2' {
  const head = readFileSync(filePath).subarray(0, 4096)
  const detected = detectBackupFormat(head)
  if (detected.kind === 'v2') return 'v2'
  if (detected.kind === 'v1') return 'v1'
  throw new Error(detected.reason)
}

function readV1Text(filePath: string): string {
  if (statSync(filePath).size > V1_MAX_BYTES) {
    throw new Error('备份文件超过 512MB（v1 格式上限），请使用 v1.3 应用重新导出（v2 流式格式）')
  }
  return readFileSync(filePath, 'utf-8')
}

/** 任务实现（worker/inline 共用；禁止 import electron） */
export async function runJob(
  job: BackupJob,
  send: (msg: WorkerProgress) => void,
  isCancelled: () => boolean
): Promise<BackupJobResult> {
  switch (job.kind) {
    case 'export': {
      if (!job.dbPath || !job.outPath) throw new Error('export 任务缺少 dbPath/outPath')
      if (!existsSync(job.dbPath)) throw new Error('数据库文件不存在')
      const db = new Database(job.dbPath, { readonly: true })
      try {
        let last = 0
        const result = exportBackupV2(db, job.outPath, {
          appVersion: job.appVersion ?? '',
          schemaVersion: job.schemaVersion,
          isCancelled,
          onProgress: (p) => {
            const now = Date.now()
            if (now - last >= THROTTLE_MS) {
              last = now
              send({ type: 'progress', phase: p.phase, processed: p.processed, total: p.total })
            }
          }
        })
        return {
          export: {
            counts: result.counts,
            bodySha256: result.bodySha256,
            bodyBytes: result.bodyBytes
          }
        }
      } finally {
        db.close()
      }
    }
    case 'preview': {
      if (!job.filePath) throw new Error('preview 任务缺少 filePath')
      if (!existsSync(job.filePath)) throw new Error('备份文件不存在')
      const kind = job.backupKind ?? detectKind(job.filePath)
      if (kind === 'v2') {
        let kpCount = 0
        const checked = await validateBackupV2(job.filePath, {
          isCancelled,
          consumeRecord: (type, data) => {
            if (type === 'learning_path') {
              const d = data as { stages: { knowledgePoints: unknown[] }[] }
              for (const s of d.stages) kpCount += s.knowledgePoints.length
            }
          }
        })
        const summary: BackupSummary = {
          createdAt: checked.summary.createdAt,
          appVersion: checked.summary.appVersion,
          counts: {
            problems: checked.counts.problem ?? 0,
            submissions: checked.counts.submission ?? 0,
            errorRecords: checked.counts.error_record ?? 0,
            mistakeBook: checked.counts.mistake_book ?? 0,
            mistakeNotes: checked.counts.mistake_note ?? 0,
            knowledgePoints: kpCount,
            mastery: checked.counts.mastery ?? 0,
            reviewItems: checked.counts.review_item ?? 0,
            reviewHistory: checked.counts.review_history ?? 0,
            practiceSessions: checked.counts.practice_session ?? 0
          }
        }
        return { preview: { kind: 'v2', summary } }
      }
      // v1：整文本 + 既有 zod 信封校验（只读校验，:memory: 探针库）
      const probe = new BackupService(new Database(':memory:'))
      const { summary } = probe.validate(readV1Text(job.filePath))
      return { preview: { kind: 'v1', summary } }
    }
    case 'restore': {
      if (!job.filePath || !job.stagingPath) throw new Error('restore 任务缺少 filePath/stagingPath')
      const kind = job.backupKind ?? detectKind(job.filePath)
      // staging 全新文件：openDatabase 迁移到当前 schema
      for (const f of [job.stagingPath, `${job.stagingPath}-wal`, `${job.stagingPath}-shm`]) {
        if (existsSync(f)) rmSync(f, { force: true })
      }
      const staging = openDatabase({ file: job.stagingPath })
      let actualCounts: Record<string, number> | undefined
      try {
        if (kind === 'v2') {
          const writer = new StagingWriter(staging)
          // 显式事务包裹整个流式导入（better-sqlite3 事务要求同步回调，而流是异步逐行）
          staging.exec('BEGIN IMMEDIATE')
          try {
            const checked = await validateBackupV2(job.filePath, {
              isCancelled,
              consumeRecord: (type, data) => writer.insert(type, data)
            })
            // validate 内部已完成 hash/counts 三重对拍；此处按表对拍实际行数
            const expected: Record<string, number> = {}
            for (const [type, n] of Object.entries(checked.counts)) {
              expected[TABLE_OF[type as V2RecordType]] = n ?? 0
            }
            verifyStaging(staging, expected)
            staging.exec('COMMIT')
          } catch (err) {
            staging.exec('ROLLBACK')
            throw err
          }
        } else {
          // v1：整文本 → 信封校验 → 写 staging（不再直写正式库，docs §5.4）
          const text = readV1Text(job.filePath)
          const svc = new BackupService(staging)
          const { envelope } = svc.validate(text)
          send({ type: 'progress', phase: 'import', processed: 0, total: 1 })
          staging.exec('BEGIN IMMEDIATE')
          try {
            const repo = new BackupRepository(staging)
            repo.clearAll()
            repo.writeAll(envelope.data)
            const expected = BackupRepository.expectedCounts(envelope.data)
            verifyStaging(staging, countsKeyToTable(expected as unknown as Record<string, number>))
            staging.exec('COMMIT')
          } catch (err) {
            staging.exec('ROLLBACK')
            throw err
          }
        }
        actualCounts = countsByTable(staging)
        if (actualCounts === undefined) throw new Error('unreachable')
        // checkpoint + 退出 WAL（rename 单文件语义）→ close
        staging.pragma('wal_checkpoint(TRUNCATE)')
        staging.pragma('journal_mode = DELETE')
        staging.close()
        for (const suffix of ['-wal', '-shm']) {
          const f = `${job.stagingPath}${suffix}`
          if (existsSync(f)) rmSync(f, { force: true })
        }
        send({ type: 'progress', phase: 'staging-done', processed: 1, total: 1 })
        return { restore: { countsByTable: actualCounts } }
      } catch (err) {
        // staging 半成品清理（正式库全程未触碰）
        try {
          staging.close()
        } catch {
          // 已关闭
        }
        try {
          for (const f of [job.stagingPath, `${job.stagingPath}-wal`, `${job.stagingPath}-shm`]) {
            if (existsSync(f)) rmSync(f, { force: true })
          }
        } catch {
          // 清理失败不掩盖主错误
        }
        throw err
      }
    }
  }
}

// —— worker 线程入口（inline 调用时 parentPort 为 undefined）——
if (parentPort !== null) {
  const job = workerData as BackupJob
  const port = parentPort
  let cancelled = false
  port.on('message', (msg: { type?: string }) => {
    if (msg?.type === 'cancel') cancelled = true
  })
  runJob(job, (msg) => port.postMessage(msg), () => cancelled)
    .then((result) => port.postMessage({ type: 'done', result }))
    .catch((err: unknown) => {
      port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
}
