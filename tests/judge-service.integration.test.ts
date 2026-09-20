import { describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { openDatabase } from '../src/main/db/connection'
import { initServices } from '../src/main/services'
import { ToolchainService } from '../src/main/services/toolchain-service'
import { JudgeService } from '../src/main/services/judge-service'
import { detectAllToolchains } from '../src/main/runner/detect'
import { selectToolchain } from '../src/main/runner/languages'
import { makeProblemInput } from './helpers'
import type { Toolchain } from '../src/shared/types'

/**
 * 判题服务端到端集成（TEST_PLAN §1.5 + §2，FR-J1–J6 + FR-M1）：
 * 真实工具链 → JudgeService.submit → 结果与落库断言。
 * 无任何编译器/解释器的机器上：python 用例跳过（node 桩已在 Runner 集成覆盖管线）。
 */

const portableGccDir = join(resolve(__dirname, '..'), '.tools', 'w64devkit', 'bin')
if (existsSync(portableGccDir)) {
  process.env['PATH'] = `${portableGccDir};${process.env['PATH'] ?? ''}`
}

// 顶层探测（skipIf 求值需要）
const detected = await detectAllToolchains()
const python: Toolchain | null = selectToolchain(detected, 'python')
const cCompiler: Toolchain | null = selectToolchain(detected, 'c')

function setup() {
  const db = openDatabase({ file: ':memory:' })
  const services = initServices(db)
  const toolchains = new ToolchainService(() => services.settings.get().manualToolchains)
  const judge = new JudgeService(toolchains, () => services)
  return { services, judge }
}

/** A+B 题目（与种子题一致的对齐输入格式） */
function makeAddProblem() {
  return makeProblemInput()
}

describe.skipIf(python === null)('JudgeService 端到端（Python）', () => {
  it('AC：正确代码通过全部用例并落库', async () => {
    const { services, judge } = setup()
    const problem = services.problems.create(makeAddProblem())

    const result = await judge.submit(problem.id, 'python', 'a, b = map(int, input().split())\nprint(a + b)')
    expect(result.status).toBe('accepted')
    expect(result.passedCount).toBe(result.totalCount)
    expect(result.cases.every((c) => c.status === 'accepted')).toBe(true)
    expect(result.problemStats.attempts).toBe(1)
    expect(result.problemStats.firstAcceptedAt).not.toBeNull()

    // 落库验证
    const detail = services.history.getById(result.submissionId)
    expect(detail?.submission.status).toBe('accepted')
    expect(detail?.results).toHaveLength(3)
    // AC 不产生错误记录；错题本无该题
    expect(services.mistakes.listUnmastered()).toHaveLength(0)
  })

  it('WA：错误输出被识别且错题聚合更新', async () => {
    const { services, judge } = setup()
    const problem = services.problems.create(makeAddProblem())

    const r1 = await judge.submit(problem.id, 'python', 'a, b = map(int, input().split())\nprint(a - b)')
    expect(r1.status).toBe('wrong_answer')
    const r2 = await judge.submit(problem.id, 'python', 'a, b = map(int, input().split())\nprint(a * b)')
    expect(r2.status).toBe('wrong_answer')

    // WA 用例展示 expected/actual
    expect(r1.cases[0]?.expected).toBe('3')
    expect(r1.cases[0]?.actual).not.toBe('3')

    const mistakes = services.mistakes.listUnmastered()
    expect(mistakes).toHaveLength(1)
    expect(mistakes[0]?.failedCount).toBe(2)
  })

  it('RE：异常代码 → runtime_error 且错误记录生成', async () => {
    const { services, judge } = setup()
    const problem = services.problems.create(makeAddProblem())
    const r1 = await judge.submit(problem.id, 'python', 'raise SystemExit(1)')
    expect(r1.status).toBe('runtime_error')
    const r2 = await judge.submit(problem.id, 'python', 'raise SystemExit(2)')
    const mistakes = services.mistakes.listUnmastered()
    expect(mistakes[0]?.failedCount).toBeGreaterThanOrEqual(2)
    void r2
  })

  it('TLE：死循环 → time_limit_exceeded', async () => {
    const { services, judge } = setup()
    const problem = services.problems.create(
      makeProblemInput({
        testCases: [{ stdin: '1 2', expectedStdout: '3', timeoutMs: 1_500 }]
      })
    )
    const r = await judge.submit(problem.id, 'python', 'while True:\n    pass')
    expect(r.status).toBe('time_limit_exceeded')
  })

  it('串行队列：并发 submit 依序完成且互不污染', async () => {
    const { services, judge } = setup()
    const p1 = services.problems.create(makeAddProblem())
    const p2 = services.problems.create(makeProblemInput({ title: '第二题' }))
    const [r1, r2] = await Promise.all([
      judge.submit(p1.id, 'python', 'a, b = map(int, input().split())\nprint(a + b)'),
      judge.submit(p2.id, 'python', 'print("x")\nprint("x")\nprint("x")')
    ])
    expect(r1.status).toBe('accepted')
    expect(r2.status).toBe('wrong_answer')
    expect(r2.passedCount).toBe(0)
  })
})

describe.skipIf(cCompiler === null)('JudgeService 端到端（C）', () => {
  it('AC + WA：C 代码判题与落库', async () => {
    const { services, judge } = setup()
    const problem = services.problems.create(makeAddProblem())

    const ac = await judge.submit(
      problem.id,
      'c',
      '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}'
    )
    expect(ac.status).toBe('accepted')

    const wa = await judge.submit(
      problem.id,
      'c',
      '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a-b);return 0;}'
    )
    expect(wa.status).toBe('wrong_answer')
  })

  it('CE：编译错误直接短路全部用例', async () => {
    const { services, judge } = setup()
    const problem = services.problems.create(makeAddProblem())
    const r = await judge.submit(problem.id, 'c', 'int main( { broken')
    expect(r.status).toBe('compile_error')
    expect(r.compile?.ok).toBe(false)
    expect(r.compile?.stderr.length).toBeGreaterThan(0)
    expect(r.cases).toHaveLength(0)
    expect(r.passedCount).toBe(0)
  })
})

// 无工具链机器：验证友好错误（FR-R9）
describe('无工具链场景', () => {
  it('select 为空时 submit 抛领域错误', async () => {
    const db = openDatabase({ file: ':memory:' })
    const s = initServices(db)
    const stubToolchains = new ToolchainService(() => s.settings.get().manualToolchains)
    const emptyJudge = new JudgeService(stubToolchains, () => s)
    // 仅当本机确实无 python 时才能走到该分支；否则跳过语义
    const hasToolchain = await stubToolchains.select('python')
    if (hasToolchain !== null) return
    const problem = s.problems.create(makeAddProblem())
    await expect(emptyJudge.submit(problem.id, 'python', 'print(1)')).rejects.toThrow()
  })
})
