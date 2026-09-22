import type Database from 'better-sqlite3'
import type { PracticeSession, ReviewGrade, ReviewItem } from '@shared/types'
import { ReviewRepository } from '../db/repositories/review-repository'
import { PracticeRepository } from '../db/repositories/practice-repository'
import { MasteryRepository } from '../db/repositories/mastery-repository'
import { LearningRepository } from '../db/repositories/learning-repository'
import { nextSchedule } from '../review/review-scheduler'
import { MISTAKE_THRESHOLD } from '@shared/constants'

/**
 * 间隔复习服务（docs/V1_2_REVIEW_SPEC.md）：
 * 复习项生命周期（错题/知识点）、Review Session 组题与结果落库、掌握度联动。
 * 全部时间经 now 参数注入（UTC ms），测试可控。
 */

/** 组题时每个知识点最多展开的题目数 */
const PROBLEMS_PER_KP = 2
export const DEFAULT_SESSION_SIZE = 10
export const SESSION_SIZE_OPTIONS = [5, 10, 20] as const

/**
 * 会话内多题聚合等级的优先序（v1.2.1 P0-C，docs/V1_2_1_DEEP_AUDIT.md）：
 * again > hard > good > easy——同一复习项在一个会话内被多题命中时取最差成绩
 * （保守取向：任一失败都应立即拉低调度，与错题语义一致）。
 */
export const GRADE_SEVERITY: Record<ReviewGrade, number> = { again: 0, hard: 1, good: 2, easy: 3 }

/** 取更严重（更差）的等级 */
export function worseGrade(a: ReviewGrade, b: ReviewGrade): ReviewGrade {
  return GRADE_SEVERITY[a] <= GRADE_SEVERITY[b] ? a : b
}

interface PickRow {
  id: string
  prio: number
  acc_rate: number
}

