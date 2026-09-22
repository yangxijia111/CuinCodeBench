import type Database from 'better-sqlite3'
import type {
  DashboardStats,
  DashboardV2Stats,
  JudgeStatus,
  LanguageId,
  MasteryStatus,
  Submission,
  TrendPoint
} from '@shared/types'
import { LANGUAGE_IDS, MISTAKE_THRESHOLD } from '@shared/constants'
import {
  lastNLocalDayKeys,
  localDaySerial,
  nextLocalDayStartMs,
  toLocalDayKey,
  localDayStartMs
} from '@shared/local-calendar-day'
import { kpLastActivityMap } from './mastery-repository'
import { effectiveMasteryStatus } from '../../mastery/mastery-status'

/**
 * 统计查询仓储：Dashboard 指标（FR-D1–D3）与 Dashboard 2.0 学习指标，只读聚合。
 * 时间口径：本地时区自然日。v1.2.1 起统一走 LocalCalendarDay（本地日历算术，
 * 禁止 ms 减法冒充日历日——DST 切换周本地日长 23/25 小时）；「今天」一律以注入
 * now 计算（SQL 只做区间过滤，不再引用 DATE('now')），测试可控。
 */

interface CountRow {
  c: number
}

interface SubmissionRow {
  id: string
  problem_id: string
  language: string
  code: string
  status: string
  passed_count: number
  total_count: number
  duration_ms: number
  created_at: number
  problem_title: string
}

export class StatsRepository {
  constructor(private readonly db: Database.Database) {}

