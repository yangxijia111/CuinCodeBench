import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase } from '../src/main/db/connection'
import { exportBackupV2 } from '../src/main/backup/backup-v2-export'
import { validateBackupV2 } from '../src/main/backup/backup-v2-import'
import {
  BACKUP_V2_VERSION,
  detectBackupFormat,
  type V2RecordType
} from '../src/main/backup/backup-v2-format'
import { makeProblemInput } from './helpers'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { randomUUID } from 'crypto'

/**
 * Backup v2 回环测试（docs/V1_3_BACKUP_V2_SPEC.md §1-§3）：
 * 建库 → 流式导出 → 结构校验（hash/counts 对拍）→ 格式检测。
 * staging 恢复与失败注入见 backup-v2-restore.test.ts。
 */

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccb-v2-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  // 尽力而为清理（Windows 上杀软/读流可能延迟释放句柄；单元测试临时目录
  // 位于 os.tmpdir()，系统会兜底回收——清理失败不作为门禁失败）
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // 交给系统临时目录回收
    }
  }
})

function buildSampleDb(file: string): void {
  const db = openDatabase({ file })
  const problems = new ProblemRepository(db)
  const history = new HistoryRepository(db)
  for (let i = 0; i < 5; i++) {
    const p = problems.create(
      makeProblemInput({ title: `v2 题目 ${i} 中文✓`, testCases: [
        { stdin: '1 2', expectedStdout: '3', timeoutMs: 1000 },
        { stdin: '3 4', expectedStdout: '7', timeoutMs: 1000 }
      ] }),
      false
    )
    history.insertSubmission(
      { problemId: p.id, language: 'cpp', code: 'int main(){}', status: 'accepted', passedCount: 2, totalCount: 2, durationMs: 10 },
      [
        { testCaseId: p.testCases[0]?.id ?? '', order: 0, stdin: '1 2', expected: '3', actual: '3', stderr: '', status: 'accepted', exitCode: 0, durationMs: 5, terminationReason: null },
        { testCaseId: p.testCases[1]?.id ?? '', order: 1, stdin: '3 4', expected: '7', actual: '7', stderr: '', status: 'accepted', exitCode: 0, durationMs: 5, terminationReason: null }
      ]
    )
  }
  // 学习路线（直接 SQL 插入，与 seed 同构；验证 learning_path 记录导出）
  const pathId = `lp-${randomUUID()}`
  db.prepare(
    `INSERT INTO learning_paths (id, slug, title, description, is_builtin, sort_order) VALUES (?, ?, ?, ?, 0, 0)`
  ).run(pathId, 'v2-path', 'v2 路线', '')
  const stageId = `st-${randomUUID()}`
  db.prepare(
    `INSERT INTO learning_stages (id, path_id, title, description, sort_order) VALUES (?, ?, ?, '', 0)`
  ).run(stageId, pathId, 'v2 阶段')
  db.prepare(
    `INSERT INTO knowledge_points (id, stage_id, name, description, sort_order, tags) VALUES (?, ?, ?, '', 0, '[]')`
  ).run(`kp-${randomUUID()}`, stageId, 'v2 知识点')
}

