import type Database from 'better-sqlite3'
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { AppError } from '../lib/app-error'
import {
  BACKUP_V2_FORMAT_NAME,
  BACKUP_V2_VERSION,
  BodyHasher,
  V2_RECORD_TYPES,
  serializeLine,
  type V2RecordType
} from './backup-v2-format'

/**
 * Backup v2 流式导出（docs/V1_3_BACKUP_V2_SPEC.md §2）：
 * - 逐行（iterator + JOIN 流分组）：任意时刻内存 O(单行/单题) —— 禁止 readAll 全量对象；
 * - 边写边 hash（规范 hash 域 = meta 之后、trailer 之前的原始字节）；
 * - 临时文件 → fsync → rename 原子落盘；取消 → 删临时文件。
 */

export interface ExportProgress {
  phase: V2RecordType | 'trailer'
  processed: number
  total: number
}

export interface ExportV2Result {
  counts: Partial<Record<V2RecordType, number>>
  bodySha256: string
  bodyBytes: number
}

export interface ExportV2Options {
  appVersion: string
  schemaVersion?: number
  onProgress?: (p: ExportProgress) => void
  isCancelled?: () => boolean
}

// —— 行 → 记录映射（v2 记录与 v1 信封元素同构，docs §1.2）——

interface SettingRow {
  key: string
  value: string
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

interface ProblemJoinRow {
  id: string
  title: string
  description: string
  difficulty: string
  tags: string
  input_desc: string
  output_desc: string
  samples: string
  initial_code: string
  is_builtin: number
  created_at: number
  updated_at: number
  case_id: string | null
  case_stdin: string | null
  case_expected: string | null
  case_timeout: number | null
  case_order: number | null
}

interface SubmissionJoinRow {
  id: string
  problem_id: string
  language: string
  code: string
  status: string
  passed_count: number
  total_count: number
  duration_ms: number
  created_at: number
  result_case_id: string | null
  result_order: number | null
  result_stdin: string | null
  result_expected: string | null
  result_actual: string | null
  result_stderr: string | null
  result_status: string | null
  result_exit_code: number | null
  result_duration: number | null
  result_termination: string | null
}

/** 原子落盘：临时文件（同目录）+ fsync + rename */
class AtomicLineWriter {
  private readonly tmpPath: string
  private fd: number

  constructor(private readonly finalPath: string) {
    const dir = dirname(finalPath)
    mkdirSync(dir, { recursive: true })
    this.tmpPath = `${finalPath}.tmp-${Date.now()}-${process.pid}`
    this.fd = openSync(this.tmpPath, 'w')
  }

  write(line: Buffer): void {
    writeSync(this.fd, line)
  }

  /** 成功收尾：fsync → rename；失败自动清理 */
  commit(): void {
    try {
      fsyncSync(this.fd)
    } finally {
      closeSync(this.fd)
    }
    renameSync(this.tmpPath, this.finalPath)
  }

  abort(): void {
    try {
      closeSync(this.fd)
    } catch {
      // 已关闭
    }
    try {
      if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath)
    } catch {
      // 清理失败不掩盖主错误
    }
  }
}

