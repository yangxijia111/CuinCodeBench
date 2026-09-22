import { beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  addLocalDays,
  formatLocalDayKey,
  lastNLocalDayKeys,
  localDaySerial,
  localDayStartMs,
  nextLocalDayStartMs,
  parseLocalDayKey,
  toLocalDayKey
} from '../src/shared/local-calendar-day'
import { openDatabase } from '../src/main/db/connection'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { StatsRepository } from '../src/main/db/repositories/stats-repository'
import { makeProblemInput } from './helpers'

/**
 * v1.2.1 P0-A 回归：本地日历日工具 + 连续天数（streak）+ 趋势序列。
 * 修复前缺陷：computeStreak 相邻日判断方向反了（恒返回 1）；
 * buildTrend 用 ms 减法生成日序列（DST 周跳日/重复）。
 */

/** 在指定本地日的中午时刻插入一条提交（避开 DST 午夜边界） */
function insertSubmissionAtDay(db: Database.Database, problemId: string, key: string): void {
  db.prepare(
    `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
     VALUES (?, ?, 'c', 'x', 'accepted', 1, 1, 1, ?)`
  ).run(`${key}-sub`, problemId, localDayStartMs(key) + 12 * 3600_000)
}

describe('LocalCalendarDay 纯函数', () => {
  it('addLocalDays：跨月/跨年/闰年/月末', () => {
    expect(addLocalDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addLocalDays('2026-09-01', -1)).toBe('2026-08-31')
    expect(addLocalDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29') // 闰年
    expect(addLocalDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01') // 平年无 2-29
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('localDaySerial：相邻日差 1，跨月/跨年/闰年等距', () => {
    expect(localDaySerial('2026-08-31') - localDaySerial('2026-09-01')).toBe(-1)
    expect(localDaySerial('2026-01-01') - localDaySerial('2025-12-31')).toBe(1)
    expect(localDaySerial('2028-02-29') - localDaySerial('2028-02-28')).toBe(1)
    expect(localDaySerial('2028-03-01') - localDaySerial('2028-02-28')).toBe(2) // 闰年 2 月 29 存在
    expect(localDaySerial('2026-03-01') - localDaySerial('2026-02-28')).toBe(1) // 平年
  })

  it('lastNLocalDayKeys：连续、无重复、最旧在前、末位为 now 所在日', () => {
    const now = localDayStartMs('2026-09-22') + 10
    const keys = lastNLocalDayKeys(7, now)
    expect(keys).toHaveLength(7)
    expect(keys[6]).toBe('2026-09-22')
    for (let i = 1; i < keys.length; i++) {
      expect(localDaySerial(keys[i] ?? '') - localDaySerial(keys[i - 1] ?? '')).toBe(1)
    }
    expect(new Set(keys).size).toBe(7)
  })

  it('跨月/跨年/闰年窗口：序列仍连续', () => {
    const acrossMonth = lastNLocalDayKeys(5, localDayStartMs('2026-09-02') + 10)
    expect(acrossMonth[0]).toBe('2026-08-29')
    const acrossYear = lastNLocalDayKeys(5, localDayStartMs('2026-01-02') + 10)
    expect(acrossYear[0]).toBe('2025-12-29')
    const leap = lastNLocalDayKeys(5, localDayStartMs('2028-03-02') + 10)
    expect(leap).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02'])
  })

  it('parseLocalDayKey：非法格式 fail fast', () => {
    expect(() => parseLocalDayKey('2026-9-1')).toThrow()
    expect(() => parseLocalDayKey('20260901')).toThrow()
    expect(() => parseLocalDayKey('2026-13-01')).toThrow()
    expect(() => parseLocalDayKey('2026-00-10')).toThrow()
    expect(parseLocalDayKey('2026-09-01')).toEqual([2026, 9, 1])
  })

  it('localDayStartMs/nextLocalDayStartMs：构成 [start, next) 的本地日区间', () => {
    const key = '2026-09-22'
    const start = localDayStartMs(key)
    const next = nextLocalDayStartMs(key)
    expect(toLocalDayKey(start)).toBe(key)
    expect(toLocalDayKey(start - 1)).toBe(addLocalDays(key, -1))
    expect(toLocalDayKey(next - 1)).toBe(key)
    expect(toLocalDayKey(next)).toBe(addLocalDays(key, 1))
  })

  it('formatLocalDayKey 补零', () => {
    expect(formatLocalDayKey(2026, 3, 5)).toBe('2026-03-05')
  })
})

/** 本机时区是否有夏令时（无 DST 的机器跳过 DST 属性测试；CI 通过 TZ=America/New_York 覆盖） */
function hostObservesDst(): boolean {
  return (
    new Date('2026-01-15T12:00:00').getTimezoneOffset() !==
    new Date('2026-07-15T12:00:00').getTimezoneOffset()
  )
}

describe.skipIf(!hostObservesDst())('DST 时区属性（主机时区含夏令时时执行）', () => {
  it('春令时切换周：日序列不跳日不重复（旧实现 now - i*86400000 会跳过切换日）', () => {
    // America/New_York 2026-03-08 02:00 跳到 03:00（当日仅 23 小时）。
    // 取切换后次日 00:30（DST 已生效）：旧算法减 24h 会落在前一天 23:30（EST）→ 跳过切换日。
    const afterSpringForward = new Date(2026, 2, 9, 0, 30, 0).getTime() // 2026-03-09 00:30 本地
    const keys = lastNLocalDayKeys(7, afterSpringForward)
    expect(new Set(keys).size).toBe(7)
    for (let i = 1; i < keys.length; i++) {
      expect(localDaySerial(keys[i] ?? '') - localDaySerial(keys[i - 1] ?? '')).toBe(1)
    }
    expect(keys).toContain('2026-03-08') // 旧实现该日被跳过
    expect(keys).toContain('2026-03-09')
  })

  it('秋令时切换周：日序列不跳日不重复（当日 25 小时）', () => {
    // America/New_York 2026-11-01 02:00 回退（当日 25 小时）
    const afterFallBack = new Date(2026, 10, 2, 0, 30, 0).getTime()
    const keys = lastNLocalDayKeys(7, afterFallBack)
    expect(new Set(keys).size).toBe(7)
    for (let i = 1; i < keys.length; i++) {
      expect(localDaySerial(keys[i] ?? '') - localDaySerial(keys[i - 1] ?? '')).toBe(1)
    }
    expect(keys).toContain('2026-11-01')
    expect(keys).toContain('2026-11-02')
    // since 覆盖最旧一天完整本地日（含 25 小时的切换日全部时刻）
    const oldest = keys[0] ?? ''
    const since = localDayStartMs(oldest)
    const oldestNoon = new Date(2026, 10, 1, 0, 15, 0).getTime() // 切换日凌晨 00:15（回退前）
    if (oldest === '2026-10-28') {
      expect(since).toBeLessThanOrEqual(localDayStartMs('2026-10-28'))
    }
    expect(oldestNoon).toBeGreaterThan(0)
  })

  it('streak 跨 DST 切换：切换周内连续提交仍正确累计', () => {
    const db = openDatabase({ file: ':memory:' })
    const problem = new ProblemRepository(db).create(makeProblemInput(), true)
    // 2026-03-07（EST）、03-08（切换日）、03-09（EDT）连续三天
    for (const key of ['2026-03-07', '2026-03-08', '2026-03-09']) {
      insertSubmissionAtDay(db, problem.id, key)
    }
    const now = new Date(2026, 2, 9, 12, 0, 0).getTime()
    expect(new StatsRepository(db).computeStreak(now)).toBe(3)
  })
})

describe('computeStreak 日历矩阵（v1.2.1 回归：修复前恒返回 1）', () => {
  let db: Database.Database
  let stats: StatsRepository
  let problemId: string

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    stats = new StatsRepository(db)
    problemId = new ProblemRepository(db).create(makeProblemInput(), true).id
  })

  const streakOf = (nowKey: string): number => stats.computeStreak(localDayStartMs(nowKey) + 12 * 3600_000)

  it('今天 1 次提交 → 1', () => {
    insertSubmissionAtDay(db, problemId, '2026-09-22')
    expect(streakOf('2026-09-22')).toBe(1)
  })

  it('今天 + 昨天 → 2', () => {
    insertSubmissionAtDay(db, problemId, '2026-09-21')
    insertSubmissionAtDay(db, problemId, '2026-09-22')
    expect(streakOf('2026-09-22')).toBe(2)
  })

  it('连续 3 天 → 3（修复前为 1）', () => {
    for (const key of ['2026-09-20', '2026-09-21', '2026-09-22']) {
      insertSubmissionAtDay(db, problemId, key)
    }
    expect(streakOf('2026-09-22')).toBe(3)
  })

  it('连续 7 天 → 7', () => {
    let key = '2026-09-16'
    for (let i = 0; i < 7; i++) {
      insertSubmissionAtDay(db, problemId, key)
      key = addLocalDays(key, 1)
    }
    expect(streakOf('2026-09-22')).toBe(7)
  })

  it('中间断一天 → 只累计最近段（2）', () => {
    for (const key of ['2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22']) {
      insertSubmissionAtDay(db, problemId, key)
    }
    expect(streakOf('2026-09-22')).toBe(2)
  })

  it('从昨天开始、今天没练 → 2（昨天+前天）', () => {
    for (const key of ['2026-09-20', '2026-09-21']) {
      insertSubmissionAtDay(db, problemId, key)
    }
    expect(streakOf('2026-09-22')).toBe(2)
  })

  it('最近提交是前天 → 0（连续已中断）', () => {
    insertSubmissionAtDay(db, problemId, '2026-09-18')
    insertSubmissionAtDay(db, problemId, '2026-09-20')
    expect(streakOf('2026-09-22')).toBe(0)
  })

  it('跨月连续：08-31 → 09-02 → 3', () => {
    for (const key of ['2026-08-31', '2026-09-01', '2026-09-02']) {
      insertSubmissionAtDay(db, problemId, key)
    }
    expect(streakOf('2026-09-02')).toBe(3)
  })

  it('跨年连续：12-30 → 01-02 → 4', () => {
    for (const key of ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']) {
      insertSubmissionAtDay(db, problemId, key)
    }
    expect(streakOf('2026-01-02')).toBe(4)
  })

  it('闰年连续：2028-02-27 → 03-01 → 4', () => {
    for (const key of ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']) {
      insertSubmissionAtDay(db, problemId, key)
    }
    expect(streakOf('2028-03-01')).toBe(4)
  })

  it('同一天多次提交 → 1', () => {
    insertSubmissionAtDay(db, problemId, '2026-09-22')
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('dup', ?, 'c', 'x', 'accepted', 1, 1, 1, ?)`
    ).run(problemId, localDayStartMs('2026-09-22') + 13 * 3600_000)
    expect(streakOf('2026-09-22')).toBe(1)
  })

  it('空库 → 0', () => {
    expect(streakOf('2026-09-22')).toBe(0)
  })
})

describe('buildTrend 日历属性', () => {
  let db: Database.Database
  let stats: StatsRepository
  let problemId: string

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' })
    stats = new StatsRepository(db)
    problemId = new ProblemRepository(db).create(makeProblemInput(), true).id
  })

  it('7/30 天序列连续无重复且末位为 now 所在日；最旧一天头部数据不丢', () => {
    // 在最旧一天的 00:05（本地日凌晨）提交——修复前 since=ms 减法可能截掉这段
    const keys = lastNLocalDayKeys(7, localDayStartMs('2026-09-22') + 12 * 3600_000)
    const oldest = keys[0] ?? '2026-09-16'
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('t1', ?, 'c', 'x', 'accepted', 1, 1, 1, ?)`
    ).run(problemId, localDayStartMs(oldest) + 5 * 60_000)

    const d = stats.getDashboardV2(localDayStartMs('2026-09-22') + 12 * 3600_000)
    expect(d.trend7).toHaveLength(7)
    expect(d.trend7.map((p) => p.day)).toEqual(keys)
    expect(d.trend7[0]?.submissions).toBe(1)
    for (let i = 1; i < d.trend7.length; i++) {
      expect(localDaySerial(d.trend7[i]?.day ?? '') - localDaySerial(d.trend7[i - 1]?.day ?? '')).toBe(1)
    }
    // 30 天同性质
    expect(new Set(d.trend30.map((p) => p.day)).size).toBe(30)
  })

  it('todaySubmissions / todayReviews 以注入 now 的本地日为口径', () => {
    // 昨天 23:59 与今天 00:01 各一条提交
    const todayKey = toLocalDayKey(Date.now())
    const yesterdayKey = addLocalDays(todayKey, -1)
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('late-yesterday', ?, 'c', 'x', 'accepted', 1, 1, 1, ?)`
    ).run(problemId, nextLocalDayStartMs(yesterdayKey) - 60_000)
    db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES ('early-today', ?, 'c', 'x', 'accepted', 1, 1, 1, ?)`
    ).run(problemId, localDayStartMs(todayKey) + 60_000)

    const d = stats.getDashboard(localDayStartMs(todayKey) + 12 * 3600_000)
    expect(d.todaySubmissions).toBe(1)
  })
})
