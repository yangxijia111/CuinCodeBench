import type Database from 'better-sqlite3'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

/**
 * 设置仓储：key-value（JSON 值），读取时合并默认值。
 */

const SETTINGS_KEY = 'app'
const SEEDED_KEY = 'seeded'
/** v1.2：内置学习路线与旧题知识点映射的一次性标记 */
export const LEARNING_V2_MAPPED_KEY = 'learning_v2_mapped'
/** v1.2.1：稳定语义 ID 种子（v1.2 升级用户的 id 重写 + 内容 upsert 在此标记下执行） */
export const LEARNING_SEED_V2_KEY = 'learning_seed_v2'
/** v1.2：v1.1 老用户补灌新增种子题的一次性标记 */
export const SEEDED_V2_KEY = 'seeded_v2'

/**
 * 恢复备份时「备份缺失则保留本地现值」的标记键集合（backup-service 消费）。
 * 维护约定：新增一次性 marker 必须同步加入此处，否则旧备份恢复后会意外重触发。
 */
export const LOCAL_MARKER_KEYS = [SEEDED_KEY, LEARNING_V2_MAPPED_KEY, LEARNING_SEED_V2_KEY, SEEDED_V2_KEY] as const

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  get(): AppSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      | { value: string }
      | undefined
    if (!row) return { ...DEFAULT_SETTINGS }
    try {
      const parsed = JSON.parse(row.value) as Partial<AppSettings>
      return { ...DEFAULT_SETTINGS, ...parsed }
    } catch {
      // 设置损坏时回退默认值（不吞异常：此处为可预期的恢复路径）
      return { ...DEFAULT_SETTINGS }
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch }
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(SETTINGS_KEY, JSON.stringify(next))
    return next
  }

  /** 种子灌入标记（FR-P6）：只在首次启动灌入，用户清空题库后不复活 */
  hasSeeded(): boolean {
    return this.hasMarker(SEEDED_KEY)
  }

  markSeeded(): void {
    this.markMarker(SEEDED_KEY)
  }

  /** 通用一次性标记（v1.2 升级灌入用：learning_v2_mapped / seeded_v2） */
  hasMarker(key: string): boolean {
    const row = this.db.prepare('SELECT key FROM settings WHERE key = ?').get(key)
    return row !== undefined
  }

  markMarker(key: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(key, '1')
  }
}
