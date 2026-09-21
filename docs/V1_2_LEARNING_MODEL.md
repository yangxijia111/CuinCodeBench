# V1_2_LEARNING_MODEL.md — v1.2 领域模型与数据库设计

## 1. 实体关系总览

```
LearningPath 1 ──< LearningStage 1 ──< KnowledgePoint >──── Problem
                                                      (problem_knowledge_points, N:N)
                                                        │
                ┌───────────────────────────────────────┤
                │                                       │
           Mastery                                  Submission（v1.1 已有）
     (每知识点一行，可解释规则)                            │
                                                      TestCaseResult / ErrorRecord
                │                                       │
           ReviewItem ◄──────────────  MistakeBook(v1.1) 派生错题 → ReviewItem(problem)
     (target: knowledge_point | problem)
                │
                └──< ReviewHistory (Again/Hard/Good/Easy)

PracticeSession 1 ──< PracticeSessionItem >── Problem
MistakeNote 1:1 Problem（错因笔记）
ErrorRecord += learning_category / category_source（学习错误分类）
```

设计原则：
- **可派生优先**：错题的错误历史（首次/最近错误代码等）从 v1.1 已有的 `submissions + error_records` 查询派生，不冗余存储。
- **掌握度与复习调度是物化缓存**：`mastery` 与 `review_items` 由原始事件（submissions / review_history）可重算，规则见 V1_2_MASTERY_SPEC.md / V1_2_REVIEW_SPEC.md；重算幂等。
- **一知识点一阶段**：`knowledge_points.stage_id` 单外键（阶段内 `sort_order` 排序）；多路径复用同一知识点集合的实现复杂度高且无真实需求，不采用 M:N。

## 2. Migration v2（`learning-v1.2`，version = 2）

幂等机制复用 v1.1：`schema_migrations` 中无 version 2 才执行，单事务，失败启动报错。
**只增不删**，v1.1 全部表与数据原样保留。

### 2.1 新表

```sql
-- 学习路线：内置 C 基础（is_builtin=1，应用启动时幂等灌入）
CREATE TABLE learning_paths (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,          -- 'c-basics'
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
  tags TEXT NOT NULL DEFAULT '[]'     -- JSON string[]
);
CREATE INDEX idx_kp_stage ON knowledge_points(stage_id, sort_order);

-- 题目 ↔ 知识点 多对多
CREATE TABLE problem_knowledge_points (
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  PRIMARY KEY (problem_id, knowledge_point_id)
);
CREATE INDEX idx_pkk_kp ON problem_knowledge_points(knowledge_point_id);

-- 掌握度（物化缓存，可全量重算；公式见 V1_2_MASTERY_SPEC.md）
CREATE TABLE mastery (
  knowledge_point_id TEXT PRIMARY KEY REFERENCES knowledge_points(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','learning','weak','familiar','mastered')),
  updated_at INTEGER NOT NULL
);

-- 复习调度（算法见 V1_2_REVIEW_SPEC.md）
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
  submission_id TEXT                  -- 关联本次复习的提交（可空：手动评分）
);
CREATE INDEX idx_rh_item ON review_history(review_item_id, reviewed_at DESC);

-- 错题笔记（1:1 题目）
CREATE TABLE mistake_notes (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- 练习队列（随机练习 / 专项训练 / 复习会话的组题容器）
CREATE TABLE practice_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('random','knowledge_point','review','mistake')),
  knowledge_point_id TEXT REFERENCES knowledge_points(id) ON DELETE SET NULL,
  config TEXT NOT NULL DEFAULT '{}',  -- JSON：生成时过滤器快照
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
```

### 2.2 既有表扩展（ALTER TABLE ADD COLUMN，NULL 兼容旧数据）

```sql
ALTER TABLE error_records ADD COLUMN learning_category TEXT;
ALTER TABLE error_records ADD COLUMN category_source TEXT;  -- 'auto' | 'manual'
```

`learning_category` 枚举（应用层校验，SQLite 层不加 CHECK 以兼容旧行 NULL）：
`syntax | condition | loop | array_boundary | pointer | input_output | algorithm | off_by_one | memory | other | unknown`

### 2.3 新增索引（性能）

```sql
-- submissions 已有 idx_submissions_problem(problem_id, created_at DESC)，聚合查询直接可用
```

### 2.4 删除题目的一致性（防孤儿数据）

`problems` 的 `ON DELETE CASCADE` 已覆盖：test_cases / submissions（→test_case_results）/ error_records / mistake_book。
v2 表通过 CASCADE 覆盖：problem_knowledge_points / mistake_notes / practice_session_items。
**代码级补充**（`problem-service.remove`）：删除题目后触发
1. 重算该题曾关联知识点的 mastery（题目减少 → coverage 下降）；
2. 删除该题的 review_items（`target_type='problem'`；知识点 review_items 保留但由重算修正）；
3. 含该题的 active practice_session_items 标记 `skipped`。

