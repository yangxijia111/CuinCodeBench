import { createHash } from 'crypto'
import { z } from 'zod'
import {
  backupErrorRecordSchema,
  backupLearningPathSchema,
  backupMasterySchema,
  backupMistakeBookSchema,
  backupMistakeNoteSchema,
  backupPracticeSessionSchema,
  backupProblemSchema,
  backupReviewHistorySchema,
  backupReviewItemSchema,
  backupReviewSessionResultSchema,
  backupSubmissionSchema
} from '@shared/schemas'

/**
 * Backup v2 格式（docs/V1_3_BACKUP_V2_SPEC.md §1）：
 * NDJSON（UTF-8/LF），首行 meta、末行 trailer、中间数据行；
 * hash 域 = meta 之后、trailer 之前的原始 UTF-8 字节（含每行 LF），trailer 不参与。
 * 扩展名 .ccbbackup，导入按内容显式检测（绝不按扩展名/首字符猜版本）。
 */

export const BACKUP_V2_FORMAT_NAME = 'cuincodebench.backup'
export const BACKUP_V2_VERSION = 2
/** v2 支持导入的最新版本（拒绝更高版本，提示升级） */
export const BACKUP_V2_MAX_IMPORT_VERSION = 2
/** 单行上限（防内存攻击的单行爆炸） */
export const V2_MAX_LINE_BYTES = 64 * 1024 * 1024
/** 导入文件大小上限（流式读取，4GB 防御性上限） */
export const V2_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024

export const v2MetaSchema = z.object({
  type: z.literal('meta'),
  format: z.literal(BACKUP_V2_FORMAT_NAME),
  version: z.number().int().min(1),
  appVersion: z.string().max(30).optional(),
  createdAt: z.number().int().min(0),
  schemaVersion: z.number().int().min(1).optional(),
  lineEnding: z.literal('lf').optional()
})

export const settingRecordSchema = z.object({
  key: z.string().max(100),
  value: z.string().max(1_000_000)
})

/**
 * 记录 schema：type → data（data schema 与 v1 信封元素 schema 复用单源，
 * 字段一字不改——v2 记录与 v1 data 内元素同构）。
 */
export const v2RecordSchemas = {
  setting: settingRecordSchema,
  learning_path: backupLearningPathSchema,
  problem: backupProblemSchema,
  problem_knowledge: z.object({
    problemId: z.string().max(100),
    knowledgePointId: z.string().max(100)
  }),
  submission: backupSubmissionSchema,
  error_record: backupErrorRecordSchema,
  mistake_book: backupMistakeBookSchema,
  mistake_note: backupMistakeNoteSchema,
  mastery: backupMasterySchema,
  review_item: backupReviewItemSchema,
  review_history: backupReviewHistorySchema,
  review_session_result: backupReviewSessionResultSchema,
  practice_session: backupPracticeSessionSchema
} as const

export type V2RecordType = keyof typeof v2RecordSchemas

export const V2_RECORD_TYPES = Object.keys(v2RecordSchemas) as V2RecordType[]

const v2RecordEnvelopeCache = new Map<V2RecordType, z.ZodTypeAny>()

/** 记录信封 schema（带缓存；zod object 每次构建有成本，导入热路径复用） */
export function v2RecordSchema(type: V2RecordType): z.ZodTypeAny {
  let schema = v2RecordEnvelopeCache.get(type)
  if (schema === undefined) {
    schema = z.object({ type: z.literal(type), data: v2RecordSchemas[type] })
    v2RecordEnvelopeCache.set(type, schema)
  }
  return schema
}

export const v2TrailerSchema = z.object({
  type: z.literal('trailer'),
  counts: z.record(z.string().max(40), z.number().int().min(0)),
  bodySha256: z.string().length(64),
  bodyBytes: z.number().int().min(0)
})

export type V2Meta = z.output<typeof v2MetaSchema>
export type V2Trailer = z.output<typeof v2TrailerSchema>

export interface V2Summary {
  createdAt: number
  appVersion: string | null
  counts: Partial<Record<V2RecordType, number>>
}

/** 行序列化：紧凑 JSON + LF（export 与 import 的 hash 口径必须逐字节一致） */
export function serializeLine(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + '\n', 'utf8')
}

/** 规范 hash 累加器（导出/导入共用，hash 域 = body 原始字节） */
export class BodyHasher {
  private readonly hash = createHash('sha256')
  bytes = 0

  update(line: Buffer): void {
    this.hash.update(line)
    this.bytes += line.length
  }

  digest(): string {
    return this.hash.copy().digest('hex')
  }
}

/** 格式检测：NDJSON v2 meta 行 / v1 单 JSON / 无关 JSON（docs §1.1） */
export type DetectedFormat =
  | { kind: 'v2' }
  | { kind: 'v1' }
  | { kind: 'unknown'; reason: string }

export function detectBackupFormat(headBytes: Buffer): DetectedFormat {
  const text = headBytes.toString('utf8')
  const firstLine = text.split('\n')[0] ?? ''
  const trimmed = firstLine.trim()
  if (trimmed.startsWith('{"type":"meta"') || trimmed.startsWith('{"type": "meta"')) {
    return { kind: 'v2' }
  }
  if (trimmed.startsWith('{')) {
    // 单 JSON 候选（v1 信封是整文件一个 JSON 对象）
    try {
      const raw = JSON.parse(text) as { format?: unknown }
      if (raw !== null && typeof raw === 'object' && raw.format === BACKUP_V2_FORMAT_NAME) {
        return { kind: 'v1' }
      }
      return { kind: 'unknown', reason: 'format 不是 cuincodebench.backup（可能是题目导出 JSON，请使用题库导入）' }
    } catch {
      // 截断的 v1（head 只读了前 4KB）：按 v1 候选交由 legacy importer 完整校验并报错
      return { kind: 'v1' }
    }
  }
  return { kind: 'unknown', reason: '不是 CuinCodeBench 备份文件' }
}
