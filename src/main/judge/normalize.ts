import type { ExecutionResult, JudgeStatus } from '@shared/types'

/**
 * 判题核心纯函数（ARCHITECTURE §5，FR-J4）：
 * - normalizeOutput：CRLF/LF 归一、行尾空白、末尾空行
 * - decideCaseStatus：单用例状态判定
 * 全部无副作用，可独立单测。
 */

/**
 * 输出归一化：
 * 1. \r\n → \n，孤立 \r → \n
 * 2. 去除每行行尾空白（空格/Tab）
 * 3. 去除末尾全部空行
 * 保留行首空白与中间空行。
 */
export function normalizeOutput(raw: string): string {
  const unified = raw.replace(/\r\n?/g, '\n')
  const lines = unified.split('\n').map((line) => line.replace(/[ \t]+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.join('\n')
}

/** 判定单个用例状态（按 ARCHITECTURE §5.4 顺序） */
export function decideCaseStatus(execution: ExecutionResult, expectedStdout: string): JudgeStatus {
  if (execution.status === 'output_limit') return 'output_limit_exceeded'
  if (execution.timedOut || execution.status === 'timeout') return 'time_limit_exceeded'
  if (execution.status === 'spawn_error') return 'internal_error'
  if (execution.exitCode !== 0) return 'runtime_error'
  return normalizeOutput(execution.stdout) === normalizeOutput(expectedStdout)
    ? 'accepted'
    : 'wrong_answer'
}
