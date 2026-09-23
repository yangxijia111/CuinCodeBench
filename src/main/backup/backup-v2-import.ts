import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import {
  BACKUP_V2_FORMAT_NAME,
  BACKUP_V2_MAX_IMPORT_VERSION,
  BodyHasher,
  V2_MAX_LINE_BYTES,
  V2_RECORD_TYPES,
  detectBackupFormat,
  v2MetaSchema,
  v2RecordSchema,
  v2TrailerSchema,
  type V2Meta,
  type V2RecordType,
  type V2Summary,
  type V2Trailer
} from './backup-v2-format'
import { AppError } from '../lib/app-error'

/**
 * Backup v2 流式导入/校验（docs/V1_3_BACKUP_V2_SPEC.md §3）：
 * - readline 流式逐行：行级 zod 校验 → 立即 hash → 计数，记录流过即弃（preview 内存 O(1)）；
 * - trailer 三重对拍：counts / bodySha256 / bodyBytes（边读边 hash，禁止先读全文件）；
 * - 结构校验在 preview 完成；交叉引用校验由 staging 落库后 SQL/FK 检查完成（职责分离）。
 */

export interface ImportProgress {
  processed: number
  bytes: number
}

export interface ValidateV2Result {
  meta: V2Meta
  trailer: V2Trailer
  counts: Partial<Record<V2RecordType, number>>
  summary: V2Summary
}

export interface ValidateV2Options {
  onProgress?: (p: ImportProgress) => void
  isCancelled?: () => boolean
  /** 额外的行消费者（staging 导入时逐行写库；preview 不传） */
  consumeRecord?: (type: V2RecordType, data: unknown) => void
}

function validationError(message: string): AppError {
  return new AppError('validation', message)
}

/** 读一行的原始字节长度（含 LF；hash 口径需要） */
function lineByteLength(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1 // + LF
}

