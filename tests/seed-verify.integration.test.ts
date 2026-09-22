import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { execute } from '../src/main/runner/execute'
import { withTempDir } from '../src/main/runner/temp-dir'
import { detectAllToolchains } from '../src/main/runner/detect'
import { buildRunPlan, selectToolchain } from '../src/main/runner/languages'
import { normalizeOutput } from '../src/main/judge/normalize'
import { compileSource, writeSourceFile } from '../src/main/runner/compile'
import { problemInputSchema } from '../src/shared/schemas'
import type { ProblemInput, Toolchain } from '../src/shared/types'

/**
 * 种子题库验证（docs/V1_2_ROADMAP.md P9）：
 * 每道内置题的参考解在真实工具链（gcc / python）上编译运行，逐用例比对期望输出。
 * 未安装工具链的机器自动跳过（不计失败）——与 runner 集成测试同语义。
 */

const projectRoot = resolve(__dirname, '..')
const portableGccDir = join(projectRoot, '.tools', 'w64devkit', 'bin')
if (existsSync(portableGccDir)) {
  process.env['PATH'] = `${portableGccDir};${process.env['PATH'] ?? ''}`
}

const allDetected = await detectAllToolchains()
const gccToolchain: Toolchain | null = selectToolchain(allDetected, 'c')
const pythonToolchain: Toolchain | null = selectToolchain(allDetected, 'python')

const seedFile = join(projectRoot, 'resources', 'seed-problems.json')
const rawProblems = (JSON.parse(readFileSync(seedFile, 'utf-8')) as {
  problems: Array<{ referenceSolution?: ProblemInput['initialCode'] } & Record<string, unknown>>
}).problems
// schema 校验失败会让整个文件显式失败（种子质量是硬性要求）
const seeds: { input: ProblemInput; ref: ProblemInput['initialCode'] }[] = rawProblems.map((p, i) => {
  const r = problemInputSchema.safeParse(p)
  if (!r.success) {
    const issues = r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')
    throw new Error(`种子题 #${i} 结构不合法：${issues}`)
  }
  return {
    input: r.data,
    // v1.1 老题的 initialCode 是学生骨架（含 TODO）；referenceSolution 才是验证基准
    ref: p.referenceSolution ?? r.data.initialCode
  }
})

/** 用真实工具链完整跑一次参考解（写源码→编译→运行），返回原始 stdout 与失败描述 */
async function runRef(
  toolchain: Toolchain,
  code: string,
  stdin: string
): Promise<{ actual: string; failed: string | null }> {
  return withTempDir(async (dir) => {
    await writeSourceFile(toolchain, dir, code)
    const compile = await compileSource(toolchain, dir)
    if (!compile.ok) {
      return { actual: '', failed: `编译失败：${compile.stderr.slice(0, 300)}` }
    }
    const plan = buildRunPlan(toolchain, dir)
    const execution = await execute({
      program: plan.run.program,
      args: plan.run.args ?? [],
      cwd: dir,
      stdin,
      timeoutMs: 10_000,
      env: plan.run.env
    })
    if (execution.status === 'timeout') return { actual: '', failed: '超出时限' }
    if (execution.status !== 'ok') {
      return { actual: execution.stdout, failed: `运行失败（${execution.status}）：${execution.stderr.slice(0, 300)}` }
    }
    return { actual: execution.stdout, failed: null }
  })
}

/** 逐用例验证参考解输出与期望一致（judge 同款归一化） */
async function expectRefPasses(toolchain: Toolchain, code: string, p: ProblemInput): Promise<void> {
  for (const [ci, tc] of p.testCases.entries()) {
    const r = await runRef(toolchain, code, tc.stdin)
    const message = `#${p.title} 用例 ${ci + 1}（stdin: ${JSON.stringify(tc.stdin)}）${r.failed !== null ? ` ${r.failed}` : ''}`
    expect(r.failed, message).toBeNull()
    expect(normalizeOutput(r.actual), message).toBe(normalizeOutput(tc.expectedStdout))
  }
}

describe.skipIf(gccToolchain === null)('种子题 C 参考解验证（真实 gcc）', () => {
  for (const [i, p] of seeds.entries()) {
    it(`#${i + 1} ${p.input.title}`, async () => {
      expect(gccToolchain).not.toBeNull()
      await expectRefPasses(gccToolchain as Toolchain, p.ref.c, p.input)
    }, 30_000)
  }
})

describe.skipIf(pythonToolchain === null)('种子题 Python 参考解验证（真实 python）', () => {
  for (const [i, p] of seeds.entries()) {
    const code = p.ref.python
    it(`#${i + 1} ${p.input.title}`, async () => {
      if (code.trim() === '') throw new Error('缺少 python 参考解')
      expect(pythonToolchain).not.toBeNull()
      await expectRefPasses(pythonToolchain as Toolchain, code, p.input)
    }, 30_000)
  }
})

describe('种子题库结构', () => {
  it('至少 30 道、标题唯一、均为 C 基础难度分布', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(30)
    const titles = seeds.map((p) => p.input.title)
    expect(new Set(titles).size).toBe(titles.length)
    // 45 题中 easy/medium 为主（C 基础定位），hard 只允许少数
    const hard = seeds.filter((p) => p.input.difficulty === 'hard').length
    expect(hard).toBeLessThanOrEqual(5)
  })

  it('内置学习路线的显式映射全部指向存在的题目与知识点', () => {
    const map = JSON.parse(
      readFileSync(join(projectRoot, 'resources', 'seed-learning-path.json'), 'utf-8')
    ) as { path: { slug: string }; stages: { knowledgePoints: { name: string }[] }[]; builtinProblemMap: Record<string, string[]> }
    const titles = new Set(seeds.map((p) => p.input.title))
    const kpNames = new Set(map.stages.flatMap((s) => s.knowledgePoints.map((k) => k.name)))
    expect(map.path.slug).toBe('c-basics')
    for (const [title, kps] of Object.entries(map.builtinProblemMap)) {
      expect(titles.has(title), `映射的题目不存在: ${title}`).toBe(true)
      for (const kp of kps) {
        expect(kpNames.has(kp), `题目 ${title} 映射到不存在的知识点: ${kp}`).toBe(true)
      }
    }
  })
})
