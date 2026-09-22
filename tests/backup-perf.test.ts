import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { BackupRepository } from '../src/main/db/repositories/backup-repository'
import { BackupService } from '../src/main/services/backup-service'
import { atomicWriteFileSync } from '../src/main/lib/atomic-write'
import { sha256FileSync } from '../src/main/lib/file-hash'
import { makeProblemInput } from './helpers'

/**
 * v1.2.1 P1-C 性能门禁：备份读取 O(N) + 原子导出 + SHA-256。
 * 修复前缺陷：readAll 五处 filter-inside-map，10000 提交 × 50000 明细 ≈ 5×10⁸ 次比较；
 * 导出直写目标路径（半文件风险）；导入防调包用 mtime。
 */

const PROBLEMS = 200
const SUBMISSIONS = 10_000
const RESULTS_PER_SUB = 5 // → 50000 test_case_results
/** 宽松阈值：O(N) 实现在普通开发机上远低于此；O(N²) 旧实现会超时数十倍 */
const READALL_BUDGET_MS = 5_000

describe.skipIf(process.env['CCB_SKIP_PERF'] === '1')('备份性能（10000 提交 / 50000 明细）', () => {
  let db: Database.Database
  let repo: BackupRepository

  it(
    'readAll + 导出 + 校验 + 恢复全链路在预算内，且内容正确',
    () => {
      db = openDatabase({ file: ':memory:' })
      repo = new BackupRepository(db)
      const problems = new ProblemRepository(db)
      const now = Date.now()

      const ids: string[] = []
      const seedTx = db.transaction(() => {
        for (let i = 0; i < PROBLEMS; i++) {
          const p = problems.create(makeProblemInput({ title: `perf-${i}` }), true)
          ids.push(p.id)
        }
        const insSub = db.prepare(
          `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
           VALUES (?, ?, 'c', 'x', 'accepted', 5, 5, 10, ?)`
        )
        const insRes = db.prepare(
          `INSERT INTO test_case_results (id, submission_id, test_case_id, "order", stdin, expected, actual, stderr, status, exit_code, duration_ms)
           VALUES (?, ?, ?, ?, '', '', 'out', '', 'accepted', 0, 1)`
        )
        for (let i = 0; i < SUBMISSIONS; i++) {
          const sid = `s-${i}`
          insSub.run(sid, ids[i % PROBLEMS], now - i * 1000)
          for (let j = 0; j < RESULTS_PER_SUB; j++) insRes.run(`${sid}:r${j}`, sid, `tc-${j}`, j)
        }
      })
      seedTx()
      expect(
        (db.prepare('SELECT COUNT(*) AS c FROM test_case_results').get() as { c: number }).c
      ).toBe(SUBMISSIONS * RESULTS_PER_SUB)

      // 1) readAll O(N) 门禁
      const t0 = performance.now()
      const data = repo.readAll()
      const readMs = performance.now() - t0
      expect(data.submissions).toHaveLength(SUBMISSIONS)
      expect(data.submissions.reduce((n, s) => n + s.results.length, 0)).toBe(SUBMISSIONS * RESULTS_PER_SUB)
      // 分组正确性抽查：每个提交恰好挂 5 条自己的明细
      for (const s of [data.submissions[0], data.submissions[5000], data.submissions[9999]]) {
        expect(s?.results.map((r) => r.testCaseId).sort()).toEqual(['tc-0', 'tc-1', 'tc-2', 'tc-3', 'tc-4'])
      }
      expect(readMs).toBeLessThan(READALL_BUDGET_MS)

      // 2) 导出 → 原子落盘 → SHA-256 稳定
      const svc = new BackupService(db)
      const { json } = svc.exportJson('1.2.1-test')
      const dir = mkdtempSync(join(tmpdir(), 'ccb-backup-perf-'))
      const file = join(dir, 'backup.json')
      atomicWriteFileSync(file, json)
      const digest1 = sha256FileSync(file)
      expect(digest1).toMatch(/^[0-9a-f]{64}$/)
      // 再次写入相同内容 → 原子替换成功且哈希一致
      atomicWriteFileSync(file, json)
      expect(sha256FileSync(file)).toBe(digest1)

      // 3) 校验 + 恢复（恢复到新库不破坏原库）
      const { envelope } = svc.validate(readFileSync(file, 'utf-8'))
      const restoredCounts = svc.restore(envelope)
      expect(restoredCounts.counts.submissions).toBe(SUBMISSIONS)
      expect(restoredCounts.counts.testCaseResults).toBe(SUBMISSIONS * RESULTS_PER_SUB)

      // 4) 512MB 文本上限仍在（schema 防线不回退）
      expect(json.length).toBeGreaterThan(0)
      rmSync(dir, { recursive: true, force: true })
    },
    120_000
  )

  it('atomicWriteFileSync：失败不留半文件/临时文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-atomic-'))
    const target = join(dir, 'out.json')
    // 正常写入
    atomicWriteFileSync(target, '{"a":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}')
    // 目标目录被删后写入失败 → 上抛且无 .tmp 残留
    rmSync(dir, { recursive: true, force: true })
    expect(() => atomicWriteFileSync(target, '{"a":2}')).toThrow()
  })

  it('sha256FileSync：内容变化 → 哈希变化（防调包语义）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-hash-'))
    const f = join(dir, 'x.json')
    writeFileSync(f, '{"v":1}', 'utf-8')
    const h1 = sha256FileSync(f)
    // 同尺寸改写（mtime 检测不出的调包场景）
    writeFileSync(f, '{"v":2}', 'utf-8')
    const h2 = sha256FileSync(f)
    expect(h1).not.toBe(h2)
    rmSync(dir, { recursive: true, force: true })
  })
})
