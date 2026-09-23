import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { HistoryRepository } from '../src/main/db/repositories/history-repository'
import { makeProblemInput } from './helpers'
import { exportBackupV2 } from '../src/main/backup/backup-v2-export'
import { validateBackupV2 } from '../src/main/backup/backup-v2-import'
import {
  confirmRestore,
  previewRestore,
  setPendingRestore
} from '../src/main/backup/restore-coordinator'
import { closeServices } from '../src/main/services'
import { startJob } from '../src/main/backup/backup-worker-client'
import { executeNative } from '../src/main/runner/native-launcher'
import { execute } from '../src/main/runner/execute'
import { overrideLauncherPath } from '../src/main/runner/resolve-launcher'
import { nativeExeExists, nativeExePath, pythonExe } from './native-helpers'

/**
 * v1.3 性能门槛 + 失败注入（docs/V1_3_TEST_PLAN §3-§6，P9）。
 * 规模：10k 提交 / 20k 明细 / 100k+ 行（CI 规模）；导出/预览/恢复 < 30s、内存有界。
 */

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccb-perf-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) {
    try {
      closeServices()
    } catch {
      // 未初始化
    }
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

function buildLargeDb(file: string, submissionCount: number): void {
  const db = openDatabase({ file })
  const problems = new ProblemRepository(db)
  const history = new HistoryRepository(db)
  const problem = problems.create(makeProblemInput({ testCases: [{ stdin: '1', expectedStdout: '1', timeoutMs: 1000 }] }), false)
  const caseId = problem.testCases[0]?.id ?? ''
  const insert = db.transaction((i: number) => {
    for (let k = 0; k < submissionCount; k++) {
      history.insertSubmission(
        { problemId: problem.id, language: 'python', code: `print(${i * submissionCount + k})`, status: 'accepted', passedCount: 1, totalCount: 1, durationMs: 5 },
        [{ testCaseId: caseId, order: 0, stdin: '1', expected: '1', actual: '1', stderr: '', status: 'accepted', exitCode: 0, durationMs: 5 }]
      )
    }
  })
  for (let i = 0; i < 8; i++) insert(i)
  db.close()
}

describe('性能门槛（P13）', () => {
  it(
    '备份规模：10k 提交 / 100k+ 行 导出 < 30s、预览 < 20s、恢复 < 60s、内存有界',
    async () => {
      const dir = tempDir()
      const dbFile = join(dir, 'cuincodebench.db')
      const tGen = Date.now()
      buildLargeDb(dbFile, 10_000)
      console.log(`[perf] 生成 10k 提交库耗时 ${Date.now() - tGen}ms`)

      const db = openDatabase({ file: dbFile })
      const rowCount =
        (db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number }).c +
        (db.prepare('SELECT COUNT(*) AS c FROM test_case_results').get() as { c: number }).c
      expect(rowCount).toBeGreaterThanOrEqual(20_000)

      const rssBefore = process.memoryUsage().rss
      const tExport = Date.now()
      const outPath = join(dir, 'big.ccbbackup')
      const result = exportBackupV2(db, outPath, { appVersion: 'perf' })
      const exportMs = Date.now() - tExport
      expect(result.counts.submission).toBe(80_000)
      expect(exportMs).toBeLessThan(30_000)
      console.log(`[perf] 导出 ${result.bodyBytes / 1024 / 1024 | 0}MB / ${exportMs}ms`)

      const tPreview = Date.now()
      const checked = await validateBackupV2(outPath)
      const previewMs = Date.now() - tPreview
      expect(checked.counts.submission).toBe(80_000)
      expect(previewMs).toBeLessThan(20_000)
      console.log(`[perf] 预览 ${previewMs}ms`)
      db.close()

      // 流式性证据：导出后主进程 RSS 增长有界（< 300MB；全量对象方案在此规模为数GB级）
      const rssAfter = process.memoryUsage().rss
      expect(rssAfter - rssBefore).toBeLessThan(300 * 1024 * 1024)

      // 恢复（staging + swap）
      closeServices()
      const pending = await previewRestore(outPath)
      setPendingRestore(pending)
      const tRestore = Date.now()
      const restored = await confirmRestore({ dataDir: dir, appVersion: 'perf', dbPath: dbFile })
      const restoreMs = Date.now() - tRestore
      expect(restored.counts['problems']).toBe(1)
      expect(restoreMs).toBeLessThan(60_000)
      console.log(`[perf] 恢复（staging+swap）${restoreMs}ms`)
      closeServices()
    },
    180_000
  )

  it('导出取消：协作式取消生效且无临时文件残留', async () => {
    const dir = tempDir()
    const dbFile = join(dir, 'cuincodebench.db')
    buildLargeDb(dbFile, 6_000)
    const outPath = join(dir, 'cancelled.ccbbackup')
    const job = startJob({ kind: 'export', dbPath: dbFile, outPath, appVersion: 'perf' })
    // 立即取消（worker 内每 1000 条检查）
    job.cancel()
    await expect(job.promise).rejects.toThrow(/取消/)
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
  }, 120_000)
})

describe('Runner 性能（P13）', () => {
  it.skipIf(!nativeExeExists('ccb-launcher.exe'))('launcher 启动开销：hello world 均值 ≤ fallback + 100ms', async () => {
    const LAUNCHER = nativeExePath('ccb-launcher.exe')
    overrideLauncherPath(LAUNCHER)
    const py = pythonExe()
    const dir = tempDir()
    const opts = { program: py, args: ['-c', 'print(1)'], cwd: dir, stdin: '', timeoutMs: 10_000 }
    // 预热
    await execute(opts)
    await executeNative(opts, {}, LAUNCHER)
    const N = 12
    const tLegacy: number[] = []
    const tNative: number[] = []
    for (let i = 0; i < N; i++) {
      let t = Date.now()
      await execute(opts)
      tLegacy.push(Date.now() - t)
      t = Date.now()
      await executeNative(opts, {}, LAUNCHER)
      tNative.push(Date.now() - t)
    }
    const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length
    const legacyAvg = avg(tLegacy.slice(2))
    const nativeAvg = avg(tNative.slice(2))
    console.log(`[perf] fallback 均值 ${legacyAvg.toFixed(0)}ms，native 均值 ${nativeAvg.toFixed(0)}ms`)
    expect(nativeAvg).toBeLessThan(legacyAvg + 100)
    overrideLauncherPath(undefined)
  }, 180_000)
})
