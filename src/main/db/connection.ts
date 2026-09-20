import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { MIGRATIONS } from './migrations'

/**
 * SQLite 连接管理：打开库、WAL、外键、迁移。
 * 测试传 ':memory:' 或临时文件路径；生产由 ipc/getDataDir 提供目录。
 */

export interface OpenOptions {
  /** 数据库文件所在目录（文件名固定）；':memory:' 时忽略 */
  dataDir?: string
  /** 直接指定完整文件路径（优先于 dataDir） */
  file?: string
}

export function openDatabase(options: OpenOptions = {}): Database.Database {
  const file = options.file ?? join(options.dataDir ?? '.', 'cuincodebench.db')
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true })
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
  const applied = new Set(appliedRows.map((r) => r.version))
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version)

  const apply = db.transaction((m: (typeof sorted)[number]) => {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
      m.version,
      m.name,
      Date.now()
    )
  })

  for (const m of sorted) {
    if (!applied.has(m.version)) {
      apply(m)
    }
  }
}

/** 当前 schema 版本（诊断用） */
export function currentVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined
  return row?.v ?? 0
}
