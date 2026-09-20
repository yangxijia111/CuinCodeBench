import type Database from 'better-sqlite3'
import type { DashboardStats, JudgeStatus, LanguageId, Submission } from '@shared/types'
import { LANGUAGE_IDS } from '@shared/constants'

/**
 * 统计查询仓储：Dashboard 全部指标（FR-D1–D3），只读聚合。
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

  /** 连续练习天数：从今天（或昨天）向前连续有提交的天数（FR-D1） */
  computeStreak(): number {
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
}
