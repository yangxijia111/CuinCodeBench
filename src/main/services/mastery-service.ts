import type { MasteryInfo, MasteryStatus, ReviewGrade } from '@shared/types'
import type { MasteryRepository } from '../db/repositories/mastery-repository'
import type { LearningRepository } from '../db/repositories/learning-repository'
import { effectiveMasteryStatus } from '../mastery/mastery-status'

/**
 * 知识点掌握度服务（docs/V1_2_MASTERY_SPEC.md，可解释规则、无 AI）。
 * 计算核心为纯函数 computeMastery（黑盒可对拍）；本服务负责取数与落库。
 */

// —— 公式常量（与 spec 一致，修改须同步文档与测试）——
const PERFORMANCE_WEIGHT = 0.45
const COVERAGE_WEIGHT = 0.3
const REVIEW_WEIGHT = 0.15
const STREAK_WEIGHT = 0.1
/** 表现/复习因子的指数衰减系数（最近一次权重 1.0） */
const DECAY = 0.85
/** 表现样本窗口（最近 N 次提交） */
const RECENT_WINDOW = 10
/** 每题计入样本上限（防单题刷分） */
const SAMPLES_PER_PROBLEM = 2
/** 信心折扣：知识点题目数达到该值后 coverage 不再打折 */
const CONFIDENCE_FULL_AT = 3
/** 无复习历史时的中性值 */
const NEUTRAL_REVIEW = 50
/** mastered 门槛 */
const MASTERED_SCORE = 80
const MASTERED_COVERAGE = 70
const FAMILIAR_SCORE = 60
/** weak 判定：最近 5 次提交失败数阈值 */
const WEAK_WINDOW = 5
const WEAK_FAILS = 3
// 注：mastered 45 天惰性衰减阈值移至 @shared/constants（MASTERY_STALE_DAYS），
// 读侧（effective on read）与写侧（computeMastery）共用同一规则源。

/** 计算输入（全部时间倒序） */
export interface MasteryInput {
  /** 表现样本候选（每题最多 SAMPLES_PER_PROBLEM 次的提交，时间倒序） */
  samples: { status: string }[]
  /** 最近原始提交（时间倒序；streak 与 weak 判定） */
  recent: { status: string }[]
  coverage: { total: number; covered: number }
  /** 知识点复习历史最近 5 次（时间倒序） */
  reviews: ReviewGrade[]
  lastActivityAt: number | null
  now: number
}

export interface MasteryOutput {
  score: number
  status: MasteryStatus
  factors: {
    performance: number
    coverage: number
    review: number
    streak: number
  }
}

/** 归一化指数加权平均（样本值 0/1，可扩展 0.5） */
function weightedScore(values: number[]): number {
  if (values.length === 0) return 0
  let num = 0
  let den = 0
  for (let i = 0; i < values.length; i++) {
    const w = Math.pow(DECAY, i)
    num += (values[i] ?? 0) * w
    den += w
  }
  return den === 0 ? 0 : (num / den) * 100
}

const REVIEW_VALUE: Record<ReviewGrade, number> = { good: 1, easy: 1, hard: 0.5, again: 0 }

