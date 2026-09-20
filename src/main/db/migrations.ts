/**
 * SQLite 迁移定义：有序数组，version 单调递增。
 * 启动时在事务内补齐未应用版本（幂等），写入 schema_migrations。
 * 权威 schema 见 docs/DATA_SPEC.md §2。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  tags TEXT NOT NULL DEFAULT '[]',
  input_desc TEXT NOT NULL DEFAULT '',
  output_desc TEXT NOT NULL DEFAULT '',
  samples TEXT NOT NULL DEFAULT '[]',
  initial_code TEXT NOT NULL DEFAULT '{}',
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
  id TEXT PRIMARY KEY,
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
  error_type_counts TEXT NOT NULL DEFAULT '{}',
  mastered INTEGER NOT NULL DEFAULT 0,
  mastered_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  }
]