export class ReviewService {
  private readonly db: Database.Database
  readonly reviews: ReviewRepository
  readonly sessions: PracticeRepository
  private readonly mastery: MasteryRepository
  private readonly learning: LearningRepository
  private readonly problemExists: Database.Statement
  private readonly kpExists: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.reviews = new ReviewRepository(db)
    this.sessions = new PracticeRepository(db)
    this.mastery = new MasteryRepository(db)
    this.learning = new LearningRepository(db)
    this.problemExists = db.prepare('SELECT 1 AS ok FROM problems WHERE id = ?')
    this.kpExists = db.prepare('SELECT 1 AS ok FROM knowledge_points WHERE id = ?')
  }

  /** 知识点首次活动时建复习项（次日到期）；已存在则不动（调度只由评分推进） */
  private ensureKpReviewItem(kpId: string, now: number): void {
    if (this.reviews.getByTarget('knowledge_point', kpId) === null) {
      this.reviews.create('knowledge_point', kpId, now + 86_400_000, now)
    }
  }

  /**
   * 判题落库 hook（judge-service.persist 调用）：
   * 1) 题目进入错题本（失败≥2 未掌握）→ 建 problem 复习项，立即到期；
   * 2) 题目关联的知识点 → 确保复习项存在（次日到期）；
   * 3) active 复习会话包含该题 → 报告结果。
   */
  onSubmission(problemId: string, accepted: boolean, submissionId: string | null, now: number): void {
    const mistake = this.db
      .prepare('SELECT failed_count, mastered FROM mistake_book WHERE problem_id = ?')
      .get(problemId) as { failed_count: number; mastered: number } | undefined
    if (
      mistake !== undefined &&
      mistake.failed_count >= MISTAKE_THRESHOLD &&
      mistake.mastered === 0 &&
      this.reviews.getByTarget('problem', problemId) === null
    ) {
      this.reviews.create('problem', problemId, now, now)
    }

    for (const kpId of this.learning.knowledgePointIdsForProblem(problemId)) {
      this.ensureKpReviewItem(kpId, now)
    }

    for (const session of this.sessions.findActiveSessionsForProblem(problemId, ['review', 'random', 'knowledge_point'])) {
      const updated = this.sessions.reportResult(session.id, problemId, accepted, submissionId, now)
      if (updated === null) continue
      // 复习会话全部作答完毕：由 finishSession 统一收尾（评分 exactly-once，
      // spec §3：AC→good 失败→again；reportResult 不再对 review 会话自动置 finished）
      if (session.kind === 'review') {
        const pendingLeft = updated.items.filter((i) => i.status === 'pending').length
        if (pendingLeft === 0) this.finishSession(updated.id, {}, now)
      }
    }
  }

  /** 最近完成的复习会话（10 分钟内收尾），供完成页展示 */
  lastFinishedSession(now: number): PracticeSession | null {
    const s = this.sessions.getLatestFinished('review', now - 10 * 60_000)
    return s
  }

  /** 用户标记错题已掌握 → 删除该题复习项（重新失败时重建） */
  onMistakeMastered(problemId: string): void {
    this.reviews.deleteByProblem(problemId)
  }

  /** 删除题目前清理其复习项（P0-D 服务层防线；problems.delete IPC 调用） */
  deleteByProblem(problemId: string): void {
    this.reviews.deleteByProblem(problemId)
  }

  /** 今日复习概览：到期项 + 按知识点聚合（过滤目标已不存在的项，防多态孤儿幽灵项） */
  todayOverview(now: number): {
    dueCount: number
    items: ReviewItem[]
    byKnowledgePoint: { name: string; count: number }[]
  } {
    const due = this.filterDanglingTargets(this.reviews.listDue(now))
    const kpCounts = new Map<string, number>()
    for (const item of due) {
      if (item.targetType !== 'knowledge_point') continue
      kpCounts.set(item.targetId, (kpCounts.get(item.targetId) ?? 0) + 1)
    }
    const byKnowledgePoint = [...kpCounts.entries()]
      .map(([id, count]) => {
        const kp = this.learning.getKnowledgePoint(id)
        return { name: kp?.name ?? id, count }
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
    return { dueCount: due.length, items: due, byKnowledgePoint }
  }

  /** 多态引用防线（P0-D 服务层）：目标（题目/知识点）已删除的复习项不参与组题与展示 */
  private filterDanglingTargets(items: ReviewItem[]): ReviewItem[] {
    if (items.length === 0) return items
    return items.filter((item) => {
      const row =
        item.targetType === 'problem'
          ? this.problemExists.get(item.targetId)
          : this.kpExists.get(item.targetId)
      return row !== undefined
    })
  }

  /**
   * 组题（spec §6.1）：错题优先 → 失败多 → 低掌握 → 最早到期；知识点展开 1~2 题、会话去重。
   * 复用已有 active 会话（避免重复组题）。
   */
  startSession(size: number, now: number): { session: PracticeSession; created: boolean } {
    const existing = this.sessions.getLatestActive('review')
    if (existing !== null) return { session: existing, created: false }

    const due = this.filterDanglingTargets(this.reviews.listDue(now))
    const scoreOf = (item: ReviewItem): number =>
      item.targetType === 'knowledge_point' ? (this.mastery.get(item.targetId)?.score ?? -1) : -1

    const problemItems = due
      .filter((i) => i.targetType === 'problem')
      .sort(
        (a, b) =>
          b.failureCount - a.failureCount ||
          scoreOf(b) - scoreOf(a) ||
          a.nextReviewAt - b.nextReviewAt
      )
    const kpItems = due
      .filter((i) => i.targetType === 'knowledge_point')
      .sort((a, b) => scoreOf(a) - scoreOf(b) || a.nextReviewAt - b.nextReviewAt)

    const selected: string[] = []
    const used = new Set<string>()

    for (const item of problemItems) {
      if (selected.length >= size) break
      if (!used.has(item.targetId)) {
        selected.push(item.targetId)
        used.add(item.targetId)
      }
    }

    for (const item of kpItems) {
      if (selected.length >= size) break
      const picks = this.pickProblemsForKp(item.targetId, used, Math.min(PROBLEMS_PER_KP, size - selected.length))
      for (const pid of picks) {
        if (selected.length >= size) break
        selected.push(pid)
        used.add(pid)
      }
    }

    const session = this.sessions.createSession('review', null, { size }, selected, now)
    return { session, created: true }
  }

  /** 知识点内选题：错题 → 最近失败 → 已做（AC 率升序）→ 未做 */
  private pickProblemsForKp(kpId: string, used: Set<string>, maxCount: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT p.id,
           CASE WHEN mb.problem_id IS NOT NULL AND mb.mastered = 0 THEN 0
                WHEN last_s.status IS NOT NULL AND last_s.status != 'accepted' THEN 1
                WHEN att.attempts IS NOT NULL THEN 2
                ELSE 3 END AS prio,
           COALESCE(acc.c * 1.0 / MAX(att.attempts, 1), 0) AS acc_rate
         FROM problem_knowledge_points pkp
         JOIN problems p ON p.id = pkp.problem_id
         LEFT JOIN mistake_book mb ON mb.problem_id = p.id
         LEFT JOIN (
           SELECT s.problem_id, s.status FROM submissions s
           JOIN (SELECT problem_id, MAX(created_at) AS mx FROM submissions GROUP BY problem_id) m
             ON m.problem_id = s.problem_id AND m.mx = s.created_at
         ) last_s ON last_s.problem_id = p.id
         LEFT JOIN (SELECT problem_id, COUNT(*) AS attempts FROM submissions GROUP BY problem_id) att
           ON att.problem_id = p.id
         LEFT JOIN (SELECT problem_id, COUNT(*) AS c FROM submissions WHERE status = 'accepted' GROUP BY problem_id) acc
           ON acc.problem_id = p.id
         WHERE pkp.knowledge_point_id = ?
         ORDER BY prio, acc_rate, p.created_at`
      )
      .all(kpId) as PickRow[]
    const picks: string[] = []
    for (const r of rows) {
      if (picks.length >= maxCount) break
      if (used.has(r.id)) continue
      picks.push(r.id)
    }
    return picks
  }

  /**
   * 完成会话（v1.2.1 P0-C 重写：exactly-once）。
   *
   * 不变量：一个会话中同一 ReviewItem 最多产生一次有效评分。
   * - 逐题结果映射默认等级（AC→good，失败→again），用户可改；
   * - 会话内同一知识点的多题成绩按 again > hard > good > easy 聚合为单一等级
   *   （GRADE_SEVERITY，见文件头注释）；
   * - 评分推进与 review_session_results 登记同事务：INSERT OR IGNORE 命中即跳过，
   *   重复 finish / 并发请求 / 事务失败重试都不会双计；
   * - 会话已评分后再次调用为幂等读（返回已记录结果，不推进调度）。
   */
  finishSession(
    sessionId: string,
    grades: Record<string, ReviewGrade>,
    now: number
  ): { sessionId: string; graded: number; nextReviewAt: Record<string, number> } {
    const session = this.sessions.getSession(sessionId)
    if (session === null) throw new Error('会话不存在')

    // 幂等读：已有评分记录的会话（自动收尾后 UI 再点完成 / 重复 IPC）直接返回现状
    const recorded = this.reviews.listSessionResults(sessionId)
    if (recorded.length > 0) {
      const nextReviewAt: Record<string, number> = {}
      for (const r of recorded) nextReviewAt[r.targetId] = r.nextReviewAt
      return { sessionId, graded: recorded.length, nextReviewAt }
    }
    // 已结束但无评分记录 = 被取消的会话（review.cancelSession）：取消是终态，不再评分
    if (session.status === 'finished') {
      return { sessionId, graded: 0, nextReviewAt: {} }
    }

    // 聚合：题目项各自一个等级；知识点项聚合该会话内全部相关题目的最差等级
    const problemGrades = new Map<string, ReviewGrade>()
    const kpGrades = new Map<string, ReviewGrade>()
    for (const item of session.items) {
      if (item.status === 'pending' || item.status === 'skipped') continue
      const grade: ReviewGrade = grades[item.problemId] ?? (item.status === 'accepted' ? 'good' : 'again')
      problemGrades.set(item.problemId, grade)
      for (const kpId of this.learning.knowledgePointIdsForProblem(item.problemId)) {
        const existing = kpGrades.get(kpId)
        kpGrades.set(kpId, existing === undefined ? grade : worseGrade(existing, grade))
      }
    }

    const nextReviewAt: Record<string, number> = {}
    let graded = 0
    const tx = this.db.transaction(() => {
      for (const [problemId, grade] of problemGrades) {
        const problemItem = this.reviews.getByTarget('problem', problemId)
        if (problemItem === null) continue
        const submissionId =
          session.items.find((i) => i.problemId === problemId)?.firstAcceptedSubmissionId ?? null
        if (!this.reviews.recordSessionResult(sessionId, problemItem.id, grade, submissionId, now)) continue
        const next = nextSchedule(problemItem, grade, now)
        this.reviews.applyGrade(problemItem.id, grade, next, now, submissionId)
        nextReviewAt[problemId] = next.nextReviewAt
        graded++
      }
      for (const [kpId, grade] of kpGrades) {
        const kpItem = this.reviews.getByTarget('knowledge_point', kpId)
        if (kpItem === null) continue
        if (!this.reviews.recordSessionResult(sessionId, kpItem.id, grade, null, now)) continue
        const next = nextSchedule(kpItem, grade, now)
        this.reviews.applyGrade(kpItem.id, grade, next, now, null)
        nextReviewAt[kpId] = next.nextReviewAt
        graded++
      }
      this.sessions.finish(sessionId, now)
    })
    tx()

    // 掌握度重算（幂等；仅本次实际推进了评分才有必要）
    if (graded > 0) {
      const kpIds = new Set<string>()
      for (const item of session.items) {
        for (const kpId of this.learning.knowledgePointIdsForProblem(item.problemId)) kpIds.add(kpId)
      }
      for (const kpId of kpIds) {
        // mastery-service 由 ServiceContext 提供的重算入口（见 services/index.ts 桥接）
        this.masteryRecalc?.(kpId, now)
      }
    }
    return { sessionId, graded, nextReviewAt }
  }

  /** 掌握度重算回调（由 ServiceContext 注入，避免循环依赖） */
  masteryRecalc: ((kpId: string, now: number) => void) | null = null
}
