import { z } from 'zod'
import {
  MAX_TEST_CASES_PER_PROBLEM,
  TESTCASE_TIMEOUT_MAX_MS,
  TESTCASE_TIMEOUT_MIN_MS
} from './constants'
import type { ProblemInput } from './types'

/**
 * zod 校验 schema：IPC 入参与 JSON 导入共用（FR-P5 / ARCHITECTURE §6）。
 */

export const languageIdSchema = z.enum(['c', 'cpp', 'python'])

export const difficultySchema = z.enum(['easy', 'medium', 'hard'])

export const sampleSchema = z.object({
  input: z.string().max(10_000),
  output: z.string().max(10_000),
  note: z.string().max(2_000).optional()
})

export const testCaseInputSchema = z.object({
  stdin: z.string().max(100_000),
  expectedStdout: z.string().max(100_000),
  timeoutMs: z
    .number()
    .int()
    .min(TESTCASE_TIMEOUT_MIN_MS)
    .max(TESTCASE_TIMEOUT_MAX_MS)
})

/** 题目公共字段（problemInputSchema 与备份 schema 共用，支持 extend） */
const problemBaseSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(100, '标题最长 100 字符'),
  description: z.string().max(50_000),
  difficulty: difficultySchema,
  tags: z.array(z.string().trim().min(1).max(20)).max(10, '标签最多 10 个'),
  inputDesc: z.string().max(20_000),
  outputDesc: z.string().max(20_000),
  samples: z.array(sampleSchema).min(0).max(3),
  initialCode: z.object({
    c: z.string().max(100_000),
    cpp: z.string().max(100_000),
    python: z.string().max(100_000)
  })
})

export const problemInputSchema: z.ZodType<ProblemInput> = problemBaseSchema.extend({
  testCases: z
    .array(testCaseInputSchema)
    .min(1, '至少需要 1 个测试用例')
    .max(MAX_TEST_CASES_PER_PROBLEM, `测试用例最多 ${MAX_TEST_CASES_PER_PROBLEM} 个`)
})

export const problemQuerySchema = z.object({
  keyword: z.string().max(100),
  difficulty: z.enum(['easy', 'medium', 'hard', 'all']),
  tag: z.string().max(20),
  knowledgePointId: z.string().max(100).optional()
})

export const submissionQuerySchema = z.object({
  problemId: z.string().optional(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0)
})

export const runOnceInputSchema = z.object({
  language: languageIdSchema,
  code: z.string().min(1, '代码不能为空').max(100_000),
  stdin: z.string().max(1_000_000),
  timeoutMs: z.number().int().min(TESTCASE_TIMEOUT_MIN_MS).max(TESTCASE_TIMEOUT_MAX_MS)
})

export const judgeSubmitSchema = z.tuple([
  z.string().min(1),
  languageIdSchema,
  z.string().min(1).max(100_000)
])

export const appSettingsPatchSchema = z
  .object({
    fontSize: z.number().int().min(12).max(28).optional(),
    tabSize: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional(),
    wordWrap: z.boolean().optional(),
    manualToolchains: z
      .object({
        c: z.string().optional(),
        cpp: z.string().optional(),
        python: z.string().optional()
      })
      .optional(),
    judgeTimeoutDefaultMs: z.number().int().min(1000).max(60000).optional()
  })
  .strict()

/** 导出信封格式（docs/DATA_SPEC.md §3） */
export const problemImportEnvelopeSchema = z.object({
  format: z.literal('cuincodebench.problems'),
  version: z.literal(1),
  exportedAt: z.number().optional(),
  problems: z.array(problemInputSchema).min(1)
})

// ============================================================
// 完整备份格式（docs/V1_2_BACKUP_SPEC.md）：versioned + 全量 zod 校验
// ============================================================

/** 当前支持的备份格式版本；恢复端拒绝更大版本 */
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_FORMAT_NAME = 'cuincodebench.backup'