/** 纯函数：掌握度计算（docs/V1_2_MASTERY_SPEC.md §3–§4） */
export function computeMastery(input: MasteryInput): MasteryOutput {
  // 状态 1：从未提交
  if (input.recent.length === 0 || input.coverage.total === 0) {
    return { score: 0, status: 'not_started', factors: { performance: 0, coverage: 0, review: 0, streak: 0 } }
  }

  // 表现：最近 RECENT_WINDOW 条样本（候选已按每题限量采样）
  const performance = weightedScore(
    input.samples.slice(0, RECENT_WINDOW).map((s) => (s.status === 'accepted' ? 1 : 0))
  )

  // 覆盖（含信心折扣）
  const confidence = Math.min(1, input.coverage.total / CONFIDENCE_FULL_AT)
  const coverage = (input.coverage.covered / input.coverage.total) * confidence * 100

  // 复习
  const review =
    input.reviews.length === 0
      ? NEUTRAL_REVIEW
      : weightedScore(input.reviews.slice(0, 5).map((g) => REVIEW_VALUE[g]))

  // streak：最近原始提交末尾（时间倒序开头）连续 accepted
  let streakCount = 0
  for (const s of input.recent) {
    if (s.status !== 'accepted') break
    streakCount++
  }
  const streak = (Math.min(streakCount, 5) / 5) * 100

  const raw =
    PERFORMANCE_WEIGHT * performance +
    COVERAGE_WEIGHT * coverage +
    REVIEW_WEIGHT * review +
    STREAK_WEIGHT * streak
  const score = Math.round(raw)

  // 状态判定（优先级从上到下）
  let status: MasteryStatus
  const recentFails = input.recent.slice(0, WEAK_WINDOW).filter((s) => s.status !== 'accepted').length
  const doubleAgain =
    input.reviews.length >= 2 && input.reviews[0] === 'again' && input.reviews[1] === 'again'
  if (recentFails >= WEAK_FAILS) {
    status = 'weak'
  } else if (score >= MASTERED_SCORE && coverage >= MASTERED_COVERAGE && !doubleAgain) {
    status = 'mastered'
  } else if (score >= FAMILIAR_SCORE) {
    status = 'familiar'
  } else {
    status = 'learning'
  }

  // 时间惰性衰减：长期无活动的 mastered 降为 familiar（规则单源：mastery/mastery-status.ts）
  const staleStatus = effectiveMasteryStatus(status, input.lastActivityAt, input.now)
  return { score, status: staleStatus, factors: { performance, coverage, review, streak } }
}

export class MasteryService {
  private readonly repo: MasteryRepository
  private readonly learning: LearningRepository

  constructor(deps: { mastery: MasteryRepository; learning: LearningRepository }) {
    this.repo = deps.mastery
    this.learning = deps.learning
  }

  /** 重算单个知识点（幂等覆盖写；无提交时移除缓存行） */
  recalc(knowledgePointId: string, now: number): void {
    const input: MasteryInput = {
      samples: this.repo.recentSamplesPerProblem(knowledgePointId, SAMPLES_PER_PROBLEM),
      recent: this.repo.recentSubmissions(knowledgePointId, Math.max(WEAK_WINDOW, RECENT_WINDOW)),
      coverage: this.repo.coverage(knowledgePointId),
      reviews: this.repo.recentReviewResults(knowledgePointId, 5),
      lastActivityAt: this.repo.lastActivityAt(knowledgePointId),
      now
    }
    if (input.recent.length === 0 && input.reviews.length === 0) {
      this.repo.remove(knowledgePointId)
      return
    }
    const result = computeMastery(input)
    this.repo.upsert({
      knowledgePointId,
      score: result.score,
      status: result.status,
      updatedAt: now
    })
  }

  /** 判题落库后：重算该题关联的全部知识点 */
  recalcForProblem(problemId: string, now: number): void {
    for (const kpId of this.learning.knowledgePointIdsForProblem(problemId)) {
      this.recalc(kpId, now)
    }
  }

  /** 全量重算（手动维护入口） */
  recalcAll(now: number): void {
    for (const kp of this.learning.listKnowledgePoints()) {
      this.recalc(kp.id, now)
    }
  }

  /**
   * 读路径列表（v1.2.1 P1-B：effective on read）。
   * 时间流逝本身使 mastered 的展示状态正确衰减（45 天无活动 → familiar），
   * 不写库、不做全库重算——每行 O(1) 状态修正，确定性可测（now 注入）。
   */
  list(now: number = Date.now()): MasteryInfo[] {
    const lastActivity = this.repo.lastActivityMap()
    return this.repo.listAll().map((m) => ({
      ...m,
      status: effectiveMasteryStatus(m.status, lastActivity.get(m.knowledgePointId) ?? null, now)
    }))
  }

  /** 读路径单点（effective on read，规则同 list） */
  getEffective(knowledgePointId: string, now: number = Date.now()): MasteryInfo | null {
    const m = this.repo.get(knowledgePointId)
    if (m === null) return null
    return {
      ...m,
      status: effectiveMasteryStatus(m.status, this.repo.lastActivityAt(knowledgePointId), now)
    }
  }
}