describe('Backup v2 格式回环', () => {
  it('导出 → 流式校验：meta/记录/trailer/逐表计数全对上', async () => {
    const dir = tempDir()
    const dbFile = join(dir, 'cuincodebench.db')
    buildSampleDb(dbFile)
    const db = openDatabase({ file: dbFile })

    const outPath = join(dir, 'backup.ccbbackup')
    const result = exportBackupV2(db, outPath, { appVersion: '1.3.0-test' })
    db.close()

    expect(result.counts.problem).toBe(5)
    expect(result.counts.submission).toBe(5)
    expect(result.counts.learning_path).toBe(1)
    expect(result.bodyBytes).toBeGreaterThan(0)

    // 文件结构：首行 meta、末行 trailer、NDJSON 行数 = 2 + 总记录数
    const raw = readFileSync(outPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l !== '')
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(first['type']).toBe('meta')
    expect(first['format']).toBe('cuincodebench.backup')
    expect(first['version']).toBe(BACKUP_V2_VERSION)
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
    expect(last['type']).toBe('trailer')
    expect(last['bodySha256']).toBe(result.bodySha256)
    const totalRecords = Object.values(result.counts).reduce((n, v) => n + (v ?? 0), 0)
    expect(lines.length).toBe(totalRecords + 2)

    // 流式校验（含 hash/counts 三重对拍）
    const checked = await validateBackupV2(outPath)
    expect(checked.meta.appVersion).toBe('1.3.0-test')
    expect(checked.counts.problem).toBe(5)
    expect(checked.summary.counts.problem).toBe(5)
  })

  it('原子落盘：无临时文件残留', async () => {
    const dir = tempDir()
    const dbFile = join(dir, 'cuincodebench.db')
    buildSampleDb(dbFile)
    const db = openDatabase({ file: dbFile })
    const outPath = join(dir, 'backup2.ccbbackup')
    exportBackupV2(db, outPath, { appVersion: '1.3.0-test' })
    db.close()
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
    expect(statSync(outPath).size).toBeGreaterThan(500)
  })

  it('格式检测：v2 meta / v1 单 JSON / 无关文件显式区分', async () => {
    const dir = tempDir()
    // v2：读首行足够
    expect(detectBackupFormat(Buffer.from('{"type":"meta","format":"cuincodebench.backup","version":2}\n'))).toEqual({ kind: 'v2' })
    // v1：单 JSON 信封
    expect(
      detectBackupFormat(Buffer.from(JSON.stringify({ format: 'cuincodebench.backup', version: 1 })))
    ).toEqual({ kind: 'v1' })
    // 题目导出 JSON
    expect(
      detectBackupFormat(Buffer.from(JSON.stringify({ format: 'cuincodebench.problems' })))
    ).toMatchObject({ kind: 'unknown' })
    // 截断的 v1（4KB head 无法整体 parse）→ v1 候选交 legacy 校验
    expect(detectBackupFormat(Buffer.from('{"format":"cuincodebench.backup","versi'))).toEqual({ kind: 'v1' })
  })

  it('篡改 body 任一字节 → hash mismatch 拒绝（50 组随机位翻转）', async () => {
    const dir = tempDir()
    const dbFile = join(dir, 'cuincodebench.db')
    buildSampleDb(dbFile)
    const db = openDatabase({ file: dbFile })
    const outPath = join(dir, 'backup3.ccbbackup')
    exportBackupV2(db, outPath, { appVersion: 'test' })
    db.close()

    const raw = Buffer.from(readFileSync(outPath, 'utf8'), 'utf8')
    const metaEnd = raw.indexOf(0x0a) + 1 // meta 行末 LF 之后为 hash 域起点
    const trailerStart = raw.toString('utf8').lastIndexOf('{"type":"trailer"')
    expect(trailerStart).toBeGreaterThan(metaEnd)

    let rejected = 0
    for (let i = 0; i < 50; i++) {
      const tampered = Buffer.from(raw)
      const pos = metaEnd + Math.floor(Math.random() * (trailerStart - metaEnd))
      tampered[pos] = tampered[pos] ^ 0x01
      const p = join(dir, `tampered-${i}.ccbbackup`)
      const { writeFileSync } = await import('fs')
      writeFileSync(p, tampered)
      try {
        await validateBackupV2(p)
      } catch {
        rejected++
      }
    }
    expect(rejected).toBe(50)
  })

  it('缺 trailer（截断文件）与未知记录类型均拒绝', async () => {
    const dir = tempDir()
    const dbFile = join(dir, 'cuincodebench.db')
    buildSampleDb(dbFile)
    const db = openDatabase({ file: dbFile })
    const outPath = join(dir, 'backup4.ccbbackup')
    exportBackupV2(db, outPath, { appVersion: 'test' })
    db.close()

    const raw = readFileSync(outPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l !== '')

    // 截断：去掉 trailer
    const truncated = join(dir, 'truncated.ccbbackup')
    const { writeFileSync } = await import('fs')
    writeFileSync(truncated, lines.slice(0, -1).join('\n') + '\n')
    await expect(validateBackupV2(truncated)).rejects.toThrow(/trailer/)

    // 未知类型
    const bogus = join(dir, 'bogus.ccbbackup')
    const bodyLines = [...lines.slice(1, -1), JSON.stringify({ type: 'future_type', data: {} })]
    const meta = JSON.parse(lines[0] ?? '{}') as { createdAt: number }
    const { createHash } = await import('crypto')
    const hash = createHash('sha256')
    for (const l of bodyLines) hash.update(Buffer.from(l + '\n', 'utf8'))
    const trailer2 = JSON.stringify({
      type: 'trailer',
      counts: { future_type: 1 },
      bodySha256: hash.digest('hex'),
      bodyBytes: bodyLines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0)
    })
    writeFileSync(bogus, [JSON.stringify(meta), ...bodyLines, trailer2].join('\n') + '\n')
    await expect(validateBackupV2(bogus)).rejects.toThrow(/无法识别|不兼容/)
  })
})
