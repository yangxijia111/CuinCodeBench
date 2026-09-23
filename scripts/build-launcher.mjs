#!/usr/bin/env node
// 构建 ccb-launcher（v1.3）：vswhere 定位 MSVC → vcvars64 环境 → cl.exe 编译。
// 产物 gitignore（native/bin/），不入库——Windows CI 每次实际编译（release 资产由 CI 产出）。
// 用法：node scripts/build-launcher.mjs [--poc]   （--poc 只编 PoC：native/ccb-launcher/poc.cpp）
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const repoRoot = join(import.meta.dirname, '..')
const nativeDir = join(repoRoot, 'native', 'ccb-launcher')
const outBin = join(repoRoot, 'native', 'bin')

function fail(msg) {
  console.error(`[build-launcher] ${msg}`)
  process.exit(1)
}

function locateMsvcInstall() {
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (!programFilesX86) return null
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  const res = spawnSync(
    vswhere,
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true }
  )
  const path = res.stdout?.trim()
  return path && existsSync(path) ? path : null
}

function locateCl(installDir) {
  const msvcRoot = join(installDir, 'VC', 'Tools', 'MSVC')
  if (!existsSync(msvcRoot)) return null
  let versions
  try {
    versions = readdirSync(msvcRoot).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  } catch {
    return null
  }
  for (const v of versions) {
    const cl = join(msvcRoot, v, 'bin', 'Hostx64', 'x64', 'cl.exe')
    if (existsSync(cl)) {
      return { cl, vcvars: join(installDir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat') }
    }
  }
  return null
}

if (process.platform !== 'win32') {
  fail('仅在 Windows 上构建（非 Windows 平台 Runner 使用 fallback，无需 launcher）')
}

const installDir = locateMsvcInstall()
if (installDir === null) fail('未找到 MSVC（vswhere 无结果或缺少 VC.Tools.x86.x64 组件）')
const located = locateCl(installDir)
if (located === null) fail('MSVC 安装目录中未找到 Hostx64/x64 cl.exe')
if (!existsSync(located.vcvars)) fail(`vcvars64.bat 不存在：${located.vcvars}`)

const pocOnly = process.argv.includes('--poc')
const sources = pocOnly ? [join(nativeDir, 'poc.cpp')] : [join(nativeDir, 'launcher.cpp')]
for (const src of sources) {
  if (!existsSync(src)) fail(`源文件不存在：${src}`)
}
const outputExe = pocOnly ? 'ccb-launcher-poc.exe' : 'ccb-launcher.exe'

mkdirSync(outBin, { recursive: true })
const objDir = join(tmpdir(), 'ccb-launcher-build')
rmSync(objDir, { recursive: true, force: true })
mkdirSync(objDir, { recursive: true })

// cl 参数（/utf-8：源码与执行字符集均为 UTF-8——中文注释在 GBK 代码页下会被
// 错误解码破坏语法（C4819）；/MT 静态 CRT：目标机零 VC Redist 依赖，ADR D8）
const clArgs = [
  '/nologo', '/EHsc', '/O2', '/W4', '/utf-8', '/std:c++17', '/MT',
  ...sources,
  `/Fo${objDir}\\`,
  `/Fe${join(outBin, outputExe)}`
]

// 唯一经过 cmd 的场景：bat 路径来自 vswhere 定位（非用户输入），结构固定；
// /d /c + verbatim 引号语义与 src/main/runner/detect.ts resolveMsvcEnv 同源约定
const quoted = clArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')
const script = `@echo off\r\ncall "${located.vcvars}" >nul 2>&1\r\nif errorlevel 1 exit /b 1\r\ncl ${quoted}\r\n`
const batPath = join(objDir, 'build.cmd')
writeFileSync(batPath, script)

console.log(`[build-launcher] MSVC: ${located.cl}`)
console.log(`[build-launcher] 输出: ${join(outBin, outputExe)}`)
try {
  execFileSync('cmd.exe', ['/d', '/c', batPath], { stdio: 'inherit', timeout: 120_000, windowsVerbatimArguments: true })
} catch {
  fail('cl.exe 编译失败（详见上方输出）')
}

if (!existsSync(join(outBin, outputExe))) fail('编译完成但产物缺失')
rmSync(objDir, { recursive: true, force: true })
console.log('[build-launcher] 完成')
