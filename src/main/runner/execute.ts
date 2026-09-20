import { spawn } from 'child_process'
import { OUTPUT_LIMIT_BYTES } from '@shared/constants'
import type { ExecutionResult } from '@shared/types'
import type { ExecutionStatus } from './types'
import { killTree } from './kill-tree'

/**
 * 进程执行器：stdin 写入、stdout/stderr 捕获与大小限制、超时杀进程树（FR-R4–R7）。
 * 编译与运行共用；编译时 stdin 传空串、不关心 output_limit 语义。
 */

/** 等待被杀进程退出的兜底时限：超时后不再等待（防止挂死判题队列） */
const KILL_WAIT_MS = 3_000

export interface ExecuteOptions {
  program: string
  args: string[]
  cwd: string
  stdin: string
  timeoutMs: number
  /** 附加环境变量（叠加在 process.env 之上） */
  env?: Record<string, string>
  /** 是否检查输出超限（编译阶段传 false） */
  enforceOutputLimit?: boolean
}

class StreamCollector {
  private chunks: Buffer[] = []
  private total = 0
  truncated = false

  push(chunk: Buffer): void {
    this.total += chunk.length
    if (this.total > OUTPUT_LIMIT_BYTES) {
      this.truncated = true
      // 只保留上限内的内容（丢弃超出部分）
      const remaining = OUTPUT_LIMIT_BYTES - (this.total - chunk.length)
      if (remaining > 0) this.chunks.push(chunk.subarray(0, remaining))
    } else {
      this.chunks.push(chunk)
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

export function execute(opts: ExecuteOptions): Promise<ExecutionResult> {
  const enforceLimit = opts.enforceOutputLimit ?? true
  const RETRY_DELAYS_MS = [400, 1_200]
  const attempt = (attemptIndex: number): Promise<ExecutionResult> =>
    doExecute(opts, enforceLimit).then((result) => {
      // 杀软（Defender 等）会短暂锁定新写入的可执行文件导致 EPERM/EACCES/EBUSY：
      // 按退避间隔重试；持续被拦（杀软隔离）则返回 spawn_error 由上层展示（WIN-7）
      const transient =
        result.status === 'spawn_error' && /EPERM|EACCES|EBUSY/i.test(result.stderr)
      if (transient && attemptIndex < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attemptIndex] ?? 400
        return new Promise<ExecutionResult>((resolve) =>
          setTimeout(() => resolve(attempt(attemptIndex + 1)), delay)
        )
      }
      return result
    })
  return attempt(0)
}

function doExecute(opts: ExecuteOptions, enforceLimit: boolean): Promise<ExecutionResult> {
  return new Promise<ExecutionResult>((resolve) => {
    let settled = false
    const startedAt = Date.now()

    let child
    try {
      child = spawn(opts.program, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX 下配合 -pid 组杀；Windows 无副作用
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      resolve(spawnErrorResult(err))
      return
    }

    const stdout = new StreamCollector()
    const stderr = new StreamCollector()
    let timedOut = false
    let limited = false
    let timeoutTimer: NodeJS.Timeout | null = null

    function settle(status: ExecutionStatus, exitCode: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return
      settled = true
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      resolve({
        status,
        exitCode,
        signal: signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
        timedOut
      })
    }

    // 超时：杀整棵进程树，等待 exit 事件落地
    timeoutTimer = setTimeout(() => {
      timedOut = true
      killTree(child.pid ?? 0)
    }, Math.max(1, opts.timeoutMs))

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      if (enforceLimit && stdout.truncated && !limited) {
        limited = true
        killTree(child.pid ?? 0)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      if (enforceLimit && stderr.truncated && !limited) {
        limited = true
        killTree(child.pid ?? 0)
      }
    })

    // stdin 写入：程序不读 stdin 导致 EPIPE 属预期，忽略该错误
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.stdin, 'utf8')

    child.on('error', (err) => {
      // spawn 失败（ENOENT、权限等）
      settle('spawn_error', null, null)
      void err
    })

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle('timeout', code, signal)
        return
      }
      if (limited && enforceLimit) {
        settle('output_limit', code, signal)
        return
      }
      settle('ok', code, signal)
    })

    // 兜底：killTree 后进程仍未退出（如 IgnoreProcessGroup 的极端情况）时强制 resolve
    child.on('spawn', () => {
      setTimeout(() => {
        if (!settled && (timedOut || limited)) {
          try {
            child.kill('SIGKILL')
          } catch {
            // 已退出
          }
          settle(timedOut ? 'timeout' : 'output_limit', null, null)
        }
      }, Math.max(1, opts.timeoutMs) + KILL_WAIT_MS)
    })
  })
}

function spawnErrorResult(err: unknown): ExecutionResult {
  return {
    status: 'spawn_error',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
    timedOut: false
  }
}
