import { describe, expect, it } from 'vitest'
import { normalizeOutput, decideCaseStatus } from '../src/main/judge/normalize'
import type { ExecutionResult } from '../src/shared/types'

/**
 * 判题核心单测（TEST_PLAN §1.1/§1.2，FR-J4）：归一化 + 状态判定。
 */

function exec(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    status: 'ok',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 10,
    timedOut: false,
    ...overrides
  }
}

describe('normalizeOutput', () => {
  it('CRLF 归一', () => {
    expect(normalizeOutput('1\r\n2\r\n')).toBe('1\n2')
  })

  it('孤立 CR 归一', () => {
    expect(normalizeOutput('a\rb')).toBe('a\nb')
  })

  it('行尾空白去除', () => {
    expect(normalizeOutput('1 \t\n2')).toBe('1\n2')
  })

  it('末尾换行与空行差异忽略', () => {
    expect(normalizeOutput('1\n2')).toBe(normalizeOutput('1\n2\n\n\n'))
  })

  it('行首空格敏感（保留）', () => {
    expect(normalizeOutput(' 1')).not.toBe(normalizeOutput('1'))
  })

  it('中间空行敏感（保留）', () => {
    expect(normalizeOutput('1\n\n2')).not.toBe(normalizeOutput('1\n2'))
  })

  it('完全相同与空输出', () => {
    expect(normalizeOutput('')).toBe('')
    expect(normalizeOutput('')).toBe(normalizeOutput('\n'))
    expect(normalizeOutput('abc')).toBe(normalizeOutput('abc'))
  })

  it('多行大文本稳定', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}  `)
    const a = lines.join('\n')
    const b = lines.map((l) => l.trimEnd()).join('\r\n') + '\n'
    expect(normalizeOutput(a)).toBe(normalizeOutput(b))
  })
})

describe('decideCaseStatus', () => {
  it('AC：输出一致', () => {
    expect(decideCaseStatus(exec({ stdout: '3\n' }), '3')).toBe('accepted')
  })

  it('WA：输出不同', () => {
    expect(decideCaseStatus(exec({ stdout: '4' }), '3')).toBe('wrong_answer')
  })

  it('RE：非零退出', () => {
    expect(
      decideCaseStatus(exec({ exitCode: 1, stdout: 'x' }), 'x')
    ).toBe('runtime_error')
  })

  it('Windows 崩溃码（3221225477 = 0xC0000005）→ RE', () => {
    expect(decideCaseStatus(exec({ exitCode: 3221225477 }), '')).toBe('runtime_error')
  })

  it('TLE：timedOut', () => {
    expect(
      decideCaseStatus(exec({ timedOut: true, status: 'timeout', exitCode: null }), '')
    ).toBe('time_limit_exceeded')
  })

  it('OLE：输出超限', () => {
    expect(
      decideCaseStatus(exec({ status: 'output_limit', stdoutTruncated: true }), '')
    ).toBe('output_limit_exceeded')
  })

  it('spawn 失败 → internal_error', () => {
    expect(decideCaseStatus(exec({ status: 'spawn_error', exitCode: null }), '')).toBe(
      'internal_error'
    )
  })

  it('顺序性：WA 优先于后续 TLE 的状态独立判定', () => {
    // 每个用例独立判定，总体顺序由 judge-service 的 firstFail 决定（集成层验证）
    expect(decideCaseStatus(exec({ stdout: 'a' }), 'b')).toBe('wrong_answer')
    expect(decideCaseStatus(exec({ timedOut: true, status: 'timeout' }), 'b')).toBe(
      'time_limit_exceeded'
    )
  })
})
