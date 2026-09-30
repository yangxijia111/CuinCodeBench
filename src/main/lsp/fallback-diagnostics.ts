import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LanguageId, LspDiagnostic, Toolchain } from '@shared/types'
import { logger } from '../lib/logger'

/**
 * 编译器回退诊断（docs/V1_4_DESIGN.md §3）：语言服务器不可用时的底线体验。
 * - C/C++：gcc/clang -fsyntax-only（与判题同一 toolchain 选择，保证诊断与编译一致），解析 file:line:col: severity: message
 * - Python：ast.parse 助手脚本输出 JSON（比解析 traceback 稳定），语法级
 * - MSVC：无回退（返回空，LspService 据此显示 none）
 * 执行器经 runCommand 注入（默认 execute()，不占判题串行队列；测试可注入桩）。
 */

/** 命令执行抽象（默认走 execute()；注入点） */
export type FallbackRunCommand = (
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>

export interface ParsedGccDiagnostic {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

/** gcc/clang 诊断行（file:line:col: severity: message；"In file included from" 等无 severity 词的行不匹配） */
const GCC_LINE_RE = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/

export function parseGccDiagnosticLines(output: string): ParsedGccDiagnostic[] {
  const out: ParsedGccDiagnostic[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const m = GCC_LINE_RE.exec(rawLine)
    if (m === null) continue
    out.push({
      file: m[1] ?? '',
      line: Number(m[2] ?? 1),
      col: Number(m[3] ?? 1),
      severity: m[4] === 'warning' ? 'warning' : m[4] === 'note' ? 'info' : 'error',
      message: m[5] ?? ''
    })
  }
  return out
}

/** ParsedGccDiagnostic（1 基行列）→ 共享诊断（0 基） */
export function toLspDiagnostic(d: ParsedGccDiagnostic, source: string): LspDiagnostic {
  return {
    line: Math.max(0, d.line - 1),
    col: Math.max(0, d.col - 1),
    endLine: Math.max(0, d.line - 1),
    endCol: Math.max(0, d.col),
    severity: d.severity,
    message: d.message.slice(0, 10_000),
    source
  }
}

/** pycheck 助手脚本内容（输出 JSON，避免解析 traceback 文案） */
const PYCHECK_SCRIPT = [
  'import ast, json, sys',
  'path = sys.argv[1]',
  'with open(path, encoding="utf-8") as f:',
  '    src = f.read()',
  'try:',
  '    ast.parse(src, filename=path)',
  '    print(json.dumps({"ok": True, "diagnostics": []}))',
  'except SyntaxError as e:',
  '    line = (e.lineno or 1) - 1',
  '    col = (e.offset or 1) - 1',
  '    msg = type(e).__name__ + ": " + (e.msg or "invalid syntax")',
  '    print(json.dumps({"ok": False, "diagnostics": [{"line": line, "col": col, "message": msg}]}))'
].join('\n')

let pycheckPathCache: string | null = null

/** pycheck 助手脚本落盘（进程内缓存；无状态小脚本，tmp 目录） */
export function ensurePycheckHelper(): string {
  if (pycheckPathCache !== null && existsSync(pycheckPathCache)) return pycheckPathCache
  const file = join(tmpdir(), 'cuincodebench-pycheck.py')
  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (existing !== PYCHECK_SCRIPT) writeFileSync(file, PYCHECK_SCRIPT, 'utf8')
  } catch (err) {
    logger.warn('pycheck 助手脚本写入失败', err instanceof Error ? err.message : String(err))
  }
  pycheckPathCache = file
  return file
}

/** 工作区内该语言参与判题的源文件（相对路径，递归，字典序） */
export function listSourceFiles(dir: string, language: LanguageId): string[] {
  const exts =
    language === 'c' ? ['.c'] : language === 'cpp' ? ['.cpp', '.cc', '.cxx'] : ['.py']
  const results: string[] = []
  const walk = (rel: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(join(dir, rel))
    } catch {
      return
    }
    for (const name of entries.sort()) {
      // 判题产物/缓存目录不参与
      if (name === '__pycache__' || name === 'app.exe') continue
      const relPath = rel === '' ? name : `${rel}/${name}`
      let st
      try {
        st = statSync(join(dir, relPath))
      } catch {
        continue
      }
      if (st.isDirectory()) walk(relPath)
      else if (exts.some((e) => name.toLowerCase().endsWith(e))) results.push(relPath)
    }
  }
  walk('')
  return results.slice(0, 64)
}

/** 该语言是否有可用的回退供给（MSVC 无；语言无工具链也无） */
export function fallbackAvailable(language: LanguageId, toolchain: Toolchain | null): boolean {
  if (toolchain === null) return false
  if (language === 'python') return true
  return toolchain.kind.startsWith('gcc') || toolchain.kind.startsWith('clang')
}

/**
 * 收集回退诊断。返回 相对路径 → 诊断列表（仅含有诊断的文件）。
 * 单文件命令失败（编译器崩溃等）记日志跳过，不阻断其余文件。
 */
export async function collectFallbackDiagnostics(
  language: LanguageId,
  dir: string,
  toolchain: Toolchain | null,
  runCommand: FallbackRunCommand,
  pycheckScript?: string
): Promise<Map<string, LspDiagnostic[]>> {
  const result = new Map<string, LspDiagnostic[]>()
  if (!fallbackAvailable(language, toolchain) || toolchain === null) return result
  const files = listSourceFiles(dir, language)

  if (language === 'python') {
    const helper = pycheckScript ?? ensurePycheckHelper()
    for (const rel of files) {
      try {
        const { stdout } = await runCommand(
          toolchain.program,
          ['-X', 'utf8', helper, rel],
          dir,
          10_000
        )
        const parsed = JSON.parse(stdout.trim() || '{"diagnostics":[]}') as {
          diagnostics: { line: number; col: number; message: string }[]
        }
        const diags = parsed.diagnostics.map<LspDiagnostic>((d) => ({
          line: Math.max(0, d.line),
          col: Math.max(0, d.col),
          endLine: Math.max(0, d.line),
          endCol: Math.max(0, d.col) + 1,
          severity: 'error',
          message: String(d.message).slice(0, 10_000),
          source: 'python'
        }))
        if (diags.length > 0) result.set(rel, diags)
      } catch (err) {
        logger.warn('python 回退诊断失败', `${rel}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return result
  }

  // C/C++：与判题同 flags（-std/-Wall），保证诊断与编译一致
  const isCpp = language === 'cpp'
  const stdFlag = isCpp ? '-std=c++17' : '-std=c11'
  const source = toolchain.kind.startsWith('gcc') ? 'gcc' : 'clang'
  for (const rel of files) {
    try {
      const { stdout, stderr } = await runCommand(
        toolchain.program,
        ['-fsyntax-only', '-fdiagnostics-color=never', stdFlag, '-Wall', rel],
        dir,
        10_000
      )
      const parsed = parseGccDiagnosticLines(`${stderr}\n${stdout}`).filter((d) => d.file === rel)
      if (parsed.length > 0) result.set(rel, parsed.map((d) => toLspDiagnostic(d, source)))
    } catch (err) {
      logger.warn('gcc 回退诊断失败', `${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}
