import { spawn, type ChildProcess } from 'child_process'
import {
  LAUNCHER_MEMORY_LIMIT_BYTES,
  LAUNCHER_PROCESS_LIMIT,
  LAUNCHER_WATCHDOG_GRACE_MS,
  OUTPUT_LIMIT_BYTES
} from '@shared/constants'
import type { ExecutionResult } from '@shared/types'
import { z } from 'zod'
import {
  FRAME_ERROR,
  FRAME_INFO,
  FRAME_REQ,
  FRAME_RESULT,
  FRAME_STDIN,
  FRAME_STDIN_EOF,
  FRAME_STDOUT,
  FRAME_STDERR,
  MAX_DATA_PAYLOAD,
  MAX_JSON_PAYLOAD,
  PROTOCOL_VERSION,
  FrameDecoder,
  ProtocolError,
  encodeFrame
} from './native-protocol'
import { StreamCollector, type ExecuteOptions } from './execute'

/**
 * ccb-launcher 客户端（docs/V1_3_JOB_OBJECT_DESIGN.md §3/§6）：
 * - REQ → STDIN* → EOF；STDOUT/STDERR/INFO/RESULT/ERROR 帧解析；
 * - timeout 权威在 launcher；Node 看门狗（timeout+宽限）兜底杀 launcher 并验证树清理；
 * - Node 层输出限制保留（双层限制任一触发即整树终止）；
 * - launcher 崩溃 → KILL_ON_JOB_CLOSE 兜底 + childPid 复查（不静默吞掉原因）。
 *
 * 约定：spawn 失败（launcher 不存在/被拦截）抛错由 dispatch 降级 fallback；
 * 子进程已创建后的所有结局都折叠为 ExecutionResult（不允许二次执行用户程序）。
 */

const resultFrameSchema = z.object({
  exitCode: z.number(),
  timedOut: z.boolean(),
  outputLimitExceeded: z.boolean(),
  /** 触发输出限制的流（1=stdout 2=stderr；未触发为 null——截断标志证据） */
  outputLimitStream: z.number().int().min(1).max(2).nullable().optional(),
  durationMs: z.number().min(0),
  peakProcessMemoryBytes: z.number().min(0),
  peakProcessCount: z.number().min(0),
  terminationReason: z.string().max(40).nullable()
})

const errorFrameSchema = z.object({
  code: z.string().max(60),
  win32LastError: z.number().min(0),
  message: z.string().max(1000)
})

export interface NativeLimits {
  memoryLimitBytes?: number
  processLimit?: number
  outputLimitBytes?: number
}

/** 活跃 launcher 登记表：应用退出时整树终止（KILL_ON_JOB_CLOSE 兜底 + 主动杀） */
const activeLaunchers = new Set<ChildProcess>()

export function killAllActiveLaunchers(): void {
  for (const launcher of activeLaunchers) {
    try {
      launcher.kill()
    } catch {
      // 已退出
    }
  }
  activeLaunchers.clear()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 进程存在性（tasklist 过滤 PID；查询失败按存在处理——保守走强杀路径） */
async function pidExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        // 进程存在 ⇔ CSV 行含精确字段 "pid"（tasklist 的「无任务」提示文案随系统
        // locale 变化（中文 GBK 无 "INFO:" 字样），不可解析文本，用引号字段判定）
        if (err) {
          resolve(true)
          return
        }
        resolve(stdout.includes(`"${pid}"`))
      }
    )
  })
}

/**
 * 验证目标进程树已清理（docs §6「不能只有 kill 而不验证」）：
 * 预算内轮询；仍存在 → taskkill /T /F 强杀 → 复查；最终仍存在返回 false（调用方记录告警）。
 */
export async function ensureTreeGone(pid: number, budgetMs = 5_000): Promise<boolean> {
  // 合法 Windows pid 上限 2^32-1；超界（含 2^31 以上 tasklist 拒绝查询）视为不存在
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7FFF_FFFF) return true
  const deadline = Date.now() + budgetMs
  let killed = false
  for (;;) {
    if (!(await pidExists(pid))) return true
    if (Date.now() > deadline) return false
    if (!killed) {
      killed = true
      const { execFile } = await import('child_process')
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true }, () =>
          resolve()
        )
      })
      continue
    }
    await sleep(200)
  }
}

/** 32 位无符号 → Node child_process 风格有符号（0xC0000005 → -1073741819，对拍一致） */
function toSignedExitCode(exitCode: number): number | null {
  if (exitCode === -1) return null
  return exitCode | 0
}

interface NativeOutcome {
  result: ExecutionResult
  /** 请求级失败（create_process_failed 且可重试的杀软拦截码） */
  retriableSpawnError: boolean
}

