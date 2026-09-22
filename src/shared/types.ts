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

// ============================================================
// v1.2 学习体验领域类型（权威定义见 docs/V1_2_LEARNING_MODEL.md）
// ============================================================

/** 知识点掌握状态（规则见 docs/V1_2_MASTERY_SPEC.md） */
export type MasteryStatus = 'not_started' | 'learning' | 'weak' | 'familiar' | 'mastered'

export const MASTERY_STATUS_META: Record<MasteryStatus, { label: string; color: string }> = {
  not_started: { label: '未开始', color: '#6e7681' },
  learning: { label: '学习中', color: '#58a6ff' },
  weak: { label: '薄弱', color: '#f85149' },
  familiar: { label: '熟悉', color: '#d29922' },
  mastered: { label: '已掌握', color: '#3fb950' }
}

/** 间隔复习评分等级（docs/V1_2_REVIEW_SPEC.md） */
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

export const REVIEW_GRADE_META: Record<ReviewGrade, { label: string }> = {
  again: { label: '重学' },
  hard: { label: '困难' },
  good: { label: '掌握' },
  easy: { label: '简单' }
}

/** 学习错误分类（明确规则自动判定 + 手动修正；与判题状态分离） */
export const ERROR_CATEGORIES = [
  'syntax',
  'condition',
  'loop',
  'array_boundary',
  'pointer',
  'input_output',
  'algorithm',
  'off_by_one',
  'memory',
  'other',
  'unknown'
] as const

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

export const ERROR_CATEGORY_META: Record<ErrorCategory, { label: string }> = {
  syntax: { label: '语法' },
  condition: { label: '条件判断' },
  loop: { label: '循环' },
  array_boundary: { label: '数组越界' },
  pointer: { label: '指针' },
  input_output: { label: '输入输出' },
  algorithm: { label: '算法效率' },
  off_by_one: { label: '差一错误' },
  memory: { label: '内存' },
  other: { label: '其他' },
  unknown: { label: '未分类' }
}

/** 学习路线（内置路径 slug 见 resources/seed-learning-path.json） */
export interface LearningPath {
  id: string
  slug: string
  title: string
  description: string
  isBuiltin: boolean
  sortOrder: number
}

export interface LearningStage {
  id: string
  pathId: string
  title: string
  description: string
  sortOrder: number
}

export interface KnowledgePoint {
  id: string
  stageId: string
  name: string
  description: string
  sortOrder: number
  tags: string[]
}

/** 掌握度物化快照（可全量重算） */
export interface MasteryInfo {
  knowledgePointId: string
  score: number
  status: MasteryStatus
  updatedAt: number
}

/** 知识点进度（路线页展示模型：绑定题目数 + 已通过 + 掌握度） */
export interface KnowledgePointProgress {
  knowledgePoint: KnowledgePoint
  totalProblems: number
  acceptedProblems: number
  mastery: MasteryInfo | null
}

export interface StageProgress extends LearningStage {
  knowledgePoints: KnowledgePointProgress[]
  totalProblems: number
  acceptedProblems: number
}

export interface PathProgress extends LearningPath {
  stages: StageProgress[]
  totalProblems: number
  acceptedProblems: number
}

/** 复习调度项（review_items 行） */
export interface ReviewItem {
  id: string
  targetType: 'knowledge_point' | 'problem'
  targetId: string
  lastReviewedAt: number | null
  nextReviewAt: number
  reviewCount: number
  successStreak: number
  failureCount: number
  intervalDays: number
  createdAt: number
}

export interface ReviewHistoryEntry {
  id: string
  reviewItemId: string
  result: ReviewGrade
  reviewedAt: number
  submissionId: string | null
}

/** 错题笔记（1:1 题目） */
export interface MistakeNote {
  problemId: string
  note: string
  updatedAt: number
}

/** 错题复盘：错误历史条目（从 submissions + error_records 派生） */
export interface MistakeHistoryEntry {
  submissionId: string
  status: JudgeStatus
  language: LanguageId
  code: string
  message: string
  learningCategory: ErrorCategory | null
  categorySource: 'auto' | 'manual' | null
  createdAt: number
}

/** 练习队列 */
export type PracticeSessionKind = 'random' | 'knowledge_point' | 'review' | 'mistake'
export type PracticeSessionItemStatus = 'pending' | 'accepted' | 'failed' | 'skipped'

export interface PracticeSessionItem {
  id: string
  sessionId: string
  problemId: string
  sortOrder: number
  status: PracticeSessionItemStatus
  attempts: number
  firstAcceptedSubmissionId: string | null
  firstResultAt: number | null
}

export interface PracticeSession {
  id: string
  kind: PracticeSessionKind
  knowledgePointId: string | null
  config: Record<string, unknown>
  status: 'active' | 'finished'
  total: number
  createdAt: number
  finishedAt: number | null
  items: PracticeSessionItem[]
}

/** 随机练习过滤器（config 的结构化定义） */
export interface RandomSessionConfig {
  difficulty: Difficulty | 'all'
  language: LanguageId | 'all'
  tag: string
  knowledgePointId: string
  scope: 'all' | 'unsolved' | 'mistakes' | 'weak'
  size: number
}

/** 趋势数据点（Dashboard 2.0） */
export interface TrendPoint {
  day: string
  submissions: number
  accepted: number
  reviews: number
}

/** 知识点掌握热力图条目 */
export interface MasteryHeatmapEntry {
  knowledgePointId: string
  name: string
  score: number
  status: MasteryStatus
}

/** Dashboard 2.0 统计（v1.1 指标 + 学习指标与趋势） */
export interface DashboardV2Stats extends DashboardStats {
  /** 今日已完成的复习评分次数 */
  todayReviews: number
  /** 当前到期的复习项数 */
  dueReviewCount: number
  /** 错题本待复习数（未掌握） */
  mistakeDueCount: number
  /** 全部知识点掌握度（含未开始的 0 分项） */
  masteryList: MasteryHeatmapEntry[]
  /** 最近 7 天 / 30 天趋势（按本地日历日，最旧在前） */
  trend7: TrendPoint[]
  trend30: TrendPoint[]
}

