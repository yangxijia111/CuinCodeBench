import type {
  CompileOutcome,
  ExecutionResult,
  JudgeResult,
  LanguageId,
  TestCase,
  TestCaseResult
} from '@shared/types'
import type { RunOnceResult } from '@shared/ipc'
import { AppError } from '../lib/app-error'
import { buildRunPlan } from '../runner/languages'
import { withTempDir } from '../runner/temp-dir'
import { compileSource, writeSourceFile } from '../runner/compile'
import { execute } from '../runner/execute'
import { decideCaseStatus } from '../judge/normalize'
import type { ToolchainService } from './toolchain-service'
import type { ServiceContext } from './index'
import { logger } from '../lib/logger'

/**
 * 判题与运行服务（ARCHITECTURE §3/§5）：
 * - 串行队列：同一时刻仅一个编译/运行任务（ADR D3）
 * - submit：判题并落库（提交/明细/错误记录/错题聚合）
 * - runOnce：自定义运行（不落库）
 */

export class JudgeService {
  /** 串行队列尾指针 */
  private queueTail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly toolchains: ToolchainService,
    private readonly services: () => ServiceContext
  ) {}

  /** 入队串行执行 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task)
    this.queueTail = run.catch(() => {})
    return run
  }

  /** 自定义运行（FR-C1）：不判题、不落库 */
  runOnce(input: { language: LanguageId; code: string; stdin: string; timeoutMs: number }): Promise<RunOnceResult> {
    return this.enqueue(() => this.doRunOnce(input))
  }

  private async doRunOnce(input: {
    language: LanguageId
    code: string
    stdin: string
    timeoutMs: number
  }): Promise<RunOnceResult> {
    const toolchain = await this.toolchains.select(input.language)
    if (toolchain === null) {
      return { compile: null, execution: null, error: noToolchainError(input.language) }
    }
    return withTempDir(async (dir) => {
      await writeSourceFile(toolchain, dir, input.code)
      const plan = buildRunPlan(toolchain, dir)

      let compile: CompileOutcome | null = null
      if (plan.compile !== null) {
        const report = await compileSource(toolchain, dir)
        compile = {
          ok: report.ok,
          stderr: report.stderr,
          exitCode: report.exitCode,
          timedOut: report.timedOut,
          durationMs: report.durationMs
        }
        if (!report.ok) return { compile, execution: null }
      }

      const result = await execute({
        program: plan.run.program,
        args: plan.run.args ?? [],
        cwd: dir,
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
        env: plan.run.env
      })
      return {
        compile,
        execution: {
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          durationMs: result.durationMs
        }
      }
    })
  }

  /** 判题提交（FR-J1–J6）：编译一次 → 顺序跑全部用例 → 落库 → 错题聚合 */
  submit(problemId: string, language: LanguageId, code: string): Promise<JudgeResult> {
    return this.enqueue(() => this.doSubmit(problemId, language, code))
  }

  private async doSubmit(problemId: string, language: LanguageId, code: string): Promise<JudgeResult> {
    const svc = this.services()
    const problem = svc.problems.get(problemId)
    if (problem === null) throw new AppError('not_found', `题目不存在: ${problemId}`)
    if (problem.testCases.length === 0) {
      throw new AppError('internal', '该题目没有测试用例，无法判题')
    }

    const toolchain = await this.toolchains.select(language)
    if (toolchain === null) {
      throw new AppError(
        'no_toolchain',
        noToolchainError(language).message ?? '未检测到可用的编译器/解释器'
      )
    }

    return withTempDir(async (dir) => {
      await writeSourceFile(toolchain, dir, code)
      const plan = buildRunPlan(toolchain, dir)

      // 1) 编译（compiled 语言）
      let compile: CompileOutcome | null = null
      if (plan.compile !== null) {
        const report = await compileSource(toolchain, dir)
        compile = {
          ok: report.ok,
          stderr: report.stderr,
          exitCode: report.exitCode,
          timedOut: report.timedOut,
          durationMs: report.durationMs
        }
        if (!report.ok) {
          return this.persist(problemId, language, code, 'compile_error', 0, problem.testCases.length, 0, compile, [])
        }
      }

      // 2) 顺序执行全部用例（失败不中断，FR-J5）
      const results: TestCaseResult[] = []
      let totalDuration = 0
      for (const tc of problem.testCases) {
        const execution = await execute({
          program: plan.run.program,
          args: plan.run.args ?? [],
          cwd: dir,
          stdin: tc.stdin,
          timeoutMs: tc.timeoutMs,
          env: plan.run.env
        })
        totalDuration += execution.durationMs
        results.push(toCaseResult(tc, execution))
      }

      // 3) 总体状态：第一个非 AC 用例的状态；全 AC → accepted
      const firstFail = results.find((r) => r.status !== 'accepted')
      const overall: JudgeResult['status'] = firstFail?.status ?? 'accepted'
      const passed = results.filter((r) => r.status === 'accepted').length

      return this.persist(
        problemId,
        language,
        code,
        overall,
        passed,
        problem.testCases.length,
        totalDuration,
        compile,
        results
      )
    })
  }

  /** 落库：提交 + 明细 + 错误记录 + 错题聚合 + 每题统计回传 */
  private persist(
    problemId: string,
    language: LanguageId,
    code: string,
    status: JudgeResult['status'],
    passedCount: number,
    totalCount: number,
    durationMs: number,
    compile: CompileOutcome | null,
    results: TestCaseResult[]
  ): JudgeResult {
    const svc = this.services()
    const submissionId = svc.history.insertSubmission(
      { problemId, language, code, status, passedCount, totalCount, durationMs },
      results.map((r) => ({
        testCaseId: r.testCaseId,
        order: r.order,
        stdin: r.stdin,
        expected: r.expected,
        actual: r.actual,
        stderr: r.stderr,
        status: r.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs
      }))
    )

    if (status !== 'accepted') {
      svc.history.insertErrorRecord({
        submissionId,
        problemId,
        language,
        errorType: status,
        message: summarizeError(status, compile, results)
      })
    }
    svc.mistakes.recompute(problemId)
    // v1.2：知识点掌握度重算（该题关联的全部知识点；物化缓存，幂等）
    try {
      svc.masterySvc.recalcForProblem(problemId, Date.now())
    } catch (err) {
      // 掌握度是派生缓存，重算失败不阻断判题结果（日志留痕，可手动 recalc 修复）
      logger.warn('掌握度重算失败（可手动重算）', err instanceof Error ? err.message : String(err))
    }

    return {
      submissionId,
      status,
      passedCount,
      totalCount,
      durationMs,
      compile,
      cases: results,
      problemStats: svc.history.getProblemStats(problemId)
    }
  }
}

