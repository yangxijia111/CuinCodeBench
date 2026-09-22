/**
 * 本地日历日工具：全部「天」语义的统一入口（v1.2.1 P0-A/S1）。
 *
 * 核心原则：
 * 1. 日历日运算一律走本地日历组件（Date 构造 + setDate/getDate），
 *    禁止用毫秒算术（now - n * 86_400_000）冒充日历日——
 *    DST 切换周本地日长为 23/25 小时，ms 减法会跳日或重复日。
 * 2. 「天」的规范表示是本地日 key：`YYYY-MM-DD`（无时区、无时刻）。
 * 3. 全部为纯函数；当前时刻一律由调用方注入（可测试）。
 */

/** 本地日 key（YYYY-MM-DD，月/日两位补零） */
export type LocalDayKey = string

/** 取时刻所属的本地日 key */
export function toLocalDayKey(ms: number): LocalDayKey {
  const d = new Date(ms)
  return formatLocalDayKey(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/** 由本地日历组件构造 key（各分量均为本地自然数：年四位、月 1-12、日 1-31） */
export function formatLocalDayKey(year: number, month: number, day: number): LocalDayKey {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 本地日历日序号：两个本地日 key 的序号差为 1 ⇔ 日历相邻。
 * 以 UTC 分量编码（与时区/DST 无关），跨月/跨年/闰年由 Date.UTC 正确处理。
 */
export function localDaySerial(key: LocalDayKey): number {
  const [y, m, d] = parseLocalDayKey(key)
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

/** key → [year, month(1-12), day(1-31)]；非法格式抛错（fail fast，不静默给错值） */
export function parseLocalDayKey(key: LocalDayKey): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (m === null) throw new Error(`非法本地日 key: ${key}`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`非法本地日 key: ${key}`)
  return [year, month, day]
}

/** 本地日 key 加 N 天（N 可为负），走本地日历（DST/闰年/跨月正确） */
export function addLocalDays(key: LocalDayKey, delta: number): LocalDayKey {
  const [y, m, d] = parseLocalDayKey(key)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  return formatLocalDayKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

/**
 * 最近 N 个连续本地日 key（最旧在前，最后一个是 now 所在日）。
 * 逐日回退用本地日历，保证序列连续且无重复（与 DST 无关）。
 */
export function lastNLocalDayKeys(n: number, now: number): LocalDayKey[] {
  if (n < 1) return []
  const today = toLocalDayKey(now)
  const keys: LocalDayKey[] = [today]
  for (let i = 1; i < n; i++) keys.unshift(addLocalDays(today, -i))
  return keys
}

/** 本地日的 00:00 时刻（UTC ms）。DST 极端下若 00:00 不存在由 JS 规范化到次日 0 点后，仍保证不早于该日任何本地时刻 */
export function localDayStartMs(key: LocalDayKey): number {
  const [y, m, d] = parseLocalDayKey(key)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

/** 本地日结束后第一个时刻（次日 00:00 的 UTC ms） */
export function nextLocalDayStartMs(key: LocalDayKey): number {
  return localDayStartMs(addLocalDays(key, 1))
}