const backupTestCaseSchema = testCaseInputSchema.extend({ id: z.string().min(1).max(100) })

export const backupProblemSchema = problemBaseSchema.extend({
  id: z.string().min(1).max(100),
  isBuiltin: z.boolean(),
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
  testCases: z.array(backupTestCaseSchema).max(MAX_TEST_CASES_PER_PROBLEM)
})

export const backupCaseResultSchema = z.object({
  testCaseId: z.string().max(200),
  order: z.number().int().min(0),
  stdin: z.string().max(1_000_000),
  expected: z.string().max(1_000_000),
  actual: z.string().max(1_000_000).nullable(),
  stderr: z.string().max(1_000_000),
  status: z.string().max(40),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  /** v1.3 native launcher 终止原因；v1 备份缺失该字段 → null 语义（可选） */
  terminationReason: z.string().max(40).nullable().optional()
})

export const backupSubmissionSchema = z.object({
  id: z.string().min(1).max(100),
  problemId: z.string().min(1).max(100),
  language: languageIdSchema,
  code: z.string().max(1_000_000),
  status: z.string().max(40),
  passedCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  createdAt: z.number().int().min(0),
  results: z.array(backupCaseResultSchema).max(MAX_TEST_CASES_PER_PROBLEM)
})

export const backupErrorRecordSchema = z.object({
  id: z.string().min(1).max(100),
  submissionId: z.string().min(1).max(100),
  problemId: z.string().min(1).max(100),
  language: languageIdSchema,
  errorType: z.string().max(40),
  message: z.string().max(100_000),
  createdAt: z.number().int().min(0),
  learningCategory: z.string().max(30).nullable(),
  categorySource: z.enum(['auto', 'manual']).nullable()
})

export const backupMistakeBookSchema = z.object({
  problemId: z.string().min(1).max(100),
  failedCount: z.number().int().min(0),
  firstFailedAt: z.number().int().min(0).nullable(),
  lastFailedAt: z.number().int().min(0).nullable(),
  lastErrorType: z.string().max(40).nullable(),
  errorTypeCounts: z.record(z.string().max(40), z.number().int().min(0)),
  mastered: z.boolean(),
  masteredAt: z.number().int().min(0).nullable()
})

export const backupMasterySchema = z.object({
  knowledgePointId: z.string().min(1).max(100),
  score: z.number().int().min(0).max(100),
  status: z.enum(['not_started', 'learning', 'weak', 'familiar', 'mastered']),
  updatedAt: z.number().int().min(0)
})

export const backupReviewItemSchema = z.object({
  id: z.string().min(1).max(100),
  targetType: z.enum(['knowledge_point', 'problem']),
  targetId: z.string().min(1).max(100),
  lastReviewedAt: z.number().int().min(0).nullable(),
  nextReviewAt: z.number().int().min(0),
  reviewCount: z.number().int().min(0),
  successStreak: z.number().int().min(0).max(5),
  failureCount: z.number().int().min(0),
  intervalDays: z.number().int().min(0),
  createdAt: z.number().int().min(0)
})

export const backupReviewHistorySchema = z.object({
  id: z.string().min(1).max(100),
  reviewItemId: z.string().min(1).max(100),
  result: z.enum(['again', 'hard', 'good', 'easy']),
  reviewedAt: z.number().int().min(0),
  submissionId: z.string().max(100).nullable()
})

export const backupKnowledgePointSchema = z.object({
  id: z.string().min(1).max(100),
  stageId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(2_000),
  sortOrder: z.number().int().min(0),
  tags: z.array(z.string().max(30)).max(20)
})

