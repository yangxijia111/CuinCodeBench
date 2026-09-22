import { MASTERY_STALE_DAYS } from '@shared/constants'
import type { MasteryStatus } from '@shared/types'

/**
 * 掌握度「有效状态」纯函数（v1.2.1 P1-B）。
 *
 * mastery 表是持久化缓存，computeMastery(now) 的 45 天惰性衰减只在重算时发生——
 * 用户长期不打开应用时，时间变化本身不会改变物化状态。本模块把同一条衰减规则
 * 暴露为读路径可复用的纯函数（与 computeMastery 完全一致，保证确定性）：
 * 读侧按「effective on read」计算展示状态，不写库；写侧（recalc）依旧物化落库。
 */

export const MASTERY_STALE_MS = MASTERY_STALE_DAYS * 86_400_000

/**
 * mastered 且超过 STALE 天无活动 → familiar（score 不变，仅状态降级）。
 * lastActivityAt 为 null（无活动记录）时不降级——与 computeMastery 的 stale 判定一致。
 */
export function effectiveMasteryStatus(
  status: MasteryStatus,
  lastActivityAt: number | null,
  now: number
): MasteryStatus {
  if (status === 'mastered' && lastActivityAt !== null && now - lastActivityAt > MASTERY_STALE_MS) {
    return 'familiar'
  }
  return status
}
