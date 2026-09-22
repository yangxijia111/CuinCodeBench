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
  },
  {
    // v1.2 学习体验：路线/知识点/掌握度/复习/错题笔记/练习队列（docs/V1_2_LEARNING_MODEL.md §2）
    // 只增不删：v1.1 表与数据原样保留；v1.1 代码打开本库不受影响。
    version: 2,
    name: 'learning-v1.2',
    sql: `
CREATE TABLE learning_paths (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE learning_stages (
  id TEXT PRIMARY KEY,
  path_id TEXT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_stages_path ON learning_stages(path_id, sort_order);

CREATE TABLE knowledge_points (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES learning_stages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_kp_stage ON knowledge_points(stage_id, sort_order);

CREATE TABLE problem_knowledge_points (
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  PRIMARY KEY (problem_id, knowledge_point_id)
);
CREATE INDEX idx_pkk_kp ON problem_knowledge_points(knowledge_point_id);

CREATE TABLE mastery (
  knowledge_point_id TEXT PRIMARY KEY REFERENCES knowledge_points(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','learning','weak','familiar','mastered')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('knowledge_point','problem')),
  target_id TEXT NOT NULL,
  last_reviewed_at INTEGER,
  next_review_at INTEGER NOT NULL,
  review_count INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (target_type, target_id)
);
CREATE INDEX idx_review_due ON review_items(next_review_at);

CREATE TABLE review_history (
  id TEXT PRIMARY KEY,
  review_item_id TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('again','hard','good','easy')),
  reviewed_at INTEGER NOT NULL,
  submission_id TEXT
);
CREATE INDEX idx_rh_item ON review_history(review_item_id, reviewed_at DESC);

CREATE TABLE mistake_notes (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE practice_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('random','knowledge_point','review','mistake')),
  knowledge_point_id TEXT REFERENCES knowledge_points(id) ON DELETE SET NULL,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE practice_session_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_accepted_submission_id TEXT,
  first_result_at INTEGER
);
CREATE INDEX idx_psi_session ON practice_session_items(session_id, sort_order);

ALTER TABLE error_records ADD COLUMN learning_category TEXT;
ALTER TABLE error_records ADD COLUMN category_source TEXT;

-- 孤儿数据兜底清理（幂等；正常情况下外键级联已覆盖，防御异常历史数据）
DELETE FROM review_items WHERE target_type='problem' AND target_id NOT IN (SELECT id FROM problems);
DELETE FROM review_items WHERE target_type='knowledge_point' AND target_id NOT IN (SELECT id FROM knowledge_points);
DELETE FROM practice_session_items WHERE problem_id NOT IN (SELECT id FROM problems);
DELETE FROM mastery WHERE knowledge_point_id NOT IN (SELECT id FROM knowledge_points);
`
  },
  {
    // v1.2.1 深度审计修复（docs/V1_2_1_DEEP_AUDIT.md P0-C/P0-D）：
    // 1) review_session_results：会话评分 exactly-once 记录（同一会话同一复习项至多一次有效评分）；
    // 2) 触发器：problems / knowledge_points 删除时清理多态引用的 review_items（DB 层防线）；
    // 3) review_history.submission_id / practice_session_items.first_accepted_submission_id
    //    重建为 ON DELETE SET NULL（SQLite 不支持 ALTER COLUMN，复制法重建；悬挂引用先置 NULL）；
    // 4) 历史孤儿兜底清理（幂等）。
    // 注：内置内容稳定语义 ID 重写（P1）不在静态 SQL 中——它依赖 seed 文件内容，
    //    由 learning-seed 的 migrateBuiltinContentIds 在启动步骤内以单事务执行。
    version: 3,
    name: 'review-exactly-once-and-integrity-v1.2.1',
    sql: `
CREATE TABLE review_session_results (
  session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  review_item_id TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  submission_id TEXT,
  graded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, review_item_id)
);

CREATE TRIGGER IF NOT EXISTS trg_problems_delete_review_cleanup
AFTER DELETE ON problems BEGIN
  DELETE FROM review_items WHERE target_type = 'problem' AND target_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_kp_delete_review_cleanup
AFTER DELETE ON knowledge_points BEGIN
  DELETE FROM review_items WHERE target_type = 'knowledge_point' AND target_id = OLD.id;
END;

CREATE TABLE review_history_v3 (
  id TEXT PRIMARY KEY,
  review_item_id TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('again','hard','good','easy')),
  reviewed_at INTEGER NOT NULL,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL
);
INSERT INTO review_history_v3 (id, review_item_id, result, reviewed_at, submission_id)
  SELECT h.id, h.review_item_id, h.result, h.reviewed_at,
         CASE WHEN s.id IS NULL THEN NULL ELSE h.submission_id END
  FROM review_history h LEFT JOIN submissions s ON s.id = h.submission_id;
DROP TABLE review_history;
ALTER TABLE review_history_v3 RENAME TO review_history;
CREATE INDEX idx_rh_item ON review_history(review_item_id, reviewed_at DESC);

CREATE TABLE practice_session_items_v3 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_accepted_submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  first_result_at INTEGER
);
INSERT INTO practice_session_items_v3
  (id, session_id, problem_id, sort_order, status, attempts, first_accepted_submission_id, first_result_at)
  SELECT i.id, i.session_id, i.problem_id, i.sort_order, i.status, i.attempts,
         CASE WHEN s.id IS NULL THEN NULL ELSE i.first_accepted_submission_id END,
         i.first_result_at
  FROM practice_session_items i LEFT JOIN submissions s ON s.id = i.first_accepted_submission_id;
DROP TABLE practice_session_items;
ALTER TABLE practice_session_items_v3 RENAME TO practice_session_items;
CREATE INDEX idx_psi_session ON practice_session_items(session_id, sort_order);

DELETE FROM review_items WHERE target_type='problem' AND target_id NOT IN (SELECT id FROM problems);
DELETE FROM review_items WHERE target_type='knowledge_point' AND target_id NOT IN (SELECT id FROM knowledge_points);
`
  }
]
