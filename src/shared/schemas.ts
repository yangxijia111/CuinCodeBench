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

export const problemInputSchema: z.ZodType<ProblemInput> = z.object({
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
  }),
  testCases: z
    .array(testCaseInputSchema)
    .min(1, '至少需要 1 个测试用例')
    .max(MAX_TEST_CASES_PER_PROBLEM, `测试用例最多 ${MAX_TEST_CASES_PER_PROBLEM} 个`)
})

export const problemQuerySchema = z.object({
  keyword: z.string().max(100),
  difficulty: z.enum(['easy', 'medium', 'hard', 'all']),
  tag: z.string().max(20)
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
