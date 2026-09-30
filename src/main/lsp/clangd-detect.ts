import { execSync } from 'child_process'
import { DETECT_TIMEOUT_MS } from '@shared/constants'

/**
 * clangd 检测（docs/V1_4_DESIGN.md §2）：复用 toolchain 探测的 where.exe + --version 模式。
 * clangd 不进 ToolchainService（它不是判题工具链），独立轻量探测 + 设置页手工路径覆盖。
 * 测试注入：overrideClangdPath（null = 强制视为不可用；undefined = 恢复常规解析）。
 */

export interface ClangdInfo {
  program: string
  version: string
  source: 'path' | 'manual'
}

let override: ClangdInfo | null | undefined

/** 测试注入专用：强制 clangd 信息 / 禁用（null）/ 恢复常规解析（undefined） */
export function overrideClangdPath(info: ClangdInfo | null | undefined): void {
  override = info
}

/**
 * 解析 clangd 可执行路径：手工路径（存在且 --version 可用）优先，否则 PATH 探测。
 * 找不到返回 null（LspService 走编译器回退链）。
 */
export function resolveClangd(manualPath: string | undefined): ClangdInfo | null {
  if (override !== undefined) return override
  if (manualPath !== undefined && manualPath.trim() !== '') {
    const version = probeVersion(manualPath.trim())
    if (version !== null) return { program: manualPath.trim(), version, source: 'manual' }
    // 手工路径无效 → 继续 PATH 探测（不静默吞掉用户的显式指定，但也不因此整体禁用）
  }
  const found = locateOnPath('clangd.exe') ?? locateOnPath('clangd')
  if (found === null) return null
  const version = probeVersion(found)
  if (version === null) return null
  return { program: found, version, source: 'path' }
}

function locateOnPath(name: string): string | null {
  try {
    const out = execSync(`where.exe ${name}`, { timeout: DETECT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '')
    return hit ?? null
  } catch {
    return null
  }
}

function probeVersion(program: string): string | null {
  try {
    const out = execSync(`"${program}" --version`, { timeout: DETECT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const firstLine = out.split(/\r?\n/).find((l) => l.trim() !== '')
    if (firstLine === undefined) return null
    return /clangd version \d/i.test(firstLine) ? firstLine.trim() : null
  } catch {
    return null
  }
}
