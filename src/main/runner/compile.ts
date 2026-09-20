import { COMPILE_TIMEOUT_MS } from '@shared/constants'
import type { Toolchain } from '@shared/types'
import { execute } from './execute'
import { buildRunPlan, SOURCE_FILENAMES } from './languages'
import { writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * 编译执行（FR-R5/R8）：复用执行器（无 stdin、不判输出超限）。
 * gcc/clang 有警告但 exit 0 视为成功；MSVC 同理。
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
  const result = await execute({
    program: plan.compile.program,
    args: plan.compile.args,
    cwd: dir,
    stdin: '',
    timeoutMs: COMPILE_TIMEOUT_MS,
    env: plan.compile.env,
    enforceOutputLimit: false
  })
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    stderr: result.stderr,
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

/** 源文件名（供调用方在计划外直接写文件时使用） */
export function sourceFileName(toolchain: Toolchain): string {
  const language = toolchain.languageIds[0] ?? 'c'
  return SOURCE_FILENAMES[language]
}