/**
 * 执行一次（单次尝试）。仅 spawn launcher 自身失败抛错；
 * 用户程序相关的全部结局（含 launcher 崩溃/协议损坏）折叠为结果值。
 */
async function executeNativeOnce(opts: ExecuteOptions, limits: NativeLimits, launcherPath: string): Promise<NativeOutcome> {
  const enforceLimit = opts.enforceOutputLimit ?? true
  const limitBytes = limits.outputLimitBytes ?? opts.outputLimitBytes ?? OUTPUT_LIMIT_BYTES
  const memoryLimitBytes = limits.memoryLimitBytes ?? LAUNCHER_MEMORY_LIMIT_BYTES
  const processLimit = limits.processLimit ?? LAUNCHER_PROCESS_LIMIT

  // 完整合并环境块（launcher 不做合并，见协议 §3.2）
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v

  const stdinBuf = Buffer.from(opts.stdin, 'utf8')
  const req = {
    version: PROTOCOL_VERSION,
    program: opts.program,
    args: opts.args,
    cwd: opts.cwd,
    env,
    stdinBytes: stdinBuf.length,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes,
    processLimit,
    outputLimitBytes: enforceLimit ? limitBytes : 0
  }
  const reqPayload = Buffer.from(JSON.stringify(req), 'utf8')
  if (reqPayload.length > MAX_JSON_PAYLOAD) {
    // 环境块异常巨大：按 spawn 失败处理（不启动 launcher，允许上层降级）
    throw new Error(`REQ 帧超限：${reqPayload.length}`)
  }

  return new Promise<NativeOutcome>((resolve, reject) => {
    let launcher: ChildProcess
    try {
      launcher = spawn(launcherPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    launcher.on('error', (err) => {
      // launcher 无法启动（ENOENT 等）：未创建任何子进程，可安全降级
      reject(err)
    })

    activeLaunchers.add(launcher)
    const cleanup = (): void => {
      activeLaunchers.delete(launcher)
      if (watchdog !== null) clearTimeout(watchdog)
    }

    let settled = false
    let childPid: number | null = null
    const stdout = new StreamCollector(limitBytes)
    const stderr = new StreamCollector(limitBytes)
    let nodeLimitTripped = false
    const startedAt = Date.now()

    const finish = (outcome: NativeOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    /** 收尾兜底：杀 launcher（→ KILL_ON_JOB_CLOSE）并验证树清理；返回追加的诊断 stderr */
    const killAndVerify = async (): Promise<string> => {
      try {
        launcher.kill()
      } catch {
        // 已退出
      }
      let notes = ''
      if (childPid !== null) {
        const gone = await ensureTreeGone(childPid)
        if (!gone) notes = `\n[launcher] 警告：进程树清理未确认（pid=${childPid}）`
      }
      return notes
    }

    const settleFromState = async (reason: 'timeout' | 'output_limit'): Promise<void> => {
      const notes = await killAndVerify()
      finish({
        result: {
          status: reason,
          exitCode: null,
          signal: null,
          stdout: stdout.text(),
          stderr: stderr.text() + notes,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Date.now() - startedAt,
          timedOut: reason === 'timeout',
          terminationReason: reason
        },
        retriableSpawnError: false
      })
    }

    // 看门狗：launcher 未按时回 RESULT（卡死）→ 杀 launcher → 验证清理
    const watchdog: NodeJS.Timeout | null = setTimeout(() => {
      void settleFromState('timeout')
    }, opts.timeoutMs + LAUNCHER_WATCHDOG_GRACE_MS)

    // —— 发送方向 ——
    try {
      launcher.stdin?.write(encodeFrame(FRAME_REQ, reqPayload))
      for (let offset = 0; offset < stdinBuf.length; offset += MAX_DATA_PAYLOAD) {
        launcher.stdin?.write(encodeFrame(FRAME_STDIN, stdinBuf.subarray(offset, offset + MAX_DATA_PAYLOAD)))
      }
      launcher.stdin?.end(encodeFrame(FRAME_STDIN_EOF, Buffer.alloc(0)))
    } catch {
      // stdin 断开（launcher 立即退出）：由 close 分支按 launcher_died 处理
    }
    launcher.stdin?.on('error', () => {})

    // —— 接收方向 ——
    const decoder = new FrameDecoder()
    let pendingResult: z.infer<typeof resultFrameSchema> | null = null
    let errorFrame: z.infer<typeof errorFrameSchema> | null = null
    let protocolBroken = false

    launcher.stdout?.on('data', (chunk: Buffer) => {
      let frames
      try {
        frames = decoder.feed(chunk)
      } catch (err) {
        if (err instanceof ProtocolError) {
          protocolBroken = true
          void settleFromState('timeout').then(() => {})
          return
        }
        throw err
      }
      for (const frame of frames) {
        switch (frame.type) {
          case FRAME_STDOUT: {
            stdout.push(frame.payload)
            if (enforceLimit && stdout.truncated && !nodeLimitTripped) {
              nodeLimitTripped = true
              void settleFromState('output_limit')
            }
            break
          }
          case FRAME_STDERR: {
            stderr.push(frame.payload)
            if (enforceLimit && stderr.truncated && !nodeLimitTripped) {
              nodeLimitTripped = true
              void settleFromState('output_limit')
            }
            break
          }
          case FRAME_INFO: {
            try {
              const parsed = JSON.parse(frame.payload.toString('utf8')) as { childPid?: number }
              if (typeof parsed.childPid === 'number') childPid = parsed.childPid
            } catch {
              // INFO 损坏：不影响主流程（childPid 仅用于兜底清理）
            }
            break
          }
          case FRAME_RESULT: {
            try {
              pendingResult = resultFrameSchema.parse(JSON.parse(frame.payload.toString('utf8')))
            } catch {
              protocolBroken = true
            }
            break
          }
          case FRAME_ERROR: {
            try {
              errorFrame = errorFrameSchema.parse(JSON.parse(frame.payload.toString('utf8')))
            } catch {
              protocolBroken = true
            }
            break
          }
          default:
            // 未知帧型：协议损坏（双端版本不一致保护）
            protocolBroken = true
        }
      }
    })
    launcher.stderr?.on('data', (chunk: Buffer) => {
      // launcher 自身的崩溃诊断（非帧协议流）：并入 stderr 供排查
      stderr.push(chunk)
    })

    launcher.on('close', () => {
      if (settled) return
      const dur = Date.now() - startedAt
      if (pendingResult !== null) {
        const r = pendingResult
        const status = r.timedOut ? 'timeout' : r.outputLimitExceeded ? 'output_limit' : 'ok'
        // launcher 层触发限制时内容在阈值处被切断——与旧路径 truncated 语义对齐
        const stream = r.outputLimitStream ?? 0
        finish({
          result: {
            status,
            exitCode: toSignedExitCode(r.exitCode),
            signal: null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutTruncated: stdout.truncated || (r.outputLimitExceeded && stream === 1),
            stderrTruncated: stderr.truncated || (r.outputLimitExceeded && stream === 2),
            durationMs: Math.max(dur, 0),
            timedOut: r.timedOut,
            terminationReason: r.terminationReason
          },
          retriableSpawnError: false
        })
        return
      }
      if (errorFrame !== null) {
        const e = errorFrame
        const retriable =
          e.code === 'create_process_failed' && (e.win32LastError === 5 || e.win32LastError === 32)
        // 目标程序未创建/创建失败：与旧路径 spawn_error 语义一致（AV 拦截可重试）
        finish({
          result: {
            status: 'spawn_error',
            exitCode: null,
            signal: null,
            stdout: stdout.text(),
            stderr: `启动失败：${e.code}（Win32 ${e.win32LastError}）${e.message}`,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs: dur,
            timedOut: false,
            terminationReason: 'protocol_error'
          },
          retriableSpawnError: retriable
        })
        return
      }
      // launcher 死亡且无 RESULT/ERROR（崩溃/被外部杀）：KILL_ON_JOB_CLOSE 应已清树，
      // Node 仍按契约验证清理，不静默。
      void (async () => {
        let notes = ''
        if (childPid !== null) {
          const gone = await ensureTreeGone(childPid)
          if (!gone) notes = `\n[launcher] 警告：进程树清理未确认（pid=${childPid}）`
        }
        finish({
          result: {
            status: 'spawn_error',
            exitCode: null,
            signal: null,
            stdout: stdout.text(),
            stderr:
              stderr.text() +
              notes +
              (protocolBroken ? '\n[launcher] 协议异常中断' : '\n[launcher] launcher 异常退出（无 RESULT）'),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs: dur,
            timedOut: false,
            terminationReason: 'launcher_died'
          },
          retriableSpawnError: false
        })
      })()
    })
  })
}

/** 原生执行入口：与 execute() 同语义（含杀软拦截重试），额外返回资源围栏证据 */
export async function executeNative(opts: ExecuteOptions, limits: NativeLimits, launcherPath: string): Promise<ExecutionResult> {
  const RETRY_DELAYS_MS = [400, 1_200]
  let attempt = 0
  for (;;) {
    const outcome = await executeNativeOnce(opts, limits, launcherPath)
    if (outcome.retriableSpawnError && attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 400
      await sleep(delay)
      attempt++
      continue
    }
    return outcome.result
  }
}