export const backupLearningPathSchema = z.object({
  id: z.string().min(1).max(100),
  slug: z.string().min(1).max(50),
  title: z.string().min(1).max(100),
  description: z.string().max(2_000),
  isBuiltin: z.boolean(),
  sortOrder: z.number().int().min(0),
  stages: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        pathId: z.string().min(1).max(100),
        title: z.string().min(1).max(100),
        description: z.string().max(2_000),
        sortOrder: z.number().int().min(0),
        knowledgePoints: z.array(backupKnowledgePointSchema).max(200)
      })
    )
    .max(100)
})

export const backupMistakeNoteSchema = z.object({
  problemId: z.string().min(1).max(100),
  note: z.string().max(100_000),
  updatedAt: z.number().int().min(0)
})

const backupSessionItemSchema = z.object({
  id: z.string().min(1).max(100),
  problemId: z.string().min(1).max(100),
  sortOrder: z.number().int().min(0),
  status: z.enum(['pending', 'accepted', 'failed', 'skipped']),
  attempts: z.number().int().min(0),
  firstAcceptedSubmissionId: z.string().max(100).nullable(),
  firstResultAt: z.number().int().min(0).nullable()
})

/** v1.2.1 起导出；optional 保证 v1 备份（无此表数据）可导入 */
export const backupReviewSessionResultSchema = z.object({
  sessionId: z.string().min(1).max(100),
  reviewItemId: z.string().min(1).max(100),
  grade: z.enum(['again', 'hard', 'good', 'easy']),
  submissionId: z.string().max(100).nullable(),
  gradedAt: z.number().int().min(0)
})

export const backupPracticeSessionSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['random', 'knowledge_point', 'review', 'mistake']),
  knowledgePointId: z.string().max(100).nullable(),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(['active', 'finished']),
  total: z.number().int().min(0),
  createdAt: z.number().int().min(0),
  finishedAt: z.number().int().min(0).nullable(),
  items: z.array(backupSessionItemSchema).max(1000)
})

export const backupDataSchema = z.object({
  settings: z.record(z.string().max(100), z.string().max(1_000_000)),
  learningPaths: z.array(backupLearningPathSchema).max(100),
  problems: z.array(backupProblemSchema).max(50_000),
  problemKnowledge: z
    .array(
      z.object({ problemId: z.string().max(100), knowledgePointId: z.string().max(100) })
    )
    .max(500_000),
  submissions: z.array(backupSubmissionSchema).max(1_000_000),
  errorRecords: z.array(backupErrorRecordSchema).max(1_000_000),
  mistakeBook: z.array(backupMistakeBookSchema).max(50_000),
  mistakeNotes: z.array(backupMistakeNoteSchema).max(50_000),
  mastery: z.array(backupMasterySchema).max(10_000),
  reviewItems: z.array(backupReviewItemSchema).max(500_000),
  reviewHistory: z.array(backupReviewHistorySchema).max(1_000_000),
  /** v1.2.1 会话评分 exactly-once 记录（v1 备份缺失该字段 → 空数组语义） */
  reviewSessionResults: z.array(backupReviewSessionResultSchema).max(500_000).optional(),
  practiceSessions: z.array(backupPracticeSessionSchema).max(100_000)
})

export const backupEnvelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT_NAME),
  version: z.number().int().min(1),
  createdAt: z.number().int().min(0),
  appVersion: z.string().max(30).optional(),
  data: backupDataSchema
})

/** 备份文件文本（IPC 入参约束：≤512MB） */
export const backupJsonTextSchema = z.string().min(1).max(512 * 1024 * 1024)

/** 随机练习过滤器（docs/V1_2_ROADMAP.md P7） */
export const randomSessionConfigSchema = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
  language: z.enum(['c', 'cpp', 'python', 'all']).optional(),
  tag: z.string().max(20).optional(),
  knowledgePointId: z.string().max(100).optional(),
  scope: z.enum(['all', 'unsolved', 'mistakes', 'weak']).optional(),
  size: z.number().int().min(1).max(50).optional()
})

export type BackupEnvelope = z.output<typeof backupEnvelopeSchema>
export type BackupData = z.output<typeof backupDataSchema>
