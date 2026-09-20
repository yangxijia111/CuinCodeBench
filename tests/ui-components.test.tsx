// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { JudgeResultPanel } from '../src/renderer/src/components/JudgeResultPanel'
import { RunResultPanel } from '../src/renderer/src/components/RunResultPanel'
import type { JudgeResult, TestCaseResult } from '../src/shared/types'
import type { RunOnceResult } from '../src/shared/ipc'

afterEach(() => {
  cleanup()
})

/**
 * UI 组件测试（TEST_PLAN §3）：判题/运行结果面板的渲染分支。
 */

function makeCase(overrides: Partial<TestCaseResult> = {}): TestCaseResult {
  return {
    testCaseId: 'tc1',
    order: 0,
    stdin: '1 2',
    expected: '3',
    actual: '3',
    stderr: '',
    status: 'accepted',
    exitCode: 0,
    durationMs: 12,
    ...overrides
  }
}

function makeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    submissionId: 'sub1',
    status: 'accepted',
    passedCount: 2,
    totalCount: 2,
    durationMs: 30,
    compile: null,
    cases: [makeCase(), makeCase({ testCaseId: 'tc2', order: 1 })],
    problemStats: { problemId: 'p', attempts: 1, acceptedCount: 1, firstAcceptedAt: 1, lastAttemptAt: 1 },
    ...overrides
  }
}

describe('JudgeResultPanel', () => {
  it('AC：显示通过状态与统计', () => {
    render(<JudgeResultPanel result={makeResult()} />)
    expect(screen.getAllByText('通过').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/2\/2/)).toBeTruthy()
  })

  it('WA：失败用例默认展开并显示期望/实际', () => {
    const r = makeResult({
      status: 'wrong_answer',
      passedCount: 1,
      cases: [makeCase({ status: 'wrong_answer', actual: '4' })]
    })
    render(<JudgeResultPanel result={r} />)
    expect(screen.getAllByText('答案错误').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('实际输出').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(1)
  })

  it('CE：展示编译器输出且无用例列表', () => {
    const r = makeResult({
      status: 'compile_error',
      passedCount: 0,
      totalCount: 2,
      compile: { ok: false, stderr: "error: expected ';' before '}'", exitCode: 1, timedOut: false, durationMs: 200 },
      cases: []
    })
    render(<JudgeResultPanel result={r} />)
    expect(screen.getAllByText('编译错误').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/error: expected/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/用例 #1/)).toBeNull()
  })

  it('RE：展示崩溃码十六进制', () => {
    const r = makeResult({
      status: 'runtime_error',
      passedCount: 0,
      cases: [makeCase({ status: 'runtime_error', exitCode: 3221225477, actual: '' })]
    })
    render(<JudgeResultPanel result={r} />)
    expect(screen.getByText(/0xC0000005/)).toBeTruthy()
  })

  it('TLE：状态标签正确', () => {
    const r = makeResult({ status: 'time_limit_exceeded', cases: [makeCase({ status: 'time_limit_exceeded' })] })
    render(<JudgeResultPanel result={r} />)
    expect(screen.getAllByText('超出时限').length).toBeGreaterThanOrEqual(1)
  })
})

describe('RunResultPanel', () => {
  it('正常输出渲染', () => {
    const r: RunOnceResult = {
      compile: null,
      execution: {
        status: 'ok',
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 90
      }
    }
    render(<RunResultPanel result={r} />)
    expect(screen.getByText('正常结束')).toBeTruthy()
    expect(screen.getByText(/hello/)).toBeTruthy()
  })

  it('无工具链时显示友好错误', () => {
    const r: RunOnceResult = {
      compile: null,
      execution: null,
      error: { code: 'no_toolchain', message: '未检测到可用的 C 编译器。' }
    }
    render(<RunResultPanel result={r} />)
    expect(screen.getByText(/未检测到可用的 C 编译器/)).toBeTruthy()
  })

  it('TLE 与 OLE 标注', () => {
    const r: RunOnceResult = {
      compile: null,
      execution: {
        status: 'output_limit',
        exitCode: null,
        stdout: 'x'.repeat(100),
        stderr: '',
        stdoutTruncated: true,
        stderrTruncated: false,
        durationMs: 500
      }
    }
    render(<RunResultPanel result={r} />)
    expect(screen.getByText(/输出超限/)).toBeTruthy()
    expect(screen.getAllByText(/已截断/).length).toBeGreaterThanOrEqual(1)
  })
})
