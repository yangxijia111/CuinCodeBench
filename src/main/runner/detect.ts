import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { DETECT_TIMEOUT_MS } from '@shared/constants'
import type { LanguageId, Toolchain } from '@shared/types'
import { logger } from '../lib/logger'
import { locateCl, locateMsvcInstall } from './msvc-locate'

/**
 * 工具链探测（FR-R1/R2）：
 * 1. where.exe 找 PATH 命中；
 * 2. 逐一 --version 校验（排除 Microsoft Store 空壳别名）；
 * 3. MSVC 经 vswhere 定位 + vcvars64 环境解析（WIN-3）。
 * 所有子进程均为数组参数 spawn；探测失败静默跳过（该工具链不可用）。
 */

/** 运行短命令并捕获输出（探测专用） */
function runCapture(
  program: string,
  args: string[],
  timeoutMs: number,
  opts: { windowsVerbatimArguments?: boolean; env?: Record<string, string> } = {}
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(program, args, {
        env: opts.env !== undefined ? { ...process.env, ...opts.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(opts.windowsVerbatimArguments !== undefined
          ? { windowsVerbatimArguments: opts.windowsVerbatimArguments }
          : {})
      })
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try {
          child.kill()
        } catch {
          // 已退出
        }
        resolve(null)
      }
    }, timeoutMs)

    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(null)
      }
    })
    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8') })
      }
    })
  })
}

/** where.exe 定位可执行文件的全部 PATH 命中 */
async function locateOnPath(name: string): Promise<string[]> {
  const res = await runCapture('where.exe', [name], DETECT_TIMEOUT_MS)
  if (res === null || res.code !== 0) return []
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && l.toLowerCase().endsWith('.exe'))
}

/** 校验可执行文件可用并提取版本行（第一行非空输出） */
async function verifyVersion(program: string): Promise<string | null> {
  const res = await runCapture(program, ['--version'], DETECT_TIMEOUT_MS)
  if (res === null || res.code !== 0) return null
  const firstLine = res.stdout.split(/\r?\n/).find((l) => l.trim() !== '')
  return firstLine?.trim() ?? null
}

interface DetectedToolchain {
  kind: Toolchain['kind']
  program: string
  version: string
  env?: Record<string, string>
}

/** 探测 gcc/clang 系编译器 */
async function detectGccFamily(): Promise<DetectedToolchain[]> {
  const probes: { exe: string; kind: Toolchain['kind'] }[] = [
    { exe: 'gcc.exe', kind: 'gcc-c' },
    { exe: 'g++.exe', kind: 'gcc-cpp' },
    { exe: 'clang.exe', kind: 'clang-c' },
    { exe: 'clang++.exe', kind: 'clang-cpp' }
  ]
  const found: DetectedToolchain[] = []
  for (const p of probes) {
    const hits = await locateOnPath(p.exe)
    for (const hit of hits) {
      const version = await verifyVersion(hit)
      if (version === null) continue
      found.push({ kind: p.kind, program: hit, version })
      break // 每个名字只取第一个可用命中
    }
  }
  return found
}

/** 探测 Python（python/py，排除 Store 空壳） */
async function detectPython(): Promise<DetectedToolchain[]> {
  const found: DetectedToolchain[] = []
  for (const name of ['python.exe', 'py.exe']) {
    const hits = await locateOnPath(name)
    for (const hit of hits) {
      const version = await verifyVersion(hit)
      if (version === null || !/Python\s+\d/.test(version)) continue
      found.push({ kind: 'python', program: hit, version })
      break
    }
  }
  return found
}

/** 解析 vcvars64.bat 导出的环境变量差异（WIN-3） */
async function resolveMsvcEnv(vcvarsBat: string, toolsDir: string): Promise<Record<string, string> | null> {
  // 唯一经过 cmd 的场景：bat 路径来自 vswhere 定位（非用户输入），结构固定。
  // 注意：/d /c + windowsVerbatimArguments —— cmd 引号保留规则要求"恰好一对引号且
  // 引号间是可执行文件名"；/S 会剥离引号导致含空格路径断裂。Node 20.12+ 对 cmd.exe
  // 参数自动转义，必须显式禁用（verbatim）才能保留引号语义。
  const res = await runCapture(
    'cmd.exe',
    ['/d', '/c', `"${vcvarsBat}" && set`],
    60_000,
    { windowsVerbatimArguments: true }
  )
  if (res === null || res.code !== 0) return null

  const env: Record<string, string> = {}
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m === null) continue
    const key = m[1] ?? ''
    const value = m[2] ?? ''
    const current = process.env[key]
    // 只保留差异（新增或值变化），减少注入面
    if (current !== value) env[key] = value
  }
  if (env['PATH'] === undefined) {
    env['PATH'] = toolsDir
  }
  // PATH 需要保留原值前缀（运行期系统 DLL 查找）
  env['PATH'] = `${toolsDir};${process.env['PATH'] ?? ''}`
  return env
}

/** 探测 MSVC（C 与 C++ 共用 cl.exe 与环境） */
async function detectMsvc(): Promise<DetectedToolchain[]> {
  const installDir = locateMsvcInstall()
  if (installDir === null) return []
  const located = locateCl(installDir)
  if (located === null) return []
  const vcvars = join(installDir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  if (!existsSync(vcvars)) return []
  const env = await resolveMsvcEnv(vcvars, located.toolsDir)
  if (env === null) {
    logger.warn('MSVC vcvars64 环境解析失败，MSVC 不可用')
    return []
  }
  const version = await verifyMsvcVersion(located.clPath, env)
  return [
    { kind: 'msvc-c', program: located.clPath, version, env },
    { kind: 'msvc-cpp', program: located.clPath, version, env }
  ]
}

async function verifyMsvcVersion(clPath: string, env: Record<string, string>): Promise<string> {
  // cl.exe 无参数运行会打印版本 banner（exit 非零属预期，只取输出首行）
  const res = await runCapture(clPath, [], DETECT_TIMEOUT_MS, { env })
  const firstLine = res?.stdout.split(/\r?\n/).find((l) => l.trim() !== '')
  return firstLine?.trim() ?? 'Microsoft (R) C/C++ Optimizing Compiler'
}

/** 全量探测：返回全部可用工具链 */
export async function detectAllToolchains(): Promise<Toolchain[]> {
  const detected = await Promise.all([detectGccFamily(), detectPython(), detectMsvc()])
  const flat = detected.flat()
  return flat.map((d) => ({
    id: `${d.kind}:${d.program}`,
    languageIds: languagesOf(d.kind),
    kind: d.kind,
    program: d.program,
    version: d.version,
    source: 'path',
    ...(d.env !== undefined ? { env: d.env } : {})
  }))
}

function languagesOf(kind: Toolchain['kind']): LanguageId[] {
  switch (kind) {
    case 'gcc-c':
    case 'clang-c':
    case 'msvc-c':
      return ['c']
    case 'gcc-cpp':
    case 'clang-cpp':
    case 'msvc-cpp':
      return ['cpp']
    case 'python':
      return ['python']
  }
}
