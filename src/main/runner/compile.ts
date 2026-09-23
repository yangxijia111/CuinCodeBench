import { COMPILE_TIMEOUT_MS, COMPILE_OUTPUT_LIMIT_BYTES } from '@shared/constants'
import type { Toolchain } from '@shared/types'
import { runProcess } from './dispatch'
import { buildRunPlan } from './languages'
import { writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * 编译执行（FR-R5/R8）：复用执行器（无 stdin）。
 * gcc/clang 有警告但 exit 0 视为成功；MSVC 同理。
 * H6：编译输出同样受 COMPILE_OUTPUT_LIMIT_BYTES 上限约束（防失控编译器），
 * 超限时视为编译失败并在 stderr 保留截断内容。
 */

export interface CompileReport {
  ok: boolean
  stderr: string
  stdout: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

export async function compileSource(toolchain: Toolchain, dir: string): Promise<CompileReport> {
  const plan = buildRunPlan(toolchain, dir)
  if (plan.compile === null) {
    // 解释型语言无编译步
    return { ok: true, stderr: '', stdout: '', exitCode: 0, timedOut: false, durationMs: 0 }
  }
  const result = await runProcess({
    program: plan.compile.program,
    args: plan.compile.args,
    cwd: dir,
    stdin: '',
    timeoutMs: COMPILE_TIMEOUT_MS,
    env: plan.compile.env,
    enforceOutputLimit: true,
    outputLimitBytes: COMPILE_OUTPUT_LIMIT_BYTES
  })
  const stderr =
    result.status === 'output_limit'
      ? result.stderr + '\n[编译输出超过上限，已截断终止]'
      : result.stderr
  return {
    ok: result.exitCode === 0 && !result.timedOut && result.status !== 'output_limit',
    stderr,
    stdout: result.stdout,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  }
}

/** 将源码以 UTF-8（无 BOM）写入临时目录 */
export async function writeSourceFile(toolchain: Toolchain, dir: string, code: string): Promise<string> {
  const plan = buildRunPlan(toolchain, dir)
  const file = join(dir, plan.sourceFile)
  await writeFile(file, code, 'utf8')
  return file
}