/** 单用例执行结果 → 判定（ARCHITECTURE §5.4） */
function toCaseResult(tc: TestCase, execution: ExecutionResult): TestCaseResult {
  const status = decideCaseStatus(execution, tc.expectedStdout)
  return {
    testCaseId: tc.id,
    order: tc.order,
    stdin: tc.stdin,
    expected: tc.expectedStdout,
    actual: execution.status === 'spawn_error' ? null : execution.stdout,
    stderr: execution.stderr,
    status,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs
  }
}

/** 无工具链的友好提示（FR-R9） */
export function noToolchainError(language: LanguageId): { code: string; message: string } {
  const names: Record<LanguageId, string> = {
    c: 'C 编译器（gcc / clang / MSVC cl.exe）',
    cpp: 'C++ 编译器（g++ / clang++ / MSVC cl.exe）',
    python: 'Python 解释器（python / py）'
  }
  return {
    code: 'no_toolchain',
    message: `未检测到可用的${names[language]}。请安装后将其加入 PATH，或在「设置」中手工指定工具链路径，然后点击「重新检测」。`
  }
}

/** 错误摘要（≤500 字符，FR-M1 / DATA_SPEC §1.8） */
function summarizeError(
  status: JudgeResult['status'],
  compile: CompileOutcome | null,
  results: TestCaseResult[]
): string {
  if (status === 'compile_error' && compile !== null) {
    const firstMeaningful =
      compile.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== '') ?? '编译失败'
    return firstMeaningful.slice(0, 500)
  }
  const failed = results.find((r) => r.status !== 'accepted')
  if (failed !== undefined && failed.stderr.trim() !== '') {
    return failed.stderr.trim().slice(0, 500)
  }
  const labels: Record<string, string> = {
    wrong_answer: `答案错误（通过 ${results.filter((r) => r.status === 'accepted').length}/${results.length}）`,
    runtime_error: '运行时错误',
    time_limit_exceeded: '超出时限',
    output_limit_exceeded: '输出超限',
    internal_error: '判题器内部错误'
  }
  return labels[status] ?? status
}
