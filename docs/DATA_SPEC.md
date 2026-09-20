# DATA_SPEC.md — 数据规格

所有 TS 类型定义于 `src/shared/types.ts`，本文件是权威说明。时间戳均为 Unix 毫秒整数（本地存储/展示按本地时区）。ID 为小写 UUID（`crypto.randomUUID()`）。

## 1. 领域类型

### 1.1 LanguageId

```ts
type LanguageId = 'c' | 'cpp' | 'python'
```

### 1.2 Difficulty

```ts
type Difficulty = 'easy' | 'medium' | 'hard'
```

### 1.3 JudgeStatus（判题状态）

```ts
type JudgeStatus =
  | 'accepted'              // 通过
  | 'wrong_answer'          // 答案错误
  | 'compile_error'         // 编译错误
  | 'runtime_error'         // 运行时错误（含非零退出、崩溃）
  | 'time_limit_exceeded'   // 超时
  | 'output_limit_exceeded' // 输出超限（扩展，见 ARCHITECTURE §5）
  | 'internal_error'        // 判题器内部错误（扩展）
```

### 1.4 Problem（题目，聚合根）

```ts
interface Problem {
  id: string
  title: string                      // 1-100 字符
  description: string                // Markdown，题面
  difficulty: Difficulty
  tags: string[]                     // 0-10 个，每个 1-20 字符
  inputDesc: string                  // 输入说明（Markdown）
  outputDesc: string                 // 输出说明（Markdown）
  samples: Sample[]                  // 1-3 个示例
  initialCode: Record<LanguageId, string>  // 各语言初始代码（可为空串）
  isBuiltin: boolean                 // 内置种子题
  createdAt: number
  updatedAt: number
}

interface Sample {
  input: string    // 展示用；与测试用例无关
  output: string
  note?: string
}
```

存储：`problems` 表，`tags`/`samples`/`initialCode` 序列化为 JSON 文本列。

### 1.5 TestCase（测试用例）

```ts
interface TestCase {
  id: string
  problemId: string
  stdin: string            // 可为空串（空输入）
  expectedStdout: string   // 期望 stdout（原始文本，判题时归一化）
  timeoutMs: number        // 100-60000，默认 5000
  order: number            // 用例执行顺序，0 起
}
```

约束：每题 1-50 个用例（判题上限，见 ARCHITECTURE §5.7）。
存储：独立 `test_cases` 表；作为 Problem 聚合的一部分整体读写（ADR D2）。

### 1.6 Submission（提交）与用例明细

```ts
interface Submission {
  id: string
  problemId: string
  language: LanguageId
  code: string                     // 提交时代码全文
  status: JudgeStatus              // 总体状态
  passedCount: number
  totalCount: number
  durationMs: number               // 所有用例累计运行耗时（不含编译）
  createdAt: number
}

interface TestCaseResult {
  testCaseId: string
  order: number
  stdin: string
  expected: string
  actual: string | null            // 编译失败/未运行时为 null
  stderr: string
  status: JudgeStatus
  exitCode: number | null          // signal 终止时为 null
  durationMs: number
}
```

### 1.7 ExecutionResult（Runner 单次执行结果）

```ts
interface ExecutionResult {
  status: 'ok' | 'timeout' | 'output_limit' | 'spawn_error'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string                   // UTF-8 解码、超限截断
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  timedOut: boolean
}
```

### 1.8 ErrorRecord（错误记录）

```ts
interface ErrorRecord {
  id: string
  submissionId: string
  problemId: string
  language: LanguageId
  errorType: JudgeStatus           // 失败类型（非 accepted 的状态）
  message: string                  // 摘要：编译错误取 stderr 首个有效行 / RE 取 stderr 摘要 / WA/TLE 固定描述，≤500 字符
  createdAt: number
}
```

### 1.9 Toolchain（工具链探测结果）

```ts
interface Toolchain {
  id: string                       // 如 'gcc:C:\mingw64\bin\gcc.exe'（id:路径）
  languageIds: LanguageId[]        // gcc→['c']，g++→['cpp']，python→['python']
  kind: 'gcc-c' | 'gcc-cpp' | 'clang-c' | 'clang-cpp' | 'msvc-c' | 'msvc-cpp' | 'python'
  program: string                  // 可执行文件绝对路径（MSVC 为 cl.exe 路径）
  version: string                  // 版本描述，如 'gcc (w64devkit) 15.1.0'
  source: 'path' | 'vswhere' | 'manual'  // manual=用户在设置中手工指定
  env?: Record<string, string>     // MSVC 专用：vcvars 解析出的环境变量
}
```

