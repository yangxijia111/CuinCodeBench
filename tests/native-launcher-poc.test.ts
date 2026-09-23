import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * ccb-launcher PoC 验证（v1.3 P1，docs/V1_3_TEST_PLAN §2）。
 * 门槛：真实 Windows + 已编译 PoC exe + 真实 python 子进程。
 * 六项验证通过后才允许进入 P2 正式实现（docs/V1_3_ROADMAP.md P1 完成标准）。
 */

const EXE = join(process.cwd(), 'native', 'bin', 'ccb-launcher-poc.exe')
const enabled = process.platform === 'win32' && existsSync(EXE)

function pythonExe(): string {
  const res = spawnSync('where.exe', ['python.exe'], { encoding: 'utf8', timeout: 10_000 })
  const hit = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().endsWith('python.exe'))
  if (!hit) throw new Error('测试需要 python（与判题 E2E 同门槛）')
  return hit
}

const PY = enabled ? pythonExe() : ''

interface PocResult {
  ok: boolean
  stage?: string
  win32LastError?: number
  exitCode?: number
  timedOut?: boolean
  peakProcessMemoryBytes?: number
  peakJobMemoryBytes?: number
}

interface PocRun {
  launcherExit: number | null
  stdout: string
  result: PocResult
}

function runPoc(args: string[], opts: { timeoutMs?: number } = {}): Promise<PocRun> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-poc-'))
    const resultFile = join(dir, 'result.json')
    const child = spawn(EXE, ['run', '--result', resultFile, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    const killer = setTimeout(() => {
      // launcher 自身悬挂（PoC 不允许）：杀掉并让断言失败
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }, opts.timeoutMs ?? 60_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(killer)
      try {
        const result: PocResult = existsSync(resultFile)
          ? (JSON.parse(readFileSync(resultFile, 'utf8')) as PocResult)
          : { ok: false, stage: 'result_file_missing' }
        resolve({ launcherExit: code, stdout: Buffer.concat(chunks).toString('utf8'), result })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
}

/** 进程命令行扫描（无孤儿断言用；等价 E2E findOrphan 思路） */
async function listCmdLines(): Promise<string[]> {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Select-Object -ExpandProperty CommandLine`
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )
  return (res.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** 断言带 marker 的测试子进程全部消失（预算内轮询） */
async function assertTreeGone(marker: string, budgetMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + budgetMs
  let remaining: string[] = []
  for (;;) {
    remaining = (await listCmdLines()).filter((l) => l.includes(marker))
    if (remaining.length === 0) return []
    if (Date.now() > deadline) return remaining
    await sleep(300)
  }
}

/** 杀进程（taskkill /F，强杀） */
function taskkill(pid: number): void {
  spawnSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore', timeout: 10_000 })
}

describe.skipIf(!enabled)('ccb-launcher PoC（Job Object 六项验证）', () => {
  // 1 + 5 合并冒烟：退出码透传 + stdout 直通 + 记账输出
  it('冒烟：CreateProcess→Assign→Resume→wait，退出码与记账透传', async () => {
    const run = await runPoc([
      '--timeout',
      '15000',
      '--',
      PY,
      '-c',
      'print("poc-hello"); import sys; sys.exit(7)'
    ])
    expect(run.result.ok).toBe(true)
    expect(run.launcherExit).toBe(0)
    expect(run.result.exitCode).toBe(7)
    expect(run.result.timedOut).toBe(false)
    expect(run.stdout).toContain('poc-hello')
    expect(Number(run.result.peakJobMemoryBytes)).toBeGreaterThan(0)
  })

  // 2. 命令行 quoting：空格/引号/反斜杠/中文 参数经 argv 完整往返
  it('argv quoting：空格/引号/反斜杠/中文逐字往返', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-poc-'))
    const echoFile = join(dir, 'argv.json')
    const script = join(dir, 'echo_args.py')
    writeFileSync(
      script,
      [
        'import sys, json',
        `open(r'${echoFile.replace(/\\/g, '\\\\')}', 'w', encoding='utf-8').write(json.dumps(sys.argv[1:], ensure_ascii=True))`
      ].join('\n'),
      'utf8'
    )
    const argv = [
      'plain',
      'has space',
      'quote"inside',
      'back\\slash',
      'trail\\',
      '中文参数',
      ''
    ]
    try {
      const run = await runPoc(['--timeout', '15000', '--', PY, script, ...argv])
      expect(run.result.ok).toBe(true)
      expect(run.result.exitCode).toBe(0)
      const got = JSON.parse(readFileSync(echoFile, 'utf8')) as string[]
      expect(got).toEqual(argv)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 3. 超时 → TerminateJobObject 整树终止（child + grandchild 无逃逸）
  it('timeout：死循环树（含孙进程）整树终止，无孤儿', async () => {
    const marker = `ccb-poc-chain-${Date.now()}`
    const dir = mkdtempSync(join(tmpdir(), 'ccb-poc-'))
    const chain = join(dir, 'chain.py')
    writeFileSync(
      chain,
      [
        'import subprocess, sys, time',
        'depth = int(sys.argv[1])',
        `marker = sys.argv[2]`,
        'if depth > 0:',
        `    subprocess.Popen([sys.executable, sys.argv[0], str(depth - 1), marker])`,
        'while True: time.sleep(1)'
      ].join('\n'),
      'utf8'
    )
    try {
      const run = await runPoc(['--timeout', '2500', '--', PY, chain, '2', marker])
      expect(run.result.ok).toBe(true)
      expect(run.result.timedOut).toBe(true)
      // launcher 自己的 timeout 兜底 60s 未触发（远大于 2.5s）
      expect(run.launcherExit).toBe(0)
      const remaining = await assertTreeGone(marker)
      expect(remaining, `遗留进程: ${remaining.join(' | ')}`).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 4. KILL_ON_JOB_CLOSE：launcher 被强杀 → Job 句柄关闭 → 整树（含孙）自动终止
  it('kill-on-job-close：强杀 launcher，子树自动清灭', async () => {
    const marker = `ccb-poc-kjc-${Date.now()}`
    const dir = mkdtempSync(join(tmpdir(), 'ccb-poc-'))
    const chain = join(dir, 'chain.py')
    writeFileSync(
      chain,
      [
        'import subprocess, sys, time',
        'depth = int(sys.argv[1])',
        `marker = sys.argv[2]`,
        'if depth > 0:',
        `    subprocess.Popen([sys.executable, sys.argv[0], str(depth - 1), marker])`,
        'while True: time.sleep(1)'
      ].join('\n'),
      'utf8'
    )
    const childPidFile = join(dir, 'pid.txt')
    const child: ChildProcess = spawn(
      EXE,
      ['run', '--result', join(dir, 'r.json'), '--childpid', childPidFile, '--timeout', '60000', '--', PY, chain, '2', marker],
      { stdio: 'ignore' }
    )
    try {
      // 等 childpid 文件出现（CreateProcess 已完成）
      const deadline = Date.now() + 10_000
      while (!existsSync(childPidFile) && Date.now() < deadline) await sleep(100)
      expect(existsSync(childPidFile), 'childpid 文件未生成').toBe(true)
      const childPid = Number(readFileSync(childPidFile, 'utf8').trim())
      expect(childPid).toBeGreaterThan(0)

      // 强杀 launcher（无清理路径，模拟崩溃/OOM）
      expect(child.pid).toBeDefined()
      taskkill(child.pid!)
      // Node spawn 句柄上的退出事件（PoC 进程已死）
      await new Promise<void>((resolve) => child.on('close', () => resolve()))

      // KILL_ON_JOB_CLOSE：整树必须自动消失，无需 Node 兜底
      const remaining = await assertTreeGone(marker, 15_000)
      expect(remaining, `强杀 launcher 后遗留: ${remaining.join(' | ')}`).toEqual([])
    } finally {
      if (child.exitCode === null && child.pid !== undefined) {
        try {
          taskkill(child.pid)
        } catch {
          // 已退出
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 5. ACTIVE_PROCESS_LIMIT：fork 炸弹被截断
  it('process limit：fork 炸弹成功 spawn 总数 ≤ 上限', async () => {
    const marker = `ccb-poc-bomb-${Date.now()}`
    const dir = mkdtempSync(join(tmpdir(), 'ccb-poc-'))
    const LIMIT = 8
    const bomb = join(dir, 'bomb.py')
    const countsDir = join(dir, 'counts')
    writeFileSync(
      bomb,
      [
        'import os, subprocess, sys, time',
        `marker = sys.argv[1]`,
        `counts_dir = sys.argv[2]`,
        'spawned = 0',
        'kids = []',
        'while True:',
        '    try:',
        `        p = subprocess.Popen([sys.executable, sys.argv[0], marker, counts_dir],`,
        '                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
        '        kids.append(p); spawned += 1',
        `        open(os.path.join(counts_dir, str(os.getpid())), 'w').write(str(spawned))`,
        '    except Exception:',
        '        time.sleep(0.2)  # 超限后等整树被终止'
      ].join('\n'),
      'utf8'
    )
    try {
      const run = await runPoc([
        '--processes',
        String(LIMIT),
        '--timeout',
        '4000',
        '--',
        PY,
        bomb,
        marker,
        countsDir
      ])
      expect(run.result.ok).toBe(true)
      expect(run.result.timedOut).toBe(true)
      // 统计整树成功 spawn 总数（每个进程独立计数文件，无共享竞争）
      let totalSpawned = 0
      if (existsSync(countsDir)) {
        for (const f of readdirSync(countsDir)) {
          totalSpawned += Number(readFileSync(join(countsDir, f), 'utf8').trim() || '0')
        }
      }
      expect(totalSpawned).toBeLessThanOrEqual(LIMIT - 1)
      const remaining = await assertTreeGone(marker)
      expect(remaining, `炸弹遗留: ${remaining.join(' | ')}`).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 6. PROCESS_MEMORY：分配超限被截断（MemoryError 干净退出 + 峰值佐证）
  it('memory limit：64MB 上限截断内存吞噬，进程干净终止', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-poc-'))
    const hog = join(dir, 'hog.py')
    writeFileSync(
      hog,
      [
        'import sys',
        'chunks = []',
        'try:',
        '    while True:',
        '        b = bytearray(8 * 1024 * 1024)  # 8MB',
        '        for i in range(0, len(b), 4096): b[i] = 1  # 触碰页面真实提交',
        '        chunks.append(b)',
        'except MemoryError:',
        '    sys.exit(42)'
      ].join('\n'),
      'utf8'
    )
    const LIMIT = 64 * 1024 * 1024
    try {
      const run = await runPoc(['--memory', String(LIMIT), '--timeout', '30000', '--', PY, hog])
      expect(run.result.ok).toBe(true)
      // 分配失败 → MemoryError → exit 42（限制生效的直接证据，而非系统 OOM）
      expect(run.result.exitCode).toBe(42)
      expect(run.result.timedOut).toBe(false)
      const peak = Number(run.result.peakProcessMemoryBytes)
      // 峰值逼近限制但未越过（失败的分配不提交）
      expect(peak).toBeGreaterThan(LIMIT * 0.5)
      expect(peak).toBeLessThanOrEqual(LIMIT * 1.2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
