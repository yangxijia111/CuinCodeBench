/**
 * 主进程日志：console 输出 + 内存环形缓冲（便于 UI 后续展示/审计）。
 */

const MAX_ENTRIES = 500

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  time: number
  message: string
  detail?: string
}

const ring: LogEntry[] = []

function push(entry: LogEntry): void {
  ring.push(entry)
  if (ring.length > MAX_ENTRIES) ring.shift()
  const line = `[${new Date(entry.time).toISOString()}] [${entry.level}] ${entry.message}`
  if (entry.level === 'error') console.error(line, entry.detail ?? '')
  else if (entry.level === 'warn') console.warn(line, entry.detail ?? '')
  else console.log(line, entry.detail ?? '')
}

export const logger = {
  info(message: string, detail?: string): void {
    push({ level: 'info', time: Date.now(), message, detail })
  },
  warn(message: string, detail?: string): void {
    push({ level: 'warn', time: Date.now(), message, detail })
  },
  error(message: string, detail?: string): void {
    push({ level: 'error', time: Date.now(), message, detail })
  },
  /** 取最近日志（诊断用） */
  recent(): LogEntry[] {
    return [...ring]
  }
}
