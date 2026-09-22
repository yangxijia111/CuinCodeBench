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

/**
 * 统计查询仓储：Dashboard 指标（FR-D1–D3）与 Dashboard 2.0 学习指标，只读聚合。
 * 时间口径：本地时区自然日（DATE(created_at/1000, 'localtime')）。
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

  getDashboard(): DashboardStats {
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
          "SELECT COUNT(*) AS c FROM submissions WHERE DATE(created_at / 1000, 'unixepoch', 'localtime') = DATE('now', 'localtime')"
        )
        .get() as CountRow
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
      streakDays: this.computeStreak(),
      languageCounts,
      errorTypeCounts,
      recentSubmissions
    }
  }

  /** 连续练习天数：从今天（或昨天）向前连续有提交的天数（FR-D1） */  computeStreak(): number {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT DATE(created_at / 1000, 'unixepoch', 'localtime') AS day
         FROM submissions ORDER BY day DESC`
      )
      .all() as { day: string }[]
    if (rows.length === 0) return 0

    // 以本地时区的“天序号”比较（用日历差而非 86400s，规避夏令时）
    const toDayNumber = (day: string): number => {
      const [y, m, d] = day.split('-').map((x) => Number.parseInt(x, 10))
      return (y ?? 0) * 10000 + (m ?? 0) * 100 + (d ?? 0)
    }
    const now = new Date()
    const fmt = (dt: Date): string =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    const todayNum = toDayNumber(fmt(now))
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const yesterdayNum = toDayNumber(fmt(yesterday))

    const days = rows.map((r) => toDayNumber(r.day))
    if (days[0] !== todayNum && days[0] !== yesterdayNum) return 0

    let streak = 1
    for (let i = 1; i < days.length; i++) {
      const prev = days[i - 1] ?? 0
      const curr = days[i] ?? 0
      // 相邻记录日历相邻（差 1 天）才延续；用日历回退一天验证
      const expectedPrev = this.prevDayNumber(curr)
      if (prev === expectedPrev) streak++
      else break
    }
    return streak
  }

  /** 给定 YYYYMMDD 序号，返回前一天的序号 */
  private prevDayNumber(dayNum: number): number {
    const y = Math.floor(dayNum / 10000)
    const m = Math.floor((dayNum % 10000) / 100)
    const d = dayNum % 100
    const dt = new Date(y, m - 1, d)
    dt.setDate(dt.getDate() - 1)
    return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate()
  }

  // —— Dashboard 2.0（v1.2，docs/V1_2_ROADMAP.md P6）——

  /** Dashboard 2.0：v1.1 指标 + 复习/错题/掌握度/趋势。now 注入（UTC ms）。 */
  getDashboardV2(now: number): DashboardV2Stats {
    const base = this.getDashboard()

    const todayReviews = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM review_history
           WHERE DATE(reviewed_at / 1000, 'unixepoch', 'localtime') = DATE('now', 'localtime')`
        )
        .get() as CountRow
    ).c

    const dueReviewCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM review_items WHERE next_review_at <= ?').get(now) as CountRow
    ).c

    const mistakeDueCount = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM mistake_book WHERE failed_count >= ? AND mastered = 0')
        .get(MISTAKE_THRESHOLD) as CountRow
    ).c

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
      status: r.status as MasteryStatus
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

  /** 最近 N 天趋势（本地日历日连续序列，最旧在前；SQL 聚合无全表 JS 扫描） */
  private buildTrend(days: number, now: number): TrendPoint[] {
    const since = now - days * 86_400_000

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

    const points: TrendPoint[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86_400_000)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const sub = subMap.get(key)
      points.push({
        day: key,
        submissions: sub?.c ?? 0,
        accepted: sub?.acc ?? 0,
        reviews: reviewMap.get(key) ?? 0
      })
    }
    return points
  }
}
