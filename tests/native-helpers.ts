import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** native 测试公共助手（PoC 与正式 launcher 测试共用） */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function pythonExe(): string {
  const res = spawnSync('where.exe', ['python.exe'], { encoding: 'utf8', timeout: 10_000 })
  const hit = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().endsWith('python.exe'))
  if (!hit) throw new Error('测试需要 python（与判题 E2E 同门槛）')
  return hit
}

/** 进程命令行扫描（无孤儿断言用；等价 E2E findOrphan 思路） */
export function listCmdLines(filter: 'python.exe' | 'ccb-launcher.exe' = 'python.exe'): string[] {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${filter}'" | Select-Object -ExpandProperty CommandLine`
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )
  return (res.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** 断言带 marker 的测试子进程全部消失（预算内轮询）；返回预算耗尽后的残留 */
export async function assertTreeGone(marker: string, budgetMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const remaining = listCmdLines().filter((l) => l.includes(marker))
    if (remaining.length === 0) return []
    if (Date.now() > deadline) return remaining
    await sleep(300)
  }
}

/** 写一个 python 脚本到临时目录并返回路径（用例结束后由调用方清理目录） */
export function writePy(name: string, body: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ccb-native-'))
  const file = join(dir, name)
  writeFileSync(file, body, 'utf8')
  return { dir, file }
}

export function nativeExePath(name: string): string {
  return join(process.cwd(), 'native', 'bin', name)
}

export function nativeExeExists(name: string): boolean {
  return process.platform === 'win32' && existsSync(nativeExePath(name))
}
