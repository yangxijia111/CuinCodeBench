/**
 * 共享领域类型（权威定义见 docs/DATA_SPEC.md）。
 * 该文件被 main / preload / renderer 三端共同引用，只允许类型与纯常量。
 */

export type LanguageId = 'c' | 'cpp' | 'python'

export type Difficulty = 'easy' | 'medium' | 'hard'

export type JudgeStatus =
  | 'accepted'
  | 'wrong_answer'
  | 'compile_error'
  | 'runtime_error'
  | 'time_limit_exceeded'
  | 'output_limit_exceeded'
  | 'internal_error'

/** 判题状态展示信息（UI 用） */
export const JUDGE_STATUS_META: Record<JudgeStatus, { label: string; color: string }> = {
  accepted: { label: '通过', color: '#3fb950' },
  wrong_answer: { label: '答案错误', color: '#f85149' },
  compile_error: { label: '编译错误', color: '#d29922' },
  runtime_error: { label: '运行时错误', color: '#f85149' },
  time_limit_exceeded: { label: '超出时限', color: '#a371f7' },
  output_limit_exceeded: { label: '输出超限', color: '#a371f7' },
  internal_error: { label: '内部错误', color: '#8b949e' }
}

export interface Sample {
  input: string
  output: string
  note?: string
}

export interface Problem {
  id: string
  title: string
  description: string
  difficulty: Difficulty
  tags: string[]
  inputDesc: string
  outputDesc: string
  samples: Sample[]
  initialCode: Record<LanguageId, string>
  isBuiltin: boolean
  createdAt: number
  updatedAt: number
}

/** 新建/编辑题目时的输入（无服务端生成字段） */
export interface ProblemInput {
  title: string
  description: string
  difficulty: Difficulty
  tags: string[]
  inputDesc: string
  outputDesc: string
  samples: Sample[]
  initialCode: Record<LanguageId, string>
  testCases: TestCaseInput[]
}

/** 题目详情 = 题目 + 全部测试用例（聚合根视图， ProblemWithCases 的共享别名） */
export interface ProblemDetail extends Problem {
  testCases: TestCase[]
}

export interface TestCaseInput {
  stdin: string
  expectedStdout: string
  timeoutMs: number
}

export interface TestCase {
  id: string
  problemId: string
  stdin: string
  expectedStdout: string
  timeoutMs: number
  order: number
}

export interface TestCaseInput {
  stdin: string
  expectedStdout: string
  timeoutMs: number
}

export interface Submission {
  id: string
  problemId: string
  language: LanguageId
  code: string
  status: JudgeStatus
  passedCount: number
  totalCount: number
  durationMs: number
  createdAt: number
}

export interface TestCaseResult {
  testCaseId: string
  order: number
  stdin: string
  expected: string
  actual: string | null
  stderr: string
  status: JudgeStatus
  exitCode: number | null
  durationMs: number
}

/** 判题整体结果（一次提交） */
export interface JudgeResult {
  submissionId: string
  status: JudgeStatus
  passedCount: number
  totalCount: number
  durationMs: number
  compile: CompileOutcome | null
  cases: TestCaseResult[]
  /** 每题统计（尝试次数/首过时间）提交后回传，便于 UI 即时刷新 */
  problemStats: ProblemStats
}

export interface CompileOutcome {
  ok: boolean
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

/** Runner 单次执行结果（Runner 模块边界类型，无 DB 概念） */
export interface ExecutionResult {
  status: 'ok' | 'timeout' | 'output_limit' | 'spawn_error'
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  timedOut: boolean
}

export interface ProblemStats {
  problemId: string
  attempts: number
  acceptedCount: number
  firstAcceptedAt: number | null
  lastAttemptAt: number | null
}

export interface ErrorRecord {
  id: string
  submissionId: string
  problemId: string
  language: LanguageId
  errorType: JudgeStatus
  message: string
  createdAt: number
}

export interface Toolchain {
  id: string
  languageIds: LanguageId[]
  kind:
    | 'gcc-c'
    | 'gcc-cpp'
    | 'clang-c'
    | 'clang-cpp'
    | 'msvc-c'
    | 'msvc-cpp'
    | 'python'
  program: string
  version: string
  source: 'path' | 'vswhere' | 'manual'
  /** MSVC 专用：vcvars64 解析出的环境变量 */
  env?: Record<string, string>
}

export interface MistakeBookEntry {
  problemId: string
  problemTitle: string
  failedCount: number
  firstFailedAt: number
  lastFailedAt: number
  lastErrorType: JudgeStatus
  errorTypeCounts: { type: JudgeStatus; count: number }[]
  mastered: boolean
  masteredAt: number | null
}

export interface DashboardStats {
  totalProblemsAttempted: number
  totalProblemsInBank: number
  acceptedProblems: number
  accuracy: number
  totalSubmissions: number
  todaySubmissions: number
  streakDays: number
  languageCounts: Record<LanguageId, number>
  errorTypeCounts: { type: JudgeStatus; count: number }[]
  recentSubmissions: (Submission & { problemTitle: string })[]
}

export interface AppSettings {
  fontSize: number
  tabSize: number
  wordWrap: boolean
  manualToolchains: Partial<Record<LanguageId, string>>
  judgeTimeoutDefaultMs: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  manualToolchains: {},
  judgeTimeoutDefaultMs: 5_000
}

/** 题目列表查询条件（'all' 表示不筛选） */
export interface ProblemQuery {
  keyword: string
  difficulty: Difficulty | 'all'
  tag: string
}

/** 提交历史查询 */
export interface SubmissionQuery {
  problemId?: string
  limit: number
  offset: number
}
