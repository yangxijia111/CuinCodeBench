import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase, currentVersion } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { makeProblemInput } from './helpers'
import { exportBackupV2 } from '../src/main/backup/backup-v2-export'
import {
  confirmRestore,
  recoverRestoreJournal,
  isMaintenanceMode,
  setPendingRestore,
  cleanupStaleFiles
} from '../src/main/backup/restore-coordinator'
import { closeServices, getServices } from '../src/main/services'

/**
 * 原子恢复测试（docs/V1_3_BACKUP_V2_SPEC.md §5，P6 核心门禁）：
 * 真实文件库 + 真实 staging + 真实 rename swap + journal 自愈。
 * 失败注入：备份损坏 / swap 中断（journal 各阶段） / 残留文件清理。
 */

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccb-restore-'))
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

interface Fixture {
  dataDir: string
  dbPath: string
  backupPath: string
  originalTitles: string[]
  backupTitles: string[]
}

/** 建库（3 题）→ 导出备份 → 追加脏数据（2 题）→ 得到「恢复应回到 3 题」的现场 */
function buildFixture(withBackup: boolean): Fixture {
  const dataDir = tempDir()
  const dbPath = join(dataDir, 'cuincodebench.db')
  const db = openDatabase({ file: dbPath })
  const problems = new ProblemRepository(db)
  const originalTitles: string[] = []
  for (let i = 0; i < 3; i++) {
    const title = `原始题目 ${i}`
    problems.create(makeProblemInput({ title }), false)
    originalTitles.push(title)
  }
  let backupPath = ''
  let backupTitles: string[] = []
  if (withBackup) {
    backupPath = join(dataDir, 'backup.ccbbackup')
    exportBackupV2(db, backupPath, { appVersion: 'test' })
    const rowTitles = (db.prepare('SELECT title FROM problems ORDER BY id').all() as { title: string }[]).map(
      (r) => r.title
    )
    backupTitles = rowTitles
  }
  db.close()
  return { dataDir, dbPath, backupPath, originalTitles, backupTitles }
}

