import type { ReviewGrade } from '@shared/types'

/**
 * 间隔复习调度算法（docs/V1_2_REVIEW_SPEC.md §4）：
 * 确定性阶梯表，无浮点累计、无随机； Again 当日重现（10 分钟）。
 */

/** good/easy 的间隔阶梯（索引 = min(评分后 success_streak, 5)，天） */
export const GOOD_LADDER = [1, 3, 7, 14, 30, 60] as const
export const EASY_LADDER = [2, 5, 10, 21, 45, 60] as const

/** 间隔上限（天） */
export const MAX_INTERVAL_DAYS = 60

/** again 的当日重现间隔（毫秒） */
export const AGAIN_REPEAT_MS = 10 * 60_000

const DAY_MS = 86_400_000

export interface ScheduleState {
  intervalDays: number
  successStreak: number
}

export interface ScheduledState extends ScheduleState {
  nextReviewAt: number
}

/**
 * 评分后的下一个调度状态（纯函数）。
 * - again：interval 归零、streak 清零、10 分钟后重现；
 * - hard：max(1, round(interval×1.2))，streak 不变；
 * - good/easy：查阶梯表（按评分后 streak 封顶 5）。
 */
export function nextSchedule(current: ScheduleState, grade: ReviewGrade, now: number): ScheduledState {
  switch (grade) {
    case 'again':
      return { intervalDays: 0, successStreak: 0, nextReviewAt: now + AGAIN_REPEAT_MS }
    case 'hard': {
      const intervalDays = Math.max(1, Math.round(current.intervalDays * 1.2))
      return { intervalDays, successStreak: current.successStreak, nextReviewAt: now + intervalDays * DAY_MS }
    }
    case 'good':
    case 'easy': {
      // 阶梯索引用评分前 streak：again 重置后首次 good 从 1 天重新起步（spec §4）
      const idx = Math.min(current.successStreak, 5)
      const ladder = grade === 'good' ? GOOD_LADDER : EASY_LADDER
      const intervalDays = Math.min(ladder[idx] ?? MAX_INTERVAL_DAYS, MAX_INTERVAL_DAYS)
      return { intervalDays, successStreak: Math.min(current.successStreak + 1, 5), nextReviewAt: now + intervalDays * DAY_MS }
    }
  }
}

/**
 * 时钟回拨防护（v1.3 P8，docs/V1_3_CLOCK_ROLLBACK_SPEC.md §2）：
 * 调度推进用 effectiveNow = max(now, 上次活动时间)。学习时间线单调——
 * 系统时间回拨不得使 nextReviewAt 早于 lastReviewedAt（不变量 I1），
 * 也不得制造负 interval（I2）或重置计数（I3，计数与时间无关）。
 * 墙钟展示（streak/日历/今日到期）不受此函数影响，仍用真实 now。
 */
export function effectiveNowForScheduling(now: number, lastActivityAt: number | null | undefined): number {
  return lastActivityAt !== null && lastActivityAt !== undefined && lastActivityAt > now
    ? lastActivityAt
    : now
}
