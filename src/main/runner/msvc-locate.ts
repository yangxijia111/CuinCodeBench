import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { DETECT_TIMEOUT_MS } from '@shared/constants'

/**
 * MSVC 定位（从 detect.ts 拆出，便于独立测试）：
 * vswhere 定位安装目录 → 找最新 cl.exe。纯文件系统/进程查询，无环境解析。
 */

/** vswhere 定位 MSVC 安装目录 */
export function locateMsvcInstall(): string | null {
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (!programFilesX86) return null
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null

  const res = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath'
    ],
    { encoding: 'utf8', timeout: DETECT_TIMEOUT_MS, windowsHide: true }
  )
  const path = res.stdout?.trim()
  return path !== '' && path !== undefined && existsSync(path) ? path : null
}

/** 在安装目录中找最新版 cl.exe 及其工具目录 */
export function locateCl(installDir: string): { clPath: string; toolsDir: string } | null {
  const msvcRoot = join(installDir, 'VC', 'Tools', 'MSVC')
  if (!existsSync(msvcRoot)) return null
  let versions: string[]
  try {
    versions = readdirSync(msvcRoot).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  } catch {
    return null
  }
  for (const v of versions) {
    const toolsDir = join(msvcRoot, v)
    const cl = join(toolsDir, 'bin', 'Hostx64', 'x64', 'cl.exe')
    if (existsSync(cl)) return { clPath: cl, toolsDir }
  }
  return null
}
