import type Database from 'better-sqlite3'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

/**
 * 设置仓储：key-value（JSON 值），读取时合并默认值。
 */

const SETTINGS_KEY = 'app'

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
}
