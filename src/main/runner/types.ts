import type { Toolchain } from '@shared/types'

/**
 * Runner 类型：与 DB/UI 无关的执行层边界类型（ADR D1）。
 */

/** 扩展 Toolchain：编译/运行命令构造所需的派生信息 */
export type ToolKind = Toolchain['kind']

/** 编译步骤描述 */
export interface CompileStep {
  program: string
  args: string[]
  /** 附加环境变量（MSVC：vcvars 解析结果） */
  env?: Record<string, string>
}

/** 运行步骤描述 */
export interface RunStep {
  program: string
  args?: string[]
  /** 附加环境变量（Python：UTF-8 相关；MSVC：vcvars 解析结果） */
  env?: Record<string, string>
}

/** 一次"编译+运行"或"纯解释运行"的完整计划 */
export interface RunPlan {
  language: 'c' | 'cpp' | 'python'
  compile: CompileStep | null
  run: RunStep
  /** 源文件名（写入临时目录） */
  sourceFile: string
  /** 可执行文件名（compiled 语言，位于临时目录） */
  exeFile: string | null
}

export type ExecutionStatus = 'ok' | 'timeout' | 'output_limit' | 'spawn_error'