export function exportBackupV2(
  db: Database.Database,
  outPath: string,
  opts: ExportV2Options
): ExportV2Result {
  const writer = new AtomicLineWriter(outPath)
  const hasher = new BodyHasher()
  const counts: Partial<Record<V2RecordType, number>> = {}
  let cancelled = false

  const emit = (line: Buffer): void => {
    hasher.update(line)
    writer.write(line)
  }

  const emitRecord = (type: V2RecordType, data: unknown): void => {
    emit(serializeLine({ type, data }))
    counts[type] = (counts[type] ?? 0) + 1
  }

  const emitTable = (
    type: V2RecordType,
    total: number,
    rows: IterableIterator<unknown>,
    map: (row: never) => unknown
  ): boolean => {
    let processed = 0
    for (const row of rows) {
      emitRecord(type, map(row as never))
      processed++
      if (processed % 1000 === 0) {
        opts.onProgress?.({ phase: type, processed, total })
        if (opts.isCancelled?.() === true) {
          cancelled = true
          return false
        }
      }
    }
    opts.onProgress?.({ phase: type, processed, total })
    return true
  }

  try {
    // meta 行（hash 域之外）
    writer.write(
      serializeLine({
        type: 'meta',
        format: BACKUP_V2_FORMAT_NAME,
        version: BACKUP_V2_VERSION,
        appVersion: opts.appVersion,
        createdAt: Date.now(),
        schemaVersion: opts.schemaVersion,
        lineEnding: 'lf'
      })
    )

    // 1. settings（O(1) 流）
    const settingRows = db.prepare('SELECT key, value FROM settings ORDER BY rowid').iterate() as IterableIterator<SettingRow>
    const settingTotal = (db.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number }).c
    if (!emitTable('setting', settingTotal, settingRows, (r: SettingRow) => ({ key: r.key, value: r.value }))) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    // 2. learning_paths（嵌套 path→stages→kps；表规模小，一次载入分组索引）
    const pathRows = db.prepare('SELECT * FROM learning_paths ORDER BY sort_order, rowid').all() as PathRow[]
    const stageRows = db.prepare('SELECT * FROM learning_stages ORDER BY path_id, sort_order, rowid').all() as StageRow[]
    const kpRows = db.prepare('SELECT * FROM knowledge_points ORDER BY stage_id, sort_order, rowid').all() as KpRow[]
    const stagesByPath = new Map<string, StageRow[]>()
    for (const s of stageRows) {
      const list = stagesByPath.get(s.path_id)
      if (list !== undefined) list.push(s)
      else stagesByPath.set(s.path_id, [s])
    }
    const kpsByStage = new Map<string, KpRow[]>()
    for (const k of kpRows) {
      const list = kpsByStage.get(k.stage_id)
      if (list !== undefined) list.push(k)
      else kpsByStage.set(k.stage_id, [k])
    }
    let lpProcessed = 0
    for (const p of pathRows) {
      emitRecord('learning_path', {
        id: p.id,
        slug: p.slug,
        title: p.title,
        description: p.description,
        isBuiltin: p.is_builtin === 1,
        sortOrder: p.sort_order,
        stages: (stagesByPath.get(p.id) ?? []).map((s) => ({
          id: s.id,
          pathId: s.path_id,
          title: s.title,
          description: s.description,
          sortOrder: s.sort_order,
          knowledgePoints: (kpsByStage.get(s.id) ?? []).map((k) => ({
            id: k.id,
            stageId: k.stage_id,
            name: k.name,
            description: k.description,
            sortOrder: k.sort_order,
            tags: JSON.parse(k.tags) as string[]
          }))
        }))
      })
      lpProcessed++
      if (lpProcessed % 1000 === 0) opts.onProgress?.({ phase: 'learning_path', processed: lpProcessed, total: pathRows.length })
    }
    opts.onProgress?.({ phase: 'learning_path', processed: lpProcessed, total: pathRows.length })

    // 3. problems + test_cases（JOIN 流分组，内存 O(单题用例)）
    const problemTotal = (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c
    const problemRows = db
      .prepare(
        `SELECT p.id, p.title, p.description, p.difficulty, p.tags, p.input_desc, p.output_desc,
                p.samples, p.initial_code, p.is_builtin, p.created_at, p.updated_at,
                c.id AS case_id, c.stdin AS case_stdin, c.expected_stdout AS case_expected,
                c.timeout_ms AS case_timeout, c."order" AS case_order
         FROM problems p LEFT JOIN test_cases c ON c.problem_id = p.id
         ORDER BY p.created_at, p.rowid, c."order"`
      )
      .iterate() as IterableIterator<ProblemJoinRow>
    let problemProcessed = 0
    let currentProblem: ProblemJoinRow | undefined
    let pendingCases: ProblemJoinRow[] = []
    const flushProblem = (): void => {
      if (currentProblem === undefined) return
      const p = currentProblem
      emitRecord('problem', {
        id: p.id,
        title: p.title,
        description: p.description,
        difficulty: p.difficulty as 'easy' | 'medium' | 'hard',
        tags: JSON.parse(p.tags) as string[],
        inputDesc: p.input_desc,
        outputDesc: p.output_desc,
        samples: JSON.parse(p.samples) as { input: string; output: string; note?: string }[],
        initialCode: JSON.parse(p.initial_code) as { c: string; cpp: string; python: string },
        isBuiltin: p.is_builtin === 1,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        testCases: pendingCases.map((c) => ({
          id: c.case_id ?? '',
          stdin: c.case_stdin ?? '',
          expectedStdout: c.case_expected ?? '',
          timeoutMs: c.case_timeout ?? 0
        }))
      })
      problemProcessed++
      currentProblem = undefined
      pendingCases = []
      if (problemProcessed % 500 === 0) {
        opts.onProgress?.({ phase: 'problem', processed: problemProcessed, total: problemTotal })
        if (opts.isCancelled?.() === true) cancelled = true
      }
    }
    for (const row of problemRows) {
      if (cancelled) break
      if (currentProblem === undefined || row.id !== currentProblem.id) {
        flushProblem()
        currentProblem = row
      }
      pendingCases.push(row)
    }
    if (!cancelled) flushProblem()
    opts.onProgress?.({ phase: 'problem', processed: problemProcessed, total: problemTotal })
    if (cancelled) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    // 4. problem_knowledge
    const pkRows = db
      .prepare('SELECT problem_id, knowledge_point_id FROM problem_knowledge_points ORDER BY rowid')
      .iterate() as IterableIterator<{ problem_id: string; knowledge_point_id: string }>
    const pkTotal = (db.prepare('SELECT COUNT(*) AS c FROM problem_knowledge_points').get() as { c: number }).c
    if (
      !emitTable('problem_knowledge', pkTotal, pkRows, (r: { problem_id: string; knowledge_point_id: string }) => ({
        problemId: r.problem_id,
        knowledgePointId: r.knowledge_point_id
      }))
    ) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    // 5. submissions + results（JOIN 流分组，内存 O(单提交明细 ≤50)）
    const subTotal = (db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number }).c
    const subRows = db
      .prepare(
        `SELECT s.id, s.problem_id, s.language, s.code, s.status, s.passed_count, s.total_count,
                s.duration_ms, s.created_at,
                r.test_case_id AS result_case_id, r."order" AS result_order, r.stdin AS result_stdin,
                r.expected AS result_expected, r.actual AS result_actual, r.stderr AS result_stderr,
                r.status AS result_status, r.exit_code AS result_exit_code,
                r.duration_ms AS result_duration, r.termination_reason AS result_termination
         FROM submissions s LEFT JOIN test_case_results r ON r.submission_id = s.id
         ORDER BY s.created_at, s.rowid, r."order"`
      )
      .iterate() as IterableIterator<SubmissionJoinRow>
    let subProcessed = 0
    let currentSub: SubmissionJoinRow | undefined
    let pendingResults: SubmissionJoinRow[] = []
    const flushSubmission = (): void => {
      if (currentSub === undefined) return
      const s = currentSub
      emitRecord('submission', {
        id: s.id,
        problemId: s.problem_id,
        language: s.language as 'c' | 'cpp' | 'python',
        code: s.code,
        status: s.status,
        passedCount: s.passed_count,
        totalCount: s.total_count,
        durationMs: s.duration_ms,
        createdAt: s.created_at,
        results: pendingResults
          .filter((r) => r.result_case_id !== null)
          .map((r) => ({
            testCaseId: r.result_case_id ?? '',
            order: r.result_order ?? 0,
            stdin: r.result_stdin ?? '',
            expected: r.result_expected ?? '',
            actual: r.result_actual,
            stderr: r.result_stderr ?? '',
            status: r.result_status ?? '',
            exitCode: r.result_exit_code,
            durationMs: r.result_duration ?? 0,
            ...(r.result_termination != null ? { terminationReason: r.result_termination } : {})
          }))
      })
      subProcessed++
      currentSub = undefined
      pendingResults = []
      if (subProcessed % 500 === 0) {
        opts.onProgress?.({ phase: 'submission', processed: subProcessed, total: subTotal })
        if (opts.isCancelled?.() === true) cancelled = true
      }
    }
    for (const row of subRows) {
      if (cancelled) break
      if (currentSub === undefined || row.id !== currentSub.id) {
        flushSubmission()
        currentSub = row
      }
      pendingResults.push(row)
    }
    if (!cancelled) flushSubmission()
    opts.onProgress?.({ phase: 'submission', processed: subProcessed, total: subTotal })
    if (cancelled) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    // 6-12. 单行表（error_record → mistake_book → mistake_note → mastery →
    //        review_item → review_history → practice_session → review_session_result）
    const errRows = db.prepare('SELECT * FROM error_records ORDER BY created_at, rowid').iterate() as IterableIterator<Record<string, unknown>>
    const errTotal = (db.prepare('SELECT COUNT(*) AS c FROM error_records').get() as { c: number }).c
    if (!emitTable('error_record', errTotal, errRows, mapErrorRecord)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    const mbRows = db.prepare('SELECT * FROM mistake_book ORDER BY rowid').iterate() as IterableIterator<Record<string, unknown>>
    const mbTotal = (db.prepare('SELECT COUNT(*) AS c FROM mistake_book').get() as { c: number }).c
    if (!emitTable('mistake_book', mbTotal, mbRows, mapMistakeBook)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    const mnRows = db.prepare('SELECT * FROM mistake_notes ORDER BY updated_at, rowid').iterate() as IterableIterator<Record<string, unknown>>
    const mnTotal = (db.prepare('SELECT COUNT(*) AS c FROM mistake_notes').get() as { c: number }).c
    if (!emitTable('mistake_note', mnTotal, mnRows, mapMistakeNote)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    const maRows = db.prepare('SELECT * FROM mastery ORDER BY updated_at, rowid').iterate() as IterableIterator<Record<string, unknown>>
    const maTotal = (db.prepare('SELECT COUNT(*) AS c FROM mastery').get() as { c: number }).c
    if (!emitTable('mastery', maTotal, maRows, mapMastery)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    const riRows = db.prepare('SELECT * FROM review_items ORDER BY created_at, rowid').iterate() as IterableIterator<Record<string, unknown>>
    const riTotal = (db.prepare('SELECT COUNT(*) AS c FROM review_items').get() as { c: number }).c
    if (!emitTable('review_item', riTotal, riRows, mapReviewItem)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    const rhRows = db.prepare('SELECT * FROM review_history ORDER BY reviewed_at, rowid').iterate() as IterableIterator<Record<string, unknown>>
    const rhTotal = (db.prepare('SELECT COUNT(*) AS c FROM review_history').get() as { c: number }).c
    if (!emitTable('review_history', rhTotal, rhRows, mapReviewHistory)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    // practice_sessions + items（JOIN 流分组）
    const psTotal = (db.prepare('SELECT COUNT(*) AS c FROM practice_sessions').get() as { c: number }).c
    const psRows = db
      .prepare(
        `SELECT s.id, s.kind, s.knowledge_point_id, s.config, s.status, s.total, s.created_at, s.finished_at,
                i.id AS item_id, i.problem_id AS item_problem, i.sort_order AS item_order,
                i.status AS item_status, i.attempts AS item_attempts,
                i.first_accepted_submission_id AS item_accept, i.first_result_at AS item_result_at
         FROM practice_sessions s LEFT JOIN practice_session_items i ON i.session_id = s.id
         ORDER BY s.created_at, s.rowid, i.sort_order`
      )
      .iterate() as IterableIterator<Record<string, unknown>>
    let psProcessed = 0
    let currentSession: Record<string, unknown> | undefined
    let pendingItems: Record<string, unknown>[] = []
    const flushSession = (): void => {
      if (currentSession === undefined) return
      const s = currentSession
      emitRecord('practice_session', {
        id: s.id as string,
        kind: s.kind as string,
        knowledgePointId: s.knowledge_point_id as string | null,
        config: JSON.parse((s.config as string) || '{}') as Record<string, unknown>,
        status: s.status as string,
        total: s.total as number,
        createdAt: s.created_at as number,
        finishedAt: s.finished_at as number | null,
        items: pendingItems
          .filter((i) => i.item_id !== null)
          .map((i) => ({
            id: i.item_id as string,
            problemId: i.item_problem as string,
            sortOrder: i.item_order as number,
            status: i.item_status as string,
            attempts: i.item_attempts as number,
            firstAcceptedSubmissionId: i.item_accept as string | null,
            firstResultAt: i.item_result_at as number | null
          }))
      })
      psProcessed++
      currentSession = undefined
      pendingItems = []
      if (psProcessed % 500 === 0) opts.onProgress?.({ phase: 'practice_session', processed: psProcessed, total: psTotal })
    }
    for (const row of psRows) {
      if (currentSession === undefined || row.id !== currentSession.id) {
        flushSession()
        currentSession = row
      }
      pendingItems.push(row)
    }
    flushSession()
    opts.onProgress?.({ phase: 'practice_session', processed: psProcessed, total: psTotal })

    const rsrRows = db.prepare('SELECT * FROM review_session_results ORDER BY graded_at, rowid').iterate() as IterableIterator<Record<string, unknown>>
    const rsrTotal = (db.prepare('SELECT COUNT(*) AS c FROM review_session_results').get() as { c: number }).c
    if (!emitTable('review_session_result', rsrTotal, rsrRows, mapSessionResult)) {
      writer.abort()
      throw new AppError('cancelled', '导出已取消，临时文件已清理')
    }

    // trailer（hash 域之外）
    writer.write(
      serializeLine({
        type: 'trailer',
        counts,
        bodySha256: hasher.digest(),
        bodyBytes: hasher.bytes
      })
    )
    opts.onProgress?.({ phase: 'trailer', processed: V2_RECORD_TYPES.length, total: V2_RECORD_TYPES.length })
    writer.commit()
    return { counts, bodySha256: hasher.digest(), bodyBytes: hasher.bytes }
  } catch (err) {
    writer.abort()
    throw err
  }
}

// —— 单行表映射（snake → camel；与 v1 元素 schema 字段一致）——

function mapErrorRecord(r: Record<string, unknown>): unknown {
  return {
    id: r.id,
    submissionId: r.submission_id,
    problemId: r.problem_id,
    language: r.language,
    errorType: r.error_type,
    message: r.message,
    createdAt: r.created_at,
    learningCategory: r.learning_category,
    categorySource: (r.category_source as string | null) ?? null
  }
}

function mapMistakeBook(r: Record<string, unknown>): unknown {
  return {
    problemId: r.problem_id,
    failedCount: r.failed_count,
    firstFailedAt: r.first_failed_at,
    lastFailedAt: r.last_failed_at,
    lastErrorType: r.last_error_type,
    errorTypeCounts: JSON.parse((r.error_type_counts as string) || '{}') as Record<string, number>,
    mastered: r.mastered === 1,
    masteredAt: r.mastered_at
  }
}

function mapMistakeNote(r: Record<string, unknown>): unknown {
  return { problemId: r.problem_id, note: r.note, updatedAt: r.updated_at }
}

function mapMastery(r: Record<string, unknown>): unknown {
  return {
    knowledgePointId: r.knowledge_point_id,
    score: r.score,
    status: r.status,
    updatedAt: r.updated_at
  }
}

function mapReviewItem(r: Record<string, unknown>): unknown {
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    lastReviewedAt: r.last_reviewed_at,
    nextReviewAt: r.next_review_at,
    reviewCount: r.review_count,
    successStreak: r.success_streak,
    failureCount: r.failure_count,
    intervalDays: r.interval_days,
    createdAt: r.created_at
  }
}

function mapReviewHistory(r: Record<string, unknown>): unknown {
  return {
    id: r.id,
    reviewItemId: r.review_item_id,
    result: r.result,
    reviewedAt: r.reviewed_at,
    submissionId: r.submission_id
  }
}

function mapSessionResult(r: Record<string, unknown>): unknown {
  return {
    sessionId: r.session_id,
    reviewItemId: r.review_item_id,
    grade: r.grade,
    submissionId: r.submission_id,
    gradedAt: r.graded_at
  }
}
