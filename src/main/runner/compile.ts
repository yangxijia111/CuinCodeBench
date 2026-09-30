import { COMPILE_TIMEOUT_MS, COMPILE_OUTPUT_LIMIT_BYTES, SOURCE_FILENAMES } from '@shared/constants'
import type { LanguageId, Toolchain, WorkspaceFileInput } from '@shared/types'
import { safeJoinWithin, validateWorkspacePath } from '@shared/workspace-path'
import { runProcess } from './dispatch'
import { buildRunPlan } from './languages'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

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

export async function compileSource(
  toolchain: Toolchain,
  dir: string,
  extraSources: string[] = []
): Promise<CompileReport> {
  const plan = buildRunPlan(toolchain, dir, extraSources)
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

/**
 * v1.4 多文件写入临时目录：入口（SOURCE_FILENAMES）+ 附加文件（校验后写盘）。
 * 附加文件路径复用工作区同一套校验（禁遍历/保留名/入口名）；入口内容 = code。
 */
export async function writeWorkspaceFiles(
  dir: string,
  language: LanguageId,
  entryCode: string,
  files: WorkspaceFileInput[]
): Promise<void> {
  await writeFile(join(dir, SOURCE_FILENAMES[language]), entryCode, 'utf8')
  for (const f of files) {
    const v = validateWorkspacePath(f.path, language)
    if (!v.ok) throw new Error(`非法附加文件路径 ${f.path}：${v.reason}`)
    const rel = safeJoinWithin(f.path)
    if (rel === null) throw new Error(`路径逃逸被拒绝: ${f.path}`)
    const target = join(dir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, f.content, 'utf8')
  }
}