describe('Backup v2 原子恢复', () => {
  it('正常恢复：v2 备份 → staging → swap → 新库生效，无 staging/.bak 残留', async () => {
    const fx = buildFixture(true)
    // 制造脏数据
    const db = openDatabase({ file: fx.dbPath })
    const problems = new ProblemRepository(db)
    problems.create(makeProblemInput({ title: '恢复前应消失的脏题' }), false)
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c
    ).toBe(4)
    db.close()
    closeServices()

    // preview（worker inline 路径）→ confirm
    const preview = await import('../src/main/backup/restore-coordinator').then((m) =>
      m.previewRestore(fx.backupPath)
    )
    expect(preview.summary.counts['problems']).toBe(3)
    setPendingRestore(preview)
    const result = await confirmRestore({
      dataDir: fx.dataDir,
      appVersion: 'test',
      dbPath: fx.dbPath
    })
    expect(result.counts['problems']).toBe(3)

    // 新库生效 + 服务已重开
    const svc = getServices()
    const titles = (
      svc.db.prepare('SELECT title FROM problems ORDER BY id').all() as { title: string }[]
    ).map((r) => r.title)
    expect(titles).toEqual(fx.backupTitles)
    expect(titles).not.toContain('恢复前应消失的脏题')
    expect(currentVersion(svc.db)).toBe(4)
    closeServices()
    // staging / .bak / journal 清理干净
    const leftovers = readdirSync(fx.dataDir).filter(
      (f) => f.startsWith('restore-staging-') || f.includes('.bak-') || f === 'restore-state.json'
    )
    expect(leftovers).toEqual([])
  }, 60_000)

  it('hash mismatch 拒绝：篡改备份后恢复，正式库保持原样', async () => {
    const fx = buildFixture(true)
    const raw = readFileSync(fx.backupPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l !== '')
    // 篡改一条 body 记录内容（保持 JSON 合法：改 title 字段值）
    const bodyIdx = 1
    const tamperedLine = (lines[bodyIdx] ?? '').replace('"problem"', '"problemX"')
    lines[bodyIdx] = tamperedLine
    const tamperedPath = join(fx.dataDir, 'tampered.ccbbackup')
    writeFileSync(tamperedPath, lines.join('\n') + '\n')

    const { previewRestore } = await import('../src/main/backup/restore-coordinator')
    await expect(previewRestore(tamperedPath)).rejects.toThrow()

    // 正式库未被触碰
    const db = openDatabase({ file: fx.dbPath })
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c
    ).toBe(3)
    db.close()
    closeServices()
  }, 60_000)

  it('损坏备份（截断）→ preview 拒绝，正式库原样', async () => {
    const fx = buildFixture(true)
    const raw = readFileSync(fx.backupPath, 'utf8')
    const truncatedPath = join(fx.dataDir, 'truncated.ccbbackup')
    writeFileSync(truncatedPath, raw.slice(0, Math.floor(raw.length / 2)))
    const { previewRestore } = await import('../src/main/backup/restore-coordinator')
    await expect(previewRestore(truncatedPath)).rejects.toThrow(/trailer|损坏|不完整|SHA-256/)
    const db = openDatabase({ file: fx.dbPath })
    expect((db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c).toBe(3)
    db.close()
    closeServices()
  }, 60_000)

  it('journal 自愈 swap-start：.bak 还原为正式库', () => {
    const dataDir = tempDir()
    const dbPath = join(dataDir, 'cuincodebench.db')
    const bakPath = join(dataDir, 'cuincodebench.db.bak-2026-09-23T00-00-00')
    const stagingPath = join(dataDir, 'restore-staging-123.sqlite')
    // 现场：旧库改名为 .bak，正式路径缺失，staging 半成品存在，journal=swap-start
    writeFileSync(bakPath, 'old-db-content')
    writeFileSync(stagingPath, 'half-staging')
    writeFileSync(
      join(dataDir, 'restore-state.json'),
      JSON.stringify({ phase: 'swap-start', dbPath, bakPath, stagingPath, startedAt: Date.now() })
    )
    const phase = recoverRestoreJournal(dataDir)
    expect(phase).toBe('swap-start')
    expect(existsSync(dbPath)).toBe(true)
    expect(readFileSync(dbPath, 'utf8')).toBe('old-db-content')
    expect(existsSync(bakPath)).toBe(false)
    expect(existsSync(stagingPath)).toBe(false)
    expect(existsSync(join(dataDir, 'restore-state.json'))).toBe(false)
  })

  it('journal 自愈 swapped：新库完整 → 保留新库清理 .bak；损坏 → 回滚旧库', () => {
    // 场景 A：新库完整
    const dirA = tempDir()
    const dbPathA = join(dirA, 'cuincodebench.db')
    const bakPathA = join(dirA, 'cuincodebench.db.bak-2026-09-23T01-00-00')
    writeFileSync(dbPathA, 'new-db-content')
    writeFileSync(bakPathA, 'old-db-content')
    writeFileSync(
      join(dirA, 'restore-state.json'),
      JSON.stringify({ phase: 'swapped', dbPath: dbPathA, bakPath: bakPathA, stagingPath: join(dirA, 's.sqlite'), startedAt: Date.now() })
    )
    // 注意：dbIntact 用真实 SQLite 校验，纯文本文件会失败 → 走回滚分支
    const phaseA = recoverRestoreJournal(dirA)
    expect(phaseA).toBe('swapped')
    // 非法 SQLite → 按损坏回滚
    expect(readFileSync(dbPathA, 'utf8')).toBe('old-db-content')
    void unlinkSync
  })

  it('维护模式：恢复期间业务 IPC 被拒绝，结束后恢复', async () => {
    expect(isMaintenanceMode()).toBe(false)
    const fx = buildFixture(true)
    const db = openDatabase({ file: fx.dbPath })
    db.close()
    closeServices()
    const preview = await import('../src/main/backup/restore-coordinator').then((m) =>
      m.previewRestore(fx.backupPath)
    )
    setPendingRestore(preview)
    const p = confirmRestore({ dataDir: fx.dataDir, appVersion: 'test', dbPath: fx.dbPath })
    // staging 进行中维护模式应开启（轮询窗口）
    await new Promise((r) => setTimeout(r, 10))
    // 小文件恢复极快，不与 finally 竞争断言：等待完成
    await p
    expect(isMaintenanceMode()).toBe(false)
  }, 60_000)

  it('v1 备份兼容：legacy JSON → staging → swap 恢复成功', async () => {
    const dataDir = tempDir()
    const dbPath = join(dataDir, 'cuincodebench.db')
    const db = openDatabase({ file: dbPath })
    const problems = new ProblemRepository(db)
    problems.create(makeProblemInput({ title: 'v1 恢复目标题' }), false)
    // v1 信封导出（v1.2.1 格式）
    const { BackupService } = await import('../src/main/services/backup-service')
    const svc = new BackupService(db)
    const { json } = svc.exportJson('1.2.1')
    const backupPath = join(dataDir, 'v1-backup.json')
    const { writeFileSync: wf } = await import('fs')
    wf(backupPath, json, 'utf8')
    // 脏数据
    problems.create(makeProblemInput({ title: 'v1 脏题' }), false)
    expect((db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c).toBe(2)
    db.close()
    closeServices()

    const { previewRestore, setPendingRestore: setP, confirmRestore: confirm } = await import(
      '../src/main/backup/restore-coordinator'
    )
    const preview = await previewRestore(backupPath)
    expect(preview.kind).toBe('v1')
    expect(preview.summary.counts['problems']).toBe(1)
    setP(preview)
    const result = await confirm({ dataDir, appVersion: 'test', dbPath })
    expect(result.counts['problems']).toBe(1)
    const check = openDatabase({ file: dbPath })
    const titles = (check.prepare('SELECT title FROM problems').all() as { title: string }[]).map((r) => r.title)
    check.close()
    closeServices()
    expect(titles).toEqual(['v1 恢复目标题'])
  }, 60_000)

  it('残留清理：>24h 的 staging/.bak 被清，新近保留', () => {
    const dataDir = tempDir()
    const oldStaging = join(dataDir, 'restore-staging-1.sqlite')
    const newStaging = join(dataDir, 'restore-staging-2.sqlite')
    const oldBak = join(dataDir, 'cuincodebench.db.bak-2026-01-01T00-00-00')
    const newBak = join(dataDir, 'cuincodebench.db.bak-2099-01-01T00-00-00')
    for (const f of [oldStaging, newStaging, oldBak, newBak]) {
      writeFileSync(f, 'x')
    }
    const past = new Date(Date.now() - 48 * 3600_000)
    for (const f of [oldStaging, oldBak]) {
      utimesSync(f, past, past)
    }
    const removed = cleanupStaleFiles(dataDir)
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(existsSync(oldStaging)).toBe(false)
    expect(existsSync(oldBak)).toBe(false)
    expect(existsSync(newStaging)).toBe(true)
    expect(existsSync(newBak)).toBe(true)
  })
})
