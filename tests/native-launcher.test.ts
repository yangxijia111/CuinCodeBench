import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  executeNative,
  ensureTreeGone
} from '../src/main/runner/native-launcher'
import { execute } from '../src/main/runner/execute'
import { overrideLauncherPath } from '../src/main/runner/resolve-launcher'
import { assertTreeGone, nativeExeExists, nativeExePath, pythonExe, writePy } from './native-helpers'
import { OUTPUT_LIMIT_BYTES } from '../src/shared/constants'

/**
 * ccb-launcher 正式集成测试（v1.3 P2/P3，docs/V1_3_TEST_PLAN §1）。
 * - 真实 launcher.exe + 真实 python 子进程；
 * - 对拍（§1.1）：同输入经 executeNative 与 execute（fallback），stdout/exitCode/状态一致；
 * - 资源围栏（§1.2）：timeout/output/memory/process limit + launcher 强杀 + 无孤儿断言。
 */

const enabled = nativeExeExists('ccb-launcher.exe')
const LAUNCHER = nativeExePath('ccb-launcher.exe')
const PY = enabled ? pythonExe() : ''

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccb-nl-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(!enabled)('ccb-launcher 正式集成（帧协议 + Job Object）', () => {
  beforeAll(() => {
    overrideLauncherPath(LAUNCHER)
  })

  it('hello world：stdout/exitCode 透传', async () => {
    const r = await executeNative(
      { program: PY, args: ['-c', 'print("nl-hello")'], cwd: tempDir(), stdin: '', timeoutMs: 10_000 },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('ok')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('nl-hello')
    expect(r.timedOut).toBe(false)
    expect(r.terminationReason).toBeNull()
  })

  it('stdout/stderr 同时输出，两路不混流', async () => {
    const r = await executeNative(
      {
        program: PY,
        args: ['-c', 'import sys; print("to-out"); sys.stderr.write("to-err\\n")'],
        cwd: tempDir(),
        stdin: '',
        timeoutMs: 10_000
      },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('ok')
    expect(r.stdout).toContain('to-out')
    expect(r.stdout).not.toContain('to-err')
    expect(r.stderr).toContain('to-err')
    expect(r.stderr).not.toContain('to-out')
  })

  it('大 stdin（600KB，跨 3 帧）完整送达', async () => {
    const big = ('x'.repeat(1024) + '\n').repeat(600) // ~600KB
    const { dir, file } = writePy(
      'stdin_len.py',
      "import sys; data = sys.stdin.buffer.read(); print(len(data)); print(data.count(b'x'))"
    )
    const r = await executeNative(
      { program: PY, args: [file], cwd: dir, stdin: big, timeoutMs: 20_000 },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('ok')
    expect(r.stdout).toContain(String(big.length))
  })

  it('非 ASCII UTF-8：中文 stdin/参数往返', async () => {
    const { dir, file } = writePy(
      'echo_cn.py',
      "import sys; print(sys.argv[1]); print(sys.stdin.buffer.read().decode('utf-8'))"
    )
    const r = await executeNative(
      {
        program: PY,
        // 与产品 RunPlan 一致：-I -X utf8（管道 stdout 编码才不是 locale GBK）
        args: ['-I', '-X', 'utf8', file, '中文参数'],
        cwd: dir,
        stdin: '中文输入\n第二行',
        timeoutMs: 10_000,
        env: { PYTHONIOENCODING: 'utf-8' }
      },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('ok')
    expect(r.stdout).toContain('中文参数')
    expect(r.stdout).toContain('中文输入')
    expect(r.stdout).toContain('第二行')
  })

  it('崩溃程序：异常退出码（有符号化对拍一致）', async () => {
    const r = await executeNative(
      {
        program: PY,
        args: ['-c', 'import ctypes; ctypes.windll.kernel32.ExitProcess(0xC0000005)'],
        cwd: tempDir(),
        stdin: '',
        timeoutMs: 10_000
      },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('ok')
    expect(r.exitCode).toBeLessThan(0) // 0xC0000005 → -1073741819
  })

  it('timeout：死循环被 launcher 终止，terminationReason=timeout', async () => {
    const r = await executeNative(
      {
        program: PY,
        args: ['-c', 'while True: pass'],
        cwd: tempDir(),
        stdin: '',
        timeoutMs: 1_500
      },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('timeout')
    expect(r.timedOut).toBe(true)
    expect(r.terminationReason).toBe('timeout')
    expect(r.durationMs).toBeLessThan(10_000)
  })

  it('output limit：无限输出被双层限制终止', async () => {
    const r = await executeNative(
      {
        program: PY,
        args: ['-c', 'while True: print("x" * 4096, flush=True)'],
        cwd: tempDir(),
        stdin: '',
        timeoutMs: 20_000
      },
      { outputLimitBytes: 256 * 1024 },
      LAUNCHER
    )
    expect(r.status).toBe('output_limit')
    expect(r.stdoutTruncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES)
    expect(r.durationMs).toBeLessThan(15_000)
  })

  it('memory limit：512MB 默认上限截断内存吞噬 → runtime_error + reason', async () => {
    const { dir, file } = writePy(
      'hog.py',
      [
        'import sys',
        'chunks = []',
        'try:',
        '    while True:',
        '        b = bytearray(8 * 1024 * 1024)',
        '        for i in range(0, len(b), 4096): b[i] = 1',
        '        chunks.append(b)',
        'except MemoryError:',
        '    sys.exit(42)'
      ].join('\n')
    )
    const r = await executeNative(
      { program: PY, args: [file], cwd: dir, stdin: '', timeoutMs: 30_000 },
      { memoryLimitBytes: 128 * 1024 * 1024 },
      LAUNCHER
    )
    // 分配失败 → MemoryError → 非零退出 → runtime_error 判定不变，原因保留
    expect(r.exitCode).not.toBe(0)
    expect(r.terminationReason).toBe('memory_limit')
  })

  it('process limit：fork 炸弹被 ACTIVE_PROCESS_LIMIT 截断', async () => {
    const marker = `ccb-nl-bomb-${Date.now()}`
    const { dir, file } = writePy(
      'bomb.py',
      [
        'import subprocess, sys, time',
        'marker = sys.argv[1]',
        'while True:',
        '    try:',
        '        subprocess.Popen([sys.executable, sys.argv[0], marker],',
        '                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
        '    except Exception:',
        '        time.sleep(0.2)'
      ].join('\n')
    )
    const r = await executeNative(
      { program: PY, args: [file, marker], cwd: dir, stdin: '', timeoutMs: 3_000 },
      { processLimit: 6 },
      LAUNCHER
    )
    // 语义：进程数被截断（炸弹无法扩散），最终由 timeout 收尾
    expect(r.status).toBe('timeout')
    expect(r.terminationReason).toBe('timeout')
    const remaining = await assertTreeGone(marker)
    expect(remaining, `炸弹遗留: ${remaining.join(' | ')}`).toEqual([])
  })

  it('launcher 被强杀：launcher_died + KILL_ON_JOB_CLOSE 清树 + Node 复查', async () => {
    const marker = `ccb-nl-killed-${Date.now()}`
    const { dir, file } = writePy(
      'sleeper.py',
      [
        'import subprocess, sys, time',
        'marker = sys.argv[1]',
        'subprocess.Popen([sys.executable, "-c", f"import time; time.sleep(60)  # {marker}"])',
        'while True: time.sleep(1)'
      ].join('\n')
    )
    const p = executeNative(
      { program: PY, args: [file, marker], cwd: dir, stdin: '', timeoutMs: 60_000 },
      {},
      LAUNCHER
    )
    // 等子进程真正起来（轮询 marker 进程出现）
    const deadline = Date.now() + 10_000
    let spawned = false
    while (Date.now() < deadline) {
      const { listCmdLines } = await import('./native-helpers')
      if (listCmdLines().some((l) => l.includes(marker))) {
        spawned = true
        break
      }
      await new Promise((r2) => setTimeout(r2, 200))
    }
    expect(spawned, '测试子进程未启动').toBe(true)

    // 强杀执行中的 launcher（模拟崩溃）
    const { spawnSync } = await import('child_process')
    const { execSync } = await import('child_process')
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='ccb-launcher.exe'\\").ProcessId"`,
      { encoding: 'utf8', timeout: 20_000 }
    )
    const pids = out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
    expect(pids.length).toBeGreaterThan(0)
    for (const pid of pids) {
      spawnSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore', timeout: 10_000 })
    }

    const r = await p
    expect(r.status).toBe('spawn_error')
    expect(r.terminationReason).toBe('launcher_died')
    // Node 侧契约：验证树清理完成（childPid 兜底）
    const remaining = await assertTreeGone(marker)
    expect(remaining, `强杀 launcher 后遗留: ${remaining.join(' | ')}`).toEqual([])
  })

  it('协议错误：目标程序不存在 → spawn_error（可读原因，不悬挂）', async () => {
    const r = await executeNative(
      {
        program: 'Z:\\definitely\\not\\exist\\prog.exe',
        args: [],
        cwd: tempDir(),
        stdin: '',
        timeoutMs: 10_000
      },
      {},
      LAUNCHER
    )
    expect(r.status).toBe('spawn_error')
    expect(r.terminationReason).toBe('protocol_error')
    expect(r.stderr).toContain('create_process_failed')
  })

  it('对拍：executeNative 与 execute（fallback）同输入结果一致', async () => {
    const { dir, file } = writePy(
      'echo.py',
      'import sys; data = sys.stdin.buffer.read().decode("utf-8"); print("ECHO:" + data); raise SystemExit(3)'
    )
    const opts = {
      program: PY,
      // -I -X utf8 + PYTHONIOENCODING：与产品 RunPlan 一致（CI runner 管道 stdout
      // 编码为 locale cp1252，中文 print 会 UnicodeEncodeError → 双路径一致 exit 1）
      args: ['-I', '-X', 'utf8', file],
      cwd: dir,
      stdin: '对拍输入 line1\nline2',
      timeoutMs: 10_000,
      env: { PYTHONIOENCODING: 'utf-8' }
    }
    const legacy = await execute(opts)
    const native = await executeNative(opts, {}, LAUNCHER)
    expect(native.status).toBe(legacy.status)
    expect(native.exitCode).toBe(legacy.exitCode)
    expect(native.stdout).toBe(legacy.stdout)
    expect(native.timedOut).toBe(legacy.timedOut)
    expect(native.stdoutTruncated).toBe(legacy.stdoutTruncated)
    expect(native.exitCode).toBe(3)
    expect(native.stdout).toContain('ECHO:对拍输入 line1')
  })

  it('并发 5 个 launcher：互不串扰，全部成功', async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        executeNative(
          {
            program: PY,
            args: ['-c', `print("cc-${i}"); import sys; sys.exit(0)`],
            cwd: tempDir(),
            stdin: '',
            timeoutMs: 15_000
          },
          {},
          LAUNCHER
        )
      )
    )
    for (const [i, r] of runs.entries()) {
      expect(r.status, `run ${i}`).toBe('ok')
      expect(r.stdout, `run ${i}`).toContain(`cc-${i}`)
    }
  })

  it('ensureTreeGone：存活 pid 强杀路径 + 已死 pid 快速确认', async () => {
    const { spawn } = await import('child_process')
    const sleeper = spawn(PY, ['-c', 'import time; time.sleep(30)'], { stdio: 'ignore' })
    expect(sleeper.pid).toBeDefined()
    const gone = await ensureTreeGone(sleeper.pid!, 10_000)
    expect(gone).toBe(true)
    // 已死 pid（复用一个必然不存在的 pid）
    const gone2 = await ensureTreeGone(4_000_000_000, 5_000)
    expect(gone2).toBe(true)
  })
})
