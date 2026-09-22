/**
 * IPC 契约：通道名与 API 类型。
 * 主进程 ipc/ 与 preload 依此实现；renderer 经 window.api 调用。
 * 统一返回 IpcResult，成功携带 data，失败携带错误码与消息（ARCHITECTURE §6）。
 */

import type {
  AppSettings,
  DashboardStats,
  DashboardV2Stats,
  Difficulty,
  ErrorCategory,
  JudgeResult,
  JudgeStatus,
  KnowledgePoint,
  LanguageId,
  MasteryInfo,
  MistakeBookEntry,
  MistakeHistoryEntry,
  MistakeNote,
  PracticeSession,
  ReviewItem,
  Problem,
  ProblemDetail,
  ProblemInput,
  ProblemQuery,
  ProblemStats,
  PathProgress,
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

  // 练习会话（v1.2）
  createRandomSession(
    config: {
      difficulty?: Difficulty | 'all'
      language?: LanguageId | 'all'
      tag?: string
      knowledgePointId?: string
      scope?: 'all' | 'unsolved' | 'mistakes' | 'weak'
      size?: number
    }
  ): Promise<IpcResult<PracticeSession>>
  createKpSession(kpId: string, size: number): Promise<IpcResult<PracticeSession>>
  getSession(id: string): Promise<IpcResult<PracticeSession>>
  getSessionSummary(
    id: string
  ): Promise<IpcResult<{ total: number; answered: number; accepted: number; firstAccepted: number }>>
  finishSession(id: string): Promise<IpcResult<void>>

  // 错题复盘（v1.2）
  getMistakeHistory(problemId: string): Promise<IpcResult<MistakeHistoryEntry[]>>
  getMistakeFirstLatestCode(problemId: string): Promise<IpcResult<{ firstCode: string | null; latestCode: string | null }>>
  getMistakeNote(problemId: string): Promise<IpcResult<MistakeNote | null>>
  setMistakeNote(problemId: string, note: string): Promise<IpcResult<MistakeNote>>
  setMistakeCategory(problemId: string, category: ErrorCategory): Promise<IpcResult<void>>
  getMistakeLatestCategory(problemId: string): Promise<IpcResult<ErrorCategory | null>>

  // 统计
  getDashboardStats(): Promise<IpcResult<DashboardStats>>
  getDashboardV2Stats(): Promise<IpcResult<DashboardV2Stats>>

  // 设置
  getSettings(): Promise<IpcResult<AppSettings>>
  updateSettings(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>

  // 学习路线（v1.2）
  listLearningPaths(): Promise<IpcResult<PathProgress[]>>
  getLearningPathDetail(pathId: string): Promise<IpcResult<PathProgress>>
  listAllKnowledgePoints(): Promise<IpcResult<KnowledgePoint[]>>
  listKpProblems(
    kpId: string
  ): Promise<IpcResult<{ id: string; title: string; difficulty: string; accepted: boolean; attempts: number }[]>>
  getProblemKnowledgePoints(problemId: string): Promise<IpcResult<KnowledgePoint[]>>
  bindProblemKnowledgePoints(problemId: string, kpIds: string[]): Promise<IpcResult<void>>
  unbindProblemKnowledgePoint(problemId: string, kpId: string): Promise<IpcResult<void>>

  // 掌握度（v1.2）
  listMastery(): Promise<IpcResult<MasteryInfo[]>>
  recalcMastery(): Promise<IpcResult<void>>

  // 间隔复习（v1.2）
  getReviewToday(): Promise<
    IpcResult<{
      dueCount: number
      items: ReviewItem[]
      byKnowledgePoint: { name: string; count: number }[]
    }>
  >
  startReviewSession(
    size: number
  ): Promise<IpcResult<{ session: PracticeSession | null; created: boolean }>>
  getReviewSession(id: string): Promise<IpcResult<PracticeSession>>
  getLatestActiveReviewSession(): Promise<IpcResult<PracticeSession | null>>
  finishReviewSession(
    sessionId: string,
    grades: Record<string, 'again' | 'hard' | 'good' | 'easy'>
  ): Promise<IpcResult<{ sessionId: string; graded: number; nextReviewAt: Record<string, number> }>>
  cancelReviewSession(id: string): Promise<IpcResult<void>>

  // 备份与恢复（路径由主进程 dialog 决定，renderer 不传路径）
  exportBackup(): Promise<
    IpcResult<
      | { canceled: true }
      | {
          canceled: false
          path: string
          counts: Record<string, number>
        }
    >
  >
  importBackupPreview(): Promise<
    IpcResult<
      | { canceled: true }
      | {
          canceled: false
          fileName: string
          summary: {
            createdAt: number
            appVersion: string | null
            counts: {
              problems: number
              submissions: number
              errorRecords: number
              mistakeBook: number
              mistakeNotes: number
              knowledgePoints: number
              mastery: number
              reviewItems: number
              reviewHistory: number
              practiceSessions: number
            }
          }
        }
    >
  >
  confirmBackupRestore(): Promise<IpcResult<{ counts: Record<string, number> }>>
  cancelBackupImport(): Promise<IpcResult<void>>
}

/** 用于 UI 分组的难度元数据 */
export const DIFFICULTY_META: Record<Difficulty, { label: string; color: string }> = {
  easy: { label: '简单', color: '#3fb950' },
  medium: { label: '中等', color: '#d29922' },
  hard: { label: '困难', color: '#f85149' }
}

export type { JudgeStatus }
