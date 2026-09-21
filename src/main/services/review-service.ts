import type Database from 'better-sqlite3'
import type { ReviewGrade, ReviewItem } from '@shared/types'
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

  constructor(db: Database.Database) {
    this.db = db
    this.reviews = new ReviewRepository(db)
    this.sessions = new PracticeRepository(db)
    this.mastery = new MasteryRepository(db)
    this.learning = new LearningRepository(db)
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
      void this.sessions.reportResult(session.id, problemId, accepted, submissionId, now)
    }
  }

  /** 用户标记错题已掌握 → 删除该题复习项（重新失败时重建） */
  onMistakeMastered(problemId: string): void {
    this.reviews.deleteByProblem(problemId)
  }

  /** 今日复习概览：到期项 + 按知识点聚合 */
  todayOverview(now: number): {
    dueCount: number
    items: ReviewItem[]
    byKnowledgePoint: { name: string; count: number }[]
  } {
    const due = this.reviews.listDue(now)
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

  /**
   * 组题（spec §6.1）：错题优先 → 失败多 → 低掌握 → 最早到期；知识点展开 1~2 题、会话去重。
   * 复用已有 active 会话（避免重复组题）。
   */
  startSession(size: number, now: number): { session: ReturnType<PracticeRepository['getSession']>; created: boolean } {
    const existing = this.sessions.getLatestActive('review')
    if (existing !== null) return { session: existing, created: false }

    const due = this.reviews.listDue(now)
    const masteryScore = new Map<string, number | null>()
    const scoreOf = (item: ReviewItem): number =>
      item.targetType === 'knowledge_point' ? (this.mastery.get(item.targetId)?.score ?? -1) : -1
    void masteryScore

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
   * 完成会话：按每题结果映射默认等级（AC→good，失败→again），用户可改。
   * 逐项推进调度（题目项 + 该题关联知识点项均推进）→ 重算掌握度。
   */
  finishSession(
    sessionId: string,
    grades: Record<string, ReviewGrade>,
    now: number
  ): { sessionId: string; graded: number; nextReviewAt: Record<string, number> } {
    const session = this.sessions.getSession(sessionId)
    if (session === null) throw new Error('会话不存在')
    const nextReviewAt: Record<string, number> = {}
    let graded = 0
    const tx = this.db.transaction(() => {
      for (const item of session.items) {
        if (item.status === 'pending' || item.status === 'skipped') continue
        const grade: ReviewGrade = grades[item.problemId] ?? (item.status === 'accepted' ? 'good' : 'again')
        const problemItem = this.reviews.getByTarget('problem', item.problemId)
        if (problemItem !== null) {
          const next = nextSchedule(problemItem, grade, now)
          this.reviews.applyGrade(problemItem.id, grade, next, now, item.firstAcceptedSubmissionId)
          nextReviewAt[item.problemId] = next.nextReviewAt
        }
        for (const kpId of this.learning.knowledgePointIdsForProblem(item.problemId)) {
          const kpItem = this.reviews.getByTarget('knowledge_point', kpId)
          if (kpItem === null) continue
          const next = nextSchedule(kpItem, grade, now)
          this.reviews.applyGrade(kpItem.id, grade, next, now, item.firstAcceptedSubmissionId)
          nextReviewAt[kpId] = next.nextReviewAt
        }
        graded++
      }
      this.sessions.finish(sessionId, now)
    })
    tx()
    // 掌握度重算（受影响知识点）
    const kpIds = new Set<string>()
    for (const item of session.items) {
      for (const kpId of this.learning.knowledgePointIdsForProblem(item.problemId)) kpIds.add(kpId)
    }
    for (const kpId of kpIds) {
      // mastery-service 由 ServiceContext 提供的重算入口（见 services/index.ts 桥接）
      this.masteryRecalc?.(kpId, now)
    }
    return { sessionId, graded, nextReviewAt }
  }

  /** 掌握度重算回调（由 ServiceContext 注入，避免循环依赖） */
  masteryRecalc: ((kpId: string, now: number) => void) | null = null
}
