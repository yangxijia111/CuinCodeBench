import { join } from 'path'
import type { LanguageId, Toolchain } from '@shared/types'
import type { RunPlan } from './types'

/**
 * 语言配置与命令构造（纯函数，FR-R3：全部数组参数，无 shell 拼接）。
 */

export const SOURCE_FILENAMES: Record<LanguageId, string> = {
  c: 'main.c',
  cpp: 'main.cpp',
  python: 'main.py'
}

/** 每种工具链服务的语言 */
export const TOOLCHAIN_LANGUAGES: Record<Toolchain['kind'], LanguageId[]> = {
  'gcc-c': ['c'],
  'clang-c': ['c'],
  'msvc-c': ['c'],
  'gcc-cpp': ['cpp'],
  'clang-cpp': ['cpp'],
  'msvc-cpp': ['cpp'],
  python: ['python']
}

/** 同一语言多工具链时的优先级（小者先） */
export const TOOLCHAIN_PRIORITY: Record<Toolchain['kind'], number> = {
  'gcc-c': 0,
  'gcc-cpp': 0,
  'clang-c': 1,
  'clang-cpp': 1,
  'msvc-c': 2,
  'msvc-cpp': 2,
  python: 0
}

/** gcc/clang 系编译参数（初学者友好：保留警告，不把警告当错误） */
const GCC_C_ARGS = ['-O2', '-std=c11', '-Wall']
const GCC_CPP_ARGS = ['-O2', '-std=c++17', '-Wall']

/** MSVC 编译参数 */
const MSVC_C_ARGS = ['/O2', '/std:c11', '/W3']
const MSVC_CPP_ARGS = ['/O2', '/std:c++17', '/EHsc', '/W3']

/**
 * Python 运行参数：-I 隔离模式（忽略用户 site 与 PYTHONPATH 等环境干扰）。
 * UTF-8 必须用 -X utf8 而非 PYTHONUTF8 环境变量——-I 会忽略全部 PYTHON* 环境变量。
 */
const PYTHON_ARGS = ['-I', '-X', 'utf8']

/**
 * 构造一次完整执行计划。
 * @param toolchain 选定的工具链
 * @param dir 临时工作目录（源文件与可执行文件所在，cwd 亦为此）
 */
export function buildRunPlan(toolchain: Toolchain, dir: string): RunPlan {
  const language = toolchain.languageIds[0]
  if (language === undefined) throw new Error(`工具链 ${toolchain.id} 未声明语言`)

  if (toolchain.kind === 'python') {
    return {
      language: 'python',
      compile: null,
      run: {
        program: toolchain.program,
        args: [...PYTHON_ARGS, SOURCE_FILENAMES.python],
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      },
      sourceFile: SOURCE_FILENAMES.python,
      exeFile: null
    }
  }
  const sourceFile = language === 'c' ? SOURCE_FILENAMES.c : SOURCE_FILENAMES.cpp
  const exeFile = 'app.exe'
  const joined = joinArg(dir, exeFile)

  switch (toolchain.kind) {
    case 'gcc-c':
      return {
        language,
        compile: { program: toolchain.program, args: [sourceFile, ...GCC_C_ARGS, '-o', exeFile] },
        run: { program: joined },
        sourceFile,
        exeFile
      }
    case 'clang-c':
      return {
        language,
        compile: { program: toolchain.program, args: [sourceFile, ...GCC_C_ARGS, '-o', exeFile] },
        run: { program: joined },
        sourceFile,
        exeFile
      }
    case 'gcc-cpp':
      return {
        language,
        compile: { program: toolchain.program, args: [sourceFile, ...GCC_CPP_ARGS, '-o', exeFile] },
        run: { program: joined },
        sourceFile,
        exeFile
      }
    case 'clang-cpp':
      return {
        language,
        compile: { program: toolchain.program, args: [sourceFile, ...GCC_CPP_ARGS, '-o', exeFile] },
        run: { program: joined },
        sourceFile,
        exeFile
      }
    case 'msvc-c':
      return {
        language,
        compile: {
          program: toolchain.program,
          args: [...MSVC_C_ARGS, sourceFile, `/Fe:${exeFile}`],
          env: toolchain.env
        },
        run: { program: joined, env: toolchain.env },
        sourceFile,
        exeFile
      }
    case 'msvc-cpp':
      return {
        language,
        compile: {
          program: toolchain.program,
          args: [...MSVC_CPP_ARGS, sourceFile, `/Fe:${exeFile}`],
          env: toolchain.env
        },
        run: { program: joined, env: toolchain.env },
        sourceFile,
        exeFile
      }
  }
}

/**
 * Windows 上运行同目录 exe 用绝对路径最稳（避免 cwd 解析差异）。
 * 路径来自系统临时目录，含空格也安全——spawn 数组参数不经 shell。
 */
function joinArg(dir: string, file: string): string {
  return join(dir, file)
}

/** 从候选中按语言与优先级选择工具链 */
export function selectToolchain(candidates: Toolchain[], language: LanguageId): Toolchain | null {
  const fitting = candidates.filter((t) => t.languageIds.includes(language))
  if (fitting.length === 0) return null
  return fitting.sort((a, b) => TOOLCHAIN_PRIORITY[a.kind] - TOOLCHAIN_PRIORITY[b.kind])[0] ?? null
}