export async function validateBackupV2(
  filePath: string,
  opts: ValidateV2Options = {}
): Promise<ValidateV2Result> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let lineIndex = 0
  let meta: V2Meta | null = null
  let trailer: V2Trailer | null = null
  const counts: Partial<Record<V2RecordType, number>> = {}
  const hasher = new BodyHasher()
  let processed = 0

  for await (const line of rl) {
    if (opts.isCancelled?.() === true) {
      rl.close()
      stream.destroy()
      throw validationError('导入已取消')
    }
    lineIndex++
    const rawLen = lineByteLength(line)
    if (rawLen > V2_MAX_LINE_BYTES) {
      throw validationError(`备份文件第 ${lineIndex} 行超长（${rawLen} 字节），文件可能已损坏`)
    }

    if (lineIndex === 1) {
      meta = parseMeta(line)
      continue
    }

    let parsed: { type?: string; data?: unknown }
    try {
      parsed = JSON.parse(line) as { type?: string; data?: unknown }
    } catch {
      throw validationError(`备份文件第 ${lineIndex} 行不是合法 JSON：文件已损坏或不完整`)
    }

    // trailer 判定先于 hash（规范 hash 域 = meta 之后、trailer 之前，trailer 本身不参与）
    if (parsed.type === 'trailer') {
      const t = v2TrailerSchema.safeParse(parsed)
      if (!t.success) {
        throw validationError(`备份文件第 ${lineIndex} 行（trailer）格式不合法`)
      }
      trailer = t.data
      // trailer 必须是最后一行：继续读，若还有 body 行则报错
      for await (const extra of rl) {
        if (extra.trim() !== '') {
          throw validationError(`trailer 之后仍有数据（第 ${lineIndex} 行之后）：文件已损坏`)
        }
      }
      break
    }

    // body 行：立即 hash（含 LF）→ 记录校验 → 消费/计数
    hasher.update(Buffer.concat([Buffer.from(line, 'utf8'), Buffer.from('\n', 'utf8')]))

    const type = parsed.type as V2RecordType
    if (typeof type !== 'string' || !V2_RECORD_TYPES.includes(type)) {
      throw validationError(`备份文件第 ${lineIndex} 行记录类型无法识别（${String(parsed.type).slice(0, 40)}）：文件可能来自不兼容的版本`)
    }
    const recordCheck = v2RecordSchema(type).safeParse(parsed)
    if (!recordCheck.success) {
      const detail = recordCheck.success ? '' : recordCheck.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 300)
      throw validationError(`备份文件第 ${lineIndex} 行（${type}）字段校验失败：${detail}`)
    }
    opts.consumeRecord?.(type, parsed.data)
    counts[type] = (counts[type] ?? 0) + 1
    processed++
    if (processed % 1000 === 0) {
      opts.onProgress?.({ processed, bytes: hasher.bytes })
      if (opts.isCancelled?.() === true) {
        rl.close()
        stream.destroy()
        throw validationError('导入已取消')
      }
    }
  }

  // 收尾关闭（Windows 文件锁：读流不关会让后续删除/替换失败）
  try {
    rl.close()
    stream.destroy()
  } catch {
    // 已关闭
  }

  if (meta === null) {
    throw validationError('备份文件缺少 meta 头：不是完整的备份文件')
  }
  if (trailer === null) {
    throw validationError('备份文件缺少结尾校验块（trailer）：文件已被截断或不完整')
  }

  // —— 三重对拍（P8：hash mismatch 拒绝）——
  if (hasher.digest() !== trailer.bodySha256) {
    throw validationError('备份内容校验失败（SHA-256 不匹配）：文件已损坏或被修改，已拒绝恢复')
  }
  if (hasher.bytes !== trailer.bodyBytes) {
    throw validationError(
      `备份内容校验失败（字节数不符：期望 ${trailer.bodyBytes}，实际 ${hasher.bytes}）：文件已损坏`
    )
  }
  const countKeys = Object.keys(trailer.counts)
  for (const key of countKeys) {
    if (!V2_RECORD_TYPES.includes(key as V2RecordType)) {
      throw validationError(`trailer 计数包含未知类型 ${key}：文件可能来自不兼容的版本`)
    }
  }
  for (const type of V2_RECORD_TYPES) {
    const expected = trailer.counts[type] ?? 0
    const actual = counts[type] ?? 0
    if (expected !== actual) {
      throw validationError(
        `备份完整性校验失败：${type} 记录数不符（trailer 记载 ${expected}，实际 ${actual}）`
      )
    }
  }

  const summary: V2Summary = {
    createdAt: meta.createdAt,
    appVersion: meta.appVersion ?? null,
    counts
  }
  opts.onProgress?.({ processed, bytes: hasher.bytes })
  return { meta, trailer, counts, summary }
}

function parseMeta(line: string): V2Meta {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw validationError('备份文件首行不是合法 JSON：不是 CuinCodeBench 备份文件')
  }
  const checked = v2MetaSchema.safeParse(parsed)
  if (!checked.success) {
    // 显式格式检测（禁止按首字符猜版本）
    const raw = parsed as { format?: unknown } | null
    if (raw !== null && typeof raw === 'object' && raw.format !== undefined && raw.format !== BACKUP_V2_FORMAT_NAME) {
      throw validationError('这不是 CuinCodeBench 完整备份文件（可能是题目导出 JSON，请使用题库导入功能）')
    }
    throw validationError('备份文件 meta 头不合法：文件可能来自不兼容的版本')
  }
  const meta = checked.data
  if (meta.version > BACKUP_V2_MAX_IMPORT_VERSION) {
    throw validationError(
      `备份版本过新（v${meta.version}），当前应用支持到 v${BACKUP_V2_MAX_IMPORT_VERSION}。请先升级应用。`
    )
  }
  if (meta.lineEnding !== undefined && meta.lineEnding !== 'lf') {
    throw validationError('备份文件行尾格式不支持（需要 LF）')
  }
  return meta
}

/** 供 IPC 层使用：head 4KB 检测格式（显式，不猜） */
export function detectFormatFromHead(head: Buffer): ReturnType<typeof detectBackupFormat> {
  return detectBackupFormat(head)
}