### 1.10 MistakeBookEntry（错题聚合，派生表）

```ts
interface MistakeBookEntry {
  problemId: string
  failedCount: number              // 非 accepted 提交次数
  firstFailedAt: number
  lastFailedAt: number
  lastErrorType: JudgeStatus
  errorTypeCounts: Record<JudgeStatus, number>  // JSON 列
  mastered: boolean                // 用户标记
  masteredAt: number | null
}
```

错题列表定义：`failedCount >= 2 且 mastered = false`（FR-M2/M3）。每次提交后按 submissions 全量重算该题条目（`mastered`/`masteredAt` 保留用户值）。

### 1.11 DashboardStats（聚合只读）

```ts
interface DashboardStats {
  totalProblemsAttempted: number   // 有提交的题目数
  totalProblemsInBank: number      // 题库总题数
  acceptedProblems: number         // 有过 AC 的题目数
  accuracy: number                 // AC 提交数 / 总提交数，0-1，无提交时为 0
  totalSubmissions: number
  todaySubmissions: number         // 本地时区自然日
  streakDays: number               // 含今天/昨天的连续有提交天数，无提交为 0
  languageCounts: Record<LanguageId, number>
  errorTypeCounts: { type: JudgeStatus; count: number }[]  // Top 5
  recentSubmissions: Submission[]  // 最近 10 条（含题目标题）
}
```

### 1.12 AppSettings

```ts
interface AppSettings {
  fontSize: number                 // 12-28，默认 14
  tabSize: number                  // 2|4|8，默认 4
  wordWrap: boolean                // 默认 false
  manualToolchains: Partial<Record<LanguageId, string>>  // 手工指定的工具链路径
  judgeTimeoutDefaultMs: number    // 新用例默认超时，1000-60000，默认 5000
}
```

## 2. SQLite Schema

```sql
-- schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)

-- v1
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON
  input_desc TEXT NOT NULL DEFAULT '',
  output_desc TEXT NOT NULL DEFAULT '',
  samples TEXT NOT NULL DEFAULT '[]',       -- JSON
  initial_code TEXT NOT NULL DEFAULT '{}',  -- JSON
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_problems_updated ON problems(updated_at DESC);

CREATE TABLE test_cases (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  stdin TEXT NOT NULL DEFAULT '',
  expected_stdout TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 60000),
  "order" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_testcases_problem ON test_cases(problem_id, "order");

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('c','cpp','python')),
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  passed_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_submissions_problem ON submissions(problem_id, created_at DESC);
CREATE INDEX idx_submissions_created ON submissions(created_at DESC);

CREATE TABLE test_case_results (
  id TEXT PRIMARY KEY,                       -- = submission_id + ':' + test_case_id
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  test_case_id TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  stdin TEXT NOT NULL,
  expected TEXT NOT NULL,
  actual TEXT,
  stderr TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX idx_tcr_submission ON test_case_results(submission_id);

CREATE TABLE error_records (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_errors_problem ON error_records(problem_id, created_at DESC);

CREATE TABLE mistake_book (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER,
  last_failed_at INTEGER,
  last_error_type TEXT,
  error_type_counts TEXT NOT NULL DEFAULT '{}',  -- JSON
  mastered INTEGER NOT NULL DEFAULT 0,
  mastered_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL      -- JSON 编码
);
```

迁移机制：`db/migrations.ts` 内有序迁移数组（version + SQL），启动时在事务内补齐未应用版本，写入 `schema_migrations`。

## 3. JSON 导入/导出格式（题库交换）

```jsonc
{
  "format": "cuincodebench.problems",
  "version": 1,
  "exportedAt": 1730000000000,
  "problems": [ /* ProblemInput[]，结构与 §1.4 一致（无 id/isBuiltin/时间戳，导入时生成） */ ]
}
```

- 导入校验：zod schema（`problemInputSchema`），不合法时报出全部错误路径；导入的题目一律新建 id、`isBuiltin=false`。
- 导出：单题或全部题目，包裹为上述信封格式。

## 4. 种子题库（resources/seed-problems.json）

≥8 题：A+B、两数之和（数组版）、判断回文、FizzBuzz、字符串反转、最大公约数、冒泡排序、统计元音字母等；覆盖 easy/medium/hard、每题 3-6 个用例（含边界/空输入/较大输入）、三语言初始代码模板。首次启动（problems 表为空）时灌入，`isBuiltin=1`。
