import { describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { execute } from '../src/main/runner/execute'
import { withTempDir, tempRoot, cleanLegacyTempDirs } from '../src/main/runner/temp-dir'
import { detectAllToolchains } from '../src/main/runner/detect'
import { buildRunPlan, selectToolchain } from '../src/main/runner/languages'
import { normalizeOutput } from '../src/main/judge/normalize'
import { compileSource, writeSourceFile } from '../src/main/runner/compile'
import type { Toolchain } from '../src/shared/types'

/**
 * Runner 集成测试（TEST_PLAN §2，FR-R4–R8）：
 * - node 桩语言：任何机器验证执行器管线（stdin/超时/超限/编码/清理）
 * - python / gcc / MSVC：检测到工具链才执行（describe.skipIf）
 * 探测必须在模块顶层完成：skipIf 于测试收集期求值，早于 beforeAll。
 */

const projectRoot = resolve(__dirname, '..')
const portableGccDir = join(projectRoot, '.tools', 'w64devkit', 'bin')

// 便携 MinGW 注入 PATH（若存在），使 gcc/g++ 探测在本机可测
if (existsSync(portableGccDir)) {
  process.env['PATH'] = `${portableGccDir};${process.env['PATH'] ?? ''}`
}

const hasNode = true // 本测试运行在 node 上

// —— 顶层一次性探测（此时 PATH 注入已生效） ——
const allDetected = await detectAllToolchains()
const pythonToolchain: Toolchain | null = selectToolchain(allDetected, 'python')
const gccToolchain: Toolchain | null = selectToolchain(allDetected, 'c')
const gppToolchain: Toolchain | null = selectToolchain(allDetected, 'cpp')
const msvcCToolchain: Toolchain | null = allDetected.find((t) => t.kind === 'msvc-c') ?? null
const msvcCppToolchain: Toolchain | null = allDetected.find((t) => t.kind === 'msvc-cpp') ?? null

/** 用指定工具链完整跑一次（写源码→编译→运行），返回 execute 结果与编译报告 */
async function fullRun(
  toolchain: Toolchain,
  code: string,
  stdin: string,
  timeoutMs = 10_000
): Promise<{ compileOk: boolean; compileStderr: string; execution: Awaited<ReturnType<typeof execute>> | null }> {
  return withTempDir(async (dir) => {
    await writeSourceFile(toolchain, dir, code)
    const compile = await compileSource(toolchain, dir)
    if (!compile.ok) {
      return { compileOk: false, compileStderr: compile.stderr, execution: null }
    }
    const plan = buildRunPlan(toolchain, dir)
    const execution = await execute({
      program: plan.run.program,
      args: plan.run.args ?? [],
      cwd: dir,
      stdin,
      timeoutMs,
      env: plan.run.env
    })
    return { compileOk: true, compileStderr: '', execution }
  })
}

describe('execute 执行器（node 桩）', () => {
  const node = process.execPath

  it('Hello World：stdout 捕获与 exit 0', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'process.stdout.write("hello world")'],
        cwd: dir,
        stdin: '',
        timeoutMs: 10_000
      })
    )
    expect(result.status).toBe('ok')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello world')
  })

  it('stdin/stdout：回显求和', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', `
          let input = '';
          process.stdin.on('data', (d) => { input += d });
          process.stdin.on('end', () => {
            const [a, b] = input.trim().split(/\\s+/).map(Number);
            process.stdout.write(String(a + b));
          });`],
        cwd: dir,
        stdin: '3 4\n',
        timeoutMs: 10_000
      })
    )
    expect(result.status).toBe('ok')
    expect(result.stdout).toBe('7')
  })

  it('运行时错误：非零 exit 与 stderr', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
        cwd: dir,
        stdin: '',
        timeoutMs: 10_000
      })
    )
    expect(result.status).toBe('ok')
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe('boom')
  })

  it('无限循环超时：TLE 且进程被杀', async () => {
    const start = Date.now()
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: dir,
        stdin: '',
        timeoutMs: 1_500
      })
    )
    const elapsed = Date.now() - start
    expect(result.status).toBe('timeout')
    expect(result.timedOut).toBe(true)
    // 超时应在 1.5s + 兜底余量内返回（不挂死）
    expect(elapsed).toBeLessThan(10_000)
  })

  it('大量输出：超过 1MB 触发 OLE 与截断', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))'],
        cwd: dir,
        stdin: '',
        timeoutMs: 15_000
      })
    )
    expect(result.status).toBe('output_limit')
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024)
  })

  it('H6：可配置输出上限（outputLimitBytes）生效且进程被杀', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'setInterval(() => process.stdout.write("y".repeat(1024)), 5)'],
        cwd: dir,
        stdin: '',
        timeoutMs: 15_000,
        outputLimitBytes: 100 * 1024
      })
    )
    expect(result.status).toBe('output_limit')
    expect(result.stdoutTruncated).toBe(true)
    // 上限收紧到 100KB 后，捕获内容不应超过该值（含部分 chunk 容差）
    expect(result.stdout.length).toBeLessThanOrEqual(100 * 1024 + 4096)
  })

  it('Unicode：中文与 emoji 往返一致', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'process.stdout.write("你好，世界 🌍 héllo")'],
        cwd: dir,
        stdin: '',
        timeoutMs: 10_000
      })
    )
    expect(result.stdout).toBe('你好，世界 🌍 héllo')
  })

  it('空输入：正常结束', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: node,
        args: ['-e', 'process.exit(0)'],
        cwd: dir,
        stdin: '',
        timeoutMs: 10_000
      })
    )
    expect(result.status).toBe('ok')
    expect(result.exitCode).toBe(0)
  })

  it('spawn 失败：不存在的程序返回 spawn_error', async () => {
    const result = await withTempDir(async (dir) =>
      execute({
        program: join(dir, 'definitely-not-exist.exe'),
        args: [],
        cwd: dir,
        stdin: '',
        timeoutMs: 5_000
      })
    )
    expect(result.status).toBe('spawn_error')
  })

  it('withTempDir：任务结束目录被清理', async () => {
    let dirUsed = ''
    await withTempDir(async (dir) => {
      dirUsed = dir
      await Promise.resolve()
      return dir
    })
    expect(existsSync(dirUsed)).toBe(false)
    expect(dirUsed.startsWith(tempRoot())).toBe(true)
  })

  it('withTempDir：任务抛错时同样清理', async () => {
    let dirUsed = ''
    await expect(
      withTempDir(async (dir) => {
        dirUsed = dir
        await Promise.resolve()
        throw new Error('任务失败')
      })
    ).rejects.toThrow('任务失败')
    expect(existsSync(dirUsed)).toBe(false)
  })

  it('cleanLegacyTempDirs：不抛错且返回数量', async () => {
    const n = await cleanLegacyTempDirs()
    expect(n).toBeGreaterThanOrEqual(0)
  })
})

describe.skipIf(pythonToolchain === null)('Python Runner（真实解释器）', () => {
  const py = pythonToolchain
  const run = (code: string, stdin: string, timeoutMs = 10_000) => fullRun(py as Toolchain, code, stdin, timeoutMs)

  it('Hello World', async () => {
    const { compileOk, execution } = await run('print("hello python")', '')
    expect(compileOk).toBe(true)
    // Windows 管道文本模式输出 CRLF；与判题一致用归一化比较
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('hello python')
    expect(execution?.exitCode).toBe(0)
  })

  it('stdin 求和', async () => {
    const { execution } = await run('a, b = map(int, input().split())\nprint(a + b)', '10 32\n')
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('42')
  })

  it('运行时异常 → 非零 exit 与 stderr', async () => {
    const { execution } = await run('raise RuntimeError("oops")', '')
    expect(execution?.exitCode).not.toBe(0)
    expect(execution?.stderr).toContain('RuntimeError')
  })

  it('无限循环 → TLE', async () => {
    const { execution } = await run('while True:\n    pass', '', 1_500)
    expect(execution?.status).toBe('timeout')
  })

  it('Unicode 输出', async () => {
    const { execution } = await run('print("中文 → ✓ 🎉")', '')
    expect(execution?.status).toBe('ok')
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('中文 → ✓ 🎉')
  })

  it('空输入正常结束', async () => {
    const { execution } = await run('pass', '')
    expect(execution?.exitCode).toBe(0)
  })
})

describe.skipIf(gccToolchain === null)('C Runner（gcc/clang/MSVC 中首个可用者）', () => {
  const cc = gccToolchain
  const run = (code: string, stdin: string, timeoutMs = 10_000) => fullRun(cc as Toolchain, code, stdin, timeoutMs)

  it('Hello World', async () => {
    const { compileOk, execution } = await run(
      '#include <stdio.h>\nint main(void){printf("hello c\\n");return 0;}',
      ''
    )
    expect(compileOk).toBe(true)
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('hello c')
  })

  it('编译错误：exit 非零且 stderr 有信息', async () => {
    const { compileOk, compileStderr } = await run('int main( { broken', '')
    expect(compileOk).toBe(false)
    expect(compileStderr.length).toBeGreaterThan(0)
  })

  it('stdin 求和', async () => {
    const { execution } = await run(
      '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}',
      '5 7\n'
    )
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('12')
  })

  it('段错误/abort → RE', async () => {
    const { execution } = await run(
      '#include <stdlib.h>\nint main(void){abort();return 0;}',
      ''
    )
    expect(execution?.exitCode).not.toBe(0)
  })

  it('无限循环 → TLE', async () => {
    const { execution } = await run('int main(void){while(1){}return 0;}', '', 1_500)
    expect(execution?.status).toBe('timeout')
  })

  it('大量输出 → OLE', async (ctx) => {
    const { execution } = await run(
      '#include <stdio.h>\nint main(void){for(long i=0;i<3L*1024*1024;i++){putchar(120);}fflush(stdout);return 0;}',
      '',
      20_000
    )
    // 杀软可能持续拦截新编译的无签名 exe（spawn EPERM）——环境限制，非产品缺陷
    // （SECURITY.md WIN-7）；OLE 管线本身由 node 桩用例覆盖
    if (execution?.status === 'spawn_error' && /EPERM|EACCES|EBUSY/i.test(execution.stderr)) {
      ctx.skip()
      return
    }
    expect(execution?.status).toBe('output_limit')
  })
})

describe.skipIf(gppToolchain === null)('C++ Runner', () => {
  const cxx = gppToolchain
  it('Hello World（iostream）', async () => {
    const { compileOk, execution } = await fullRun(
      cxx as Toolchain,
      '#include <iostream>\nint main(){std::cout << "hello cpp" << std::endl;return 0;}',
      ''
    )
    expect(compileOk).toBe(true)
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('hello cpp')
  })
})

describe.skipIf(msvcCppToolchain === null && msvcCToolchain === null)('MSVC 专项', () => {
  it('C++ 编译并运行（vcvars 环境）', async () => {
    if (msvcCppToolchain === null) return
    const { compileOk, execution, compileStderr } = await fullRun(
      msvcCppToolchain,
      '#include <iostream>\nint main(){std::cout << "hello msvc" << std::endl;return 0;}',
      ''
    )
    if (!compileOk) {
      // vcvars 解析失败等信息在这里可见，便于诊断
      throw new Error(`MSVC 编译失败: ${compileStderr.slice(0, 500)}`)
    }
    expect(normalizeOutput(execution?.stdout ?? '')).toBe('hello msvc')
  })

  it('MSVC 编译错误可见', async () => {
    if (msvcCToolchain === null) return
    const { compileOk, compileStderr } = await fullRun(msvcCToolchain, 'int main( {', '')
    expect(compileOk).toBe(false)
    expect(compileStderr.length).toBeGreaterThan(0)
  })
})

// node 可用性哨兵（防止上面 describe 因环境问题静默全跳）
describe.skipIf(!hasNode)('环境哨兵', () => {
  it('node 可执行', () => {
    expect(existsSync(process.execPath)).toBe(true)
    expect(execSync('node -v').toString()).toMatch(/v\d+/)
  })
})