migration 后对全库执行一次孤儿清理兜底 SQL（幂等）：

```sql
DELETE FROM review_items WHERE target_type='problem' AND target_id NOT IN (SELECT id FROM problems);
DELETE FROM review_items WHERE target_type='knowledge_point' AND target_id NOT IN (SELECT id FROM knowledge_points);
DELETE FROM practice_session_items WHERE problem_id NOT IN (SELECT id FROM problems);
DELETE FROM mastery WHERE knowledge_point_id NOT IN (SELECT id FROM knowledge_points);
```

## 3. 内置种子数据（C 基础路线）

`resources/seed-learning-path.json`（内部资源，与备份格式无关）：

- **路径**：C 基础（slug: `c-basics`）
- **阶段与知识点**（阶段 → 知识点，sort_order 顺序即学习顺序）：

| # | 阶段 | 知识点 |
|---|---|---|
| 1 | 起步 | 输入输出 · 变量与类型 · 运算符 |
| 2 | 分支 | if 条件 · switch |
| 3 | 循环 | for 循环 · while 循环 · 循环控制 break/continue |
| 4 | 数组与字符串 | 一维数组 · 二维数组 · 字符串 |
| 5 | 函数 | 函数定义与调用 · 递归基础 |
| 6 | 指针与结构体 | 指针基础 · struct 结构体 |

- 知识点 `tags` 含别名（如「循环」的别名 `for`,`while`,`loop`），供旧题自动映射。

**旧题自动映射（一次性，幂等）**：应用启动时若无 `learning_v2_mapped` 标记：
1. 灌入内置路线（按 slug 幂等，已存在跳过）；
2. 对 `is_builtin=1` 的题目按 tags/标题关键词规则映射到知识点（写 `problem_knowledge_points`，`INSERT OR IGNORE`）；
3. 写 `learning_v2_mapped` 标记。用户自建题目不自动映射（无法可靠判断），由用户在题目编辑页手动指派。

## 4. shared 层类型扩展（`src/shared/types.ts` + `schemas.ts`）

新增类型：`LearningPath / LearningStage / KnowledgePoint / KnowledgePointSummary（含完成度与掌握）/ MasteryInfo / ReviewItem / ReviewHistoryEntry / ReviewGrade / MistakeNote / ErrorCategory / PracticeSession / PracticeSessionItem / SessionSummary / DashboardV2Stats / TrendPoint` 等；全部 IPC 入参补 zod schema（`problemQuerySchema` 扩展、`reviewGradeSchema`、`sessionCreateSchema`、`mistakeNoteSchema` 等）。

## 5. 服务与 IPC 布局（沿用 v1.1 分层）

| Service | 职责 |
|---|---|
| `learning-service` | 路径/阶段/知识点查询（含完成度聚合）、题目↔知识点绑定 |
| `mastery-service` | 掌握度重算（事件驱动 + 惰性）、查询 |
| `review-service` | 复习项生命周期、调度、Review Session、评分 |
| `backup-service` | 导出 JSON、校验、事务恢复 |
| `mistake-service`（扩展） | 错误历史查询、笔记、错误分类 |
| `practice-session-service` | 组题、进度、总结 |
| `stats-repository`（扩展） | Dashboard 2.0 聚合 + 趋势 |

新 IPC 通道（全部走 `handle()`：sender 校验 + zod）：
`learning.paths / learning.pathDetail / learning.bindProblem / learning.unbindProblem / mastery.list / mastery.recalc / review.today / review.startSession / review.grade / mistake.notes.get / mistake.notes.set / mistake.history / mistake.setCategory / sessions.create / sessions.get / sessions.reportItem / sessions.finish / backup.export / backup.importPreview / backup.confirmRestore / backup.cancelImport / stats.dashboardV2 / problems.queryV2`

## 6. 判题落库 hook（掌握度/复习的驱动点）

`judge-service.persist()` 在 v1.1 逻辑（insertSubmission → insertErrorRecord → mistakes.recompute）之后追加（同一持久化语义，失败不阻断判题结果返回）：
1. `review-service.onSubmission(...)`：题目 AC/失败更新该题 review_item（错题首次入选即建项，立即到期）；知识点 review_item 首次活动时建立（次日到期）；
2. `mastery-service.recalcForProblem(problemId)`：重算该题关联的全部知识点。

错误分类：`insertErrorRecord` 时按规则自动填 `learning_category`（见 V1_2_MASTERY_SPEC.md §6）。

## 7. 时间与随机性

- 全部时间戳 UTC 毫秒（`Date.now()`）；「到期」判断 = `next_review_at <= now()`；`now` 作为参数注入 service 方法（默认 `Date.now`），测试可控。
- 随机组题使用注入的随机源（默认 `Math.random`），测试固定种子场景用显式列表。
