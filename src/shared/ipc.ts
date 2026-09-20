/**
 * IPC 契约：通道名与 API 类型。
 * 主进程 ipc/ 与 preload 依此实现；renderer 经 window.api 调用。
 * 统一返回 IpcResult，成功携带 data，失败携带错误码与消息（ARCHITECTURE §6）。
 */

import type {
  AppSettings,
  DashboardStats,
  Difficulty,
  JudgeResult,
  JudgeStatus,
  LanguageId,
  MistakeBookEntry,
  Problem,
  ProblemDetail,
  ProblemInput,
  ProblemQuery,
  ProblemStats,
  Submission,
  SubmissionQuery,
  TestCaseResult,
  Toolchain
} from './types'

/** IPC 统一返回信封 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

export interface RunOnceInput {
  language: LanguageId
  code: string
  stdin: string
  timeoutMs: number
}

/** 自定义运行（不判题、不落库） */
export interface RunOnceResult {
  compile: { ok: boolean; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number } | null
  execution: {
    status: 'ok' | 'timeout' | 'output_limit' | 'spawn_error'
    exitCode: number | null
    stdout: string
    stderr: string
    stdoutTruncated: boolean
    stderrTruncated: boolean
    durationMs: number
  } | null
  /** 无可用工具链等前置错误 */
  error?: { code: string; message: string }
}

export interface SubmissionDetail extends Submission {
  problemTitle: string
  results: TestCaseResult[]
}

export interface AppApi {
  // 应用信息
  getAppInfo(): Promise<IpcResult<{ version: string; dataDir: string }>>

  // 题库
  listProblems(query: ProblemQuery): Promise<IpcResult<Problem[]>>
  getProblem(id: string): Promise<IpcResult<ProblemDetail | null>>
  createProblem(input: ProblemInput): Promise<IpcResult<ProblemDetail>>
  updateProblem(id: string, input: ProblemInput): Promise<IpcResult<ProblemDetail>>
  deleteProblem(id: string): Promise<IpcResult<void>>
  listTags(): Promise<IpcResult<string[]>>
  exportProblems(problemIds: string[] | null): Promise<IpcResult<string>>
  importProblems(jsonText: string): Promise<IpcResult<{ imported: number }>>

  // 工具链
  detectToolchains(force: boolean): Promise<IpcResult<Toolchain[]>>

  // 运行与判题
  runOnce(input: RunOnceInput): Promise<IpcResult<RunOnceResult>>
  judgeSubmit(problemId: string, language: LanguageId, code: string): Promise<IpcResult<JudgeResult>>

  // 历史记录
  listSubmissions(query: SubmissionQuery): Promise<IpcResult<(Submission & { problemTitle: string })[]>>
  getSubmissionDetail(id: string): Promise<IpcResult<SubmissionDetail | null>>
  getProblemStats(problemId: string): Promise<IpcResult<ProblemStats>>

  // 错题本
  listMistakes(): Promise<IpcResult<MistakeBookEntry[]>>
  setMistakeMastered(problemId: string, mastered: boolean): Promise<IpcResult<void>>

  // 统计
  getDashboardStats(): Promise<IpcResult<DashboardStats>>

  // 设置
  getSettings(): Promise<IpcResult<AppSettings>>
  updateSettings(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
}

/** 用于 UI 分组的难度元数据 */
export const DIFFICULTY_META: Record<Difficulty, { label: string; color: string }> = {
  easy: { label: '简单', color: '#3fb950' },
  medium: { label: '中等', color: '#d29922' },
  hard: { label: '困难', color: '#f85149' }
}

export type { JudgeStatus }