  getDashboard(now: number = Date.now()): DashboardStats {
    const totalProblemsAttempted = (
      this.db.prepare('SELECT COUNT(DISTINCT problem_id) AS c FROM submissions').get() as CountRow
    ).c
    const totalProblemsInBank = (
      this.db.prepare('SELECT COUNT(*) AS c FROM problems').get() as CountRow
    ).c
    const acceptedProblems = (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT problem_id) AS c FROM submissions WHERE status = 'accepted'"
        )
        .get() as CountRow
    ).c
    const totalSubmissions = (
      this.db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as CountRow
    ).c
    const acceptedSubmissions = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'accepted'")
        .get() as CountRow
    ).c
    const todaySubmissions = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS c FROM submissions WHERE created_at >= ? AND created_at < ?'
        )
        .get(localDayStartMs(toLocalDayKey(now)), nextLocalDayStartMs(toLocalDayKey(now))) as CountRow
    ).c

    const languageCounts: Record<LanguageId, number> = { c: 0, cpp: 0, python: 0 }
    const langRows = this.db
      .prepare('SELECT language, COUNT(*) AS c FROM submissions GROUP BY language')
      .all() as { language: string; c: number }[]
    for (const r of langRows) {
      if ((LANGUAGE_IDS as readonly string[]).includes(r.language)) {
        languageCounts[r.language as LanguageId] = r.c
      }
    }

    const errorTypeCounts = (
      this.db
        .prepare(
          `SELECT error_type AS type, COUNT(*) AS c FROM error_records
           GROUP BY error_type ORDER BY c DESC LIMIT 5`
        )
        .all() as { type: string; c: number }[]
    ).map((r) => ({ type: r.type as JudgeStatus, count: r.c }))

    const recentRows = this.db
      .prepare(
        `SELECT s.*, p.title AS problem_title FROM submissions s
         JOIN problems p ON p.id = s.problem_id
         ORDER BY s.created_at DESC LIMIT 10`
      )
      .all() as SubmissionRow[]
    const recentSubmissions: (Submission & { problemTitle: string })[] = recentRows.map((r) => ({
      id: r.id,
      problemId: r.problem_id,
      language: r.language as LanguageId,
      code: r.code,
      status: r.status as JudgeStatus,
      passedCount: r.passed_count,
      totalCount: r.total_count,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
      problemTitle: r.problem_title
    }))

    return {
      totalProblemsAttempted,
      totalProblemsInBank,
      acceptedProblems,
      accuracy: totalSubmissions === 0 ? 0 : acceptedSubmissions / totalSubmissions,
      totalSubmissions,
      todaySubmissions,
      streakDays: this.computeStreak(now),
      languageCounts,
      errorTypeCounts,
      recentSubmissions
    }
  }

  /**
   * 连续练习天数（FR-D1）：从今天（或昨天）向前连续有提交的本地日历天数。
   * now 注入（UTC ms）；相邻判断用本地日序号差 = 1（Date.UTC 编码，跨月/跨年/闰年正确，与 DST 无关）。
   */
  computeStreak(now: number = Date.now()): number {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT DATE(created_at / 1000, 'unixepoch', 'localtime') AS day
         FROM submissions ORDER BY day DESC`
      )
      .all() as { day: string }[]
    if (rows.length === 0) return 0

    const serials = rows.map((r) => localDaySerial(r.day))
    // DESC 序：serials[0] 最新。最新提交须是今天或昨天，否则连续已中断记 0
    const todaySerial = localDaySerial(toLocalDayKey(now))
    if (serials[0] !== todaySerial && serials[0] !== todaySerial - 1) return 0

    let streak = 1
    for (let i = 1; i < serials.length; i++) {
      // serials[i-1] 更新、serials[i] 更旧：两者日序号差恰为 1（相邻本地日）才延续
      if ((serials[i - 1] ?? 0) - (serials[i] ?? 0) === 1) streak++
      else break
    }
    return streak
  }

  // —— Dashboard 2.0（v1.2，docs/V1_2_ROADMAP.md P6）——

  /** Dashboard 2.0：v1.1 指标 + 复习/错题/掌握度/趋势。now 注入（UTC ms）。 */
  getDashboardV2(now: number): DashboardV2Stats {
    const base = this.getDashboard(now)

    // 「今天」以注入 now 的本地日边界计算（与趋势/连续天数同一口径，测试可控）
    const todayKey = toLocalDayKey(now)
    const todayReviews = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM review_history WHERE reviewed_at >= ? AND reviewed_at < ?')
        .get(localDayStartMs(todayKey), nextLocalDayStartMs(todayKey)) as CountRow
    ).c

    const dueReviewCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM review_items WHERE next_review_at <= ?').get(now) as CountRow
    ).c

    const mistakeDueCount = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM mistake_book WHERE failed_count >= ? AND mastered = 0')
        .get(MISTAKE_THRESHOLD) as CountRow
    ).c

    const lastActivity = kpLastActivityMap(this.db)

    const masteryList = (
      this.db
        .prepare(
          `SELECT k.id AS knowledge_point_id, k.name, COALESCE(m.score, 0) AS score,
                  COALESCE(m.status, 'not_started') AS status
           FROM knowledge_points k
           LEFT JOIN mastery m ON m.knowledge_point_id = k.id
           ORDER BY k.stage_id, k.sort_order`
        )
        .all() as { knowledge_point_id: string; name: string; score: number; status: string }[]
    ).map((r) => ({
      knowledgePointId: r.knowledge_point_id,
      name: r.name,
      score: r.score,
      // P1-B：读侧 effective 状态——时间流逝使长期无活动的 mastered 正确显示为 familiar
      status: effectiveMasteryStatus(
        r.status as MasteryStatus,
        lastActivity.get(r.knowledge_point_id) ?? null,
        now
      )
    }))

    return {
      ...base,
      todayReviews,
      dueReviewCount,
      mistakeDueCount,
      masteryList,
      trend7: this.buildTrend(7, now),
      trend30: this.buildTrend(30, now)
    }
  }

  /** 最近 N 天趋势（本地日历日连续序列，最旧在前；日序列由 LocalCalendarDay 生成，DST 安全） */
  private buildTrend(days: number, now: number): TrendPoint[] {
    const keys = lastNLocalDayKeys(days, now)
    // since 取最旧一天的本地 00:00（日历边界，非 ms 减法——DST 周本地日长可为 23/25h）
    const since = localDayStartMs(keys[0] ?? toLocalDayKey(now))

    const subRows = this.db
      .prepare(
        `SELECT DATE(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS c,
                SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS acc
         FROM submissions WHERE created_at >= ? GROUP BY day`
      )
      .all(since) as { day: string; c: number; acc: number | null }[]
    const reviewRows = this.db
      .prepare(
        `SELECT DATE(reviewed_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS c
         FROM review_history WHERE reviewed_at >= ? GROUP BY day`
      )
      .all(since) as { day: string; c: number }[]

    const subMap = new Map(subRows.map((r) => [r.day, r]))
    const reviewMap = new Map(reviewRows.map((r) => [r.day, r.c]))

    return keys.map((key) => {
      const sub = subMap.get(key)
      return {
        day: key,
        submissions: sub?.c ?? 0,
        accepted: sub?.acc ?? 0,
        reviews: reviewMap.get(key) ?? 0
      }
    })
  }
}
