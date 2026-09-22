import type Database from 'better-sqlite3'
import type { BackupData } from '@shared/schemas'

/**
 * 备份数据访问层：全表读取 / 依赖序清空 / 依赖序写回 / 计数校验。
 * 只服务于备份/恢复（docs/V1_2_BACKUP_SPEC.md §4）；其他业务仓储保持职责单一。
 *
 * id 与时间戳原样保留（恢复后统计/趋势/连续天数不漂移）。
 * 清空顺序：子表 → 父表（不切换 foreign_keys，事务内无效）；写回顺序相反。
 * v1.2.1（P1-C）：全部嵌套聚合改为单次分组索引（Map），读取 O(N)——
 * 旧实现的 filter-inside-map 在 10000 提交 × 50000 明细时是 O(N²)。
 */

interface Counts {
  problems: number
  submissions: number
  testCaseResults: number
  errorRecords: number
  mistakeBook: number
  mistakeNotes: number
  learningPaths: number
  learningStages: number
  knowledgePoints: number
  problemKnowledge: number
  mastery: number
  reviewItems: number
  reviewHistory: number
  reviewSessionResults: number
  practiceSessions: number
  practiceSessionItems: number
  settings: number
}

const EMPTY_COUNTS: Counts = {
  problems: 0,
  submissions: 0,
  testCaseResults: 0,
  errorRecords: 0,
  mistakeBook: 0,
  mistakeNotes: 0,
  learningPaths: 0,
  learningStages: 0,
  knowledgePoints: 0,
  problemKnowledge: 0,
  mastery: 0,
  reviewItems: 0,
  reviewHistory: 0,
  reviewSessionResults: 0,
  practiceSessions: 0,
  practiceSessionItems: 0,
  settings: 0
}

export class BackupRepository {
  constructor(private readonly db: Database.Database) {}

  /** 读取全部业务数据（信封 data 载荷） */
  readAll(): BackupData {
    const settings: Record<string, string> = {}
    for (const r of this.db.prepare('SELECT key, value FROM settings ORDER BY rowid').all() as {
      key: string
      value: string
    }[]) {
      settings[r.key] = r.value
    }

    // 学习路线：paths → stages → knowledge_points 嵌套
    const pathRows = this.db
      .prepare('SELECT * FROM learning_paths ORDER BY sort_order')
      .all() as {
      id: string
      slug: string
      title: string
      description: string
      is_builtin: number
      sort_order: number
    }[]
    const stageRows = this.db
      .prepare('SELECT * FROM learning_stages ORDER BY path_id, sort_order')
      .all() as {
      id: string
      path_id: string
      title: string
      description: string
      sort_order: number
    }[]
    const kpRows = this.db
      .prepare('SELECT * FROM knowledge_points ORDER BY stage_id, sort_order')
      .all() as {
      id: string
      stage_id: string
      name: string
      description: string
      sort_order: number
      tags: string
    }[]
    // O(N) 分组索引：stage/kp 行各按父 id 建一次索引（P1-C，替代 filter-inside-map）
    const stagesByPath = new Map<string, typeof stageRows>()
    for (const s of stageRows) {
      const list = stagesByPath.get(s.path_id)
      if (list !== undefined) list.push(s)
      else stagesByPath.set(s.path_id, [s])
    }
    const kpsByStage = new Map<string, typeof kpRows>()
    for (const k of kpRows) {
      const list = kpsByStage.get(k.stage_id)
      if (list !== undefined) list.push(k)
      else kpsByStage.set(k.stage_id, [k])
    }
    const learningPaths = pathRows.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description,
      isBuiltin: p.is_builtin === 1,
      sortOrder: p.sort_order,
      stages: (stagesByPath.get(p.id) ?? []).map((s) => ({
        id: s.id,
        pathId: s.path_id,
        title: s.title,
        description: s.description,
        sortOrder: s.sort_order,
        knowledgePoints: (kpsByStage.get(s.id) ?? []).map((k) => ({
          id: k.id,
          stageId: k.stage_id,
          name: k.name,
          description: k.description,
          sortOrder: k.sort_order,
          tags: JSON.parse(k.tags) as string[]
        }))
      }))
    }))

    // 题目（含用例 id）
    const problemRows = this.db.prepare('SELECT * FROM problems ORDER BY created_at, rowid').all() as {
      id: string
      title: string
      description: string
      difficulty: string
      tags: string
      input_desc: string
      output_desc: string
      samples: string
      initial_code: string
      is_builtin: number
      created_at: number
      updated_at: number
    }[]
    const caseRows = this.db
      .prepare('SELECT * FROM test_cases ORDER BY problem_id, "order"')
      .all() as {
      id: string
      problem_id: string
      stdin: string
      expected_stdout: string
      timeout_ms: number
      order: number
    }[]
    const casesByProblem = new Map<string, typeof caseRows>()
    for (const c of caseRows) {
      const list = casesByProblem.get(c.problem_id)
      if (list !== undefined) list.push(c)
      else casesByProblem.set(c.problem_id, [c])
    }
    const problems = problemRows.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      difficulty: p.difficulty as 'easy' | 'medium' | 'hard',
      tags: JSON.parse(p.tags) as string[],
      inputDesc: p.input_desc,
      outputDesc: p.output_desc,
      samples: JSON.parse(p.samples) as { input: string; output: string; note?: string }[],
      initialCode: JSON.parse(p.initial_code) as { c: string; cpp: string; python: string },
      isBuiltin: p.is_builtin === 1,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      testCases: (casesByProblem.get(p.id) ?? []).map((c) => ({
        id: c.id,
        stdin: c.stdin,
        expectedStdout: c.expected_stdout,
        timeoutMs: c.timeout_ms
      }))
    }))

    // 提交（含用例结果）
    const subRows = this.db
      .prepare('SELECT * FROM submissions ORDER BY created_at, rowid')
      .all() as {
      id: string
      problem_id: string
      language: string
      code: string
      status: string
      passed_count: number
      total_count: number
      duration_ms: number
      created_at: number
    }[]
    const resultRows = this.db
      .prepare('SELECT * FROM test_case_results ORDER BY submission_id, "order"')
      .all() as {
      submission_id: string
      test_case_id: string
      order: number
      stdin: string
      expected: string
      actual: string | null
      stderr: string
      status: string
      exit_code: number | null
      duration_ms: number
    }[]
    const resultsBySubmission = new Map<string, typeof resultRows>()
    for (const r of resultRows) {
      const list = resultsBySubmission.get(r.submission_id)
      if (list !== undefined) list.push(r)
      else resultsBySubmission.set(r.submission_id, [r])
    }
    const submissions = subRows.map((s) => ({
      id: s.id,
      problemId: s.problem_id,
      language: s.language as 'c' | 'cpp' | 'python',
      code: s.code,
      status: s.status,
      passedCount: s.passed_count,
      totalCount: s.total_count,
      durationMs: s.duration_ms,
      createdAt: s.created_at,
      results: (resultsBySubmission.get(s.id) ?? []).map((r) => ({
        testCaseId: r.test_case_id,
        order: r.order,
        stdin: r.stdin,
        expected: r.expected,
        actual: r.actual,
        stderr: r.stderr,
        status: r.status,
        exitCode: r.exit_code,
        durationMs: r.duration_ms
      }))
    }))

    const errorRecords = (
      this.db.prepare('SELECT * FROM error_records ORDER BY created_at, rowid').all() as {
      id: string
      submission_id: string
      problem_id: string
      language: string
      error_type: string
      message: string
      created_at: number
      learning_category: string | null
      category_source: string | null
    }[]
    ).map((r) => ({
      id: r.id,
      submissionId: r.submission_id,
      problemId: r.problem_id,
      language: r.language as 'c' | 'cpp' | 'python',
      errorType: r.error_type,
      message: r.message,
      createdAt: r.created_at,
      learningCategory: r.learning_category,
      categorySource: (r.category_source as 'auto' | 'manual' | null) ?? null
    }))

    const mistakeBook = (
      this.db.prepare('SELECT * FROM mistake_book ORDER BY rowid').all() as {
      problem_id: string
      failed_count: number
      first_failed_at: number | null
      last_failed_at: number | null
      last_error_type: string | null
      error_type_counts: string
      mastered: number
      mastered_at: number | null
    }[]
    ).map((r) => ({
      problemId: r.problem_id,
      failedCount: r.failed_count,
      firstFailedAt: r.first_failed_at,
      lastFailedAt: r.last_failed_at,
      lastErrorType: r.last_error_type,
      errorTypeCounts: JSON.parse(r.error_type_counts) as Record<string, number>,
      mastered: r.mastered === 1,
      masteredAt: r.mastered_at
    }))

    const mistakeNotes = (
      this.db.prepare('SELECT * FROM mistake_notes ORDER BY updated_at, rowid').all() as {
      problem_id: string
      note: string
      updated_at: number
    }[]
    ).map((r) => ({ problemId: r.problem_id, note: r.note, updatedAt: r.updated_at }))

    const problemKnowledge = (
      this.db
        .prepare('SELECT problem_id, knowledge_point_id FROM problem_knowledge_points')
        .all() as { problem_id: string; knowledge_point_id: string }[]
    ).map((r) => ({ problemId: r.problem_id, knowledgePointId: r.knowledge_point_id }))

    const mastery = (
      this.db.prepare('SELECT * FROM mastery ORDER BY updated_at, rowid').all() as {
      knowledge_point_id: string
      score: number
      status: string
      updated_at: number
    }[]
    ).map((r) => ({
      knowledgePointId: r.knowledge_point_id,
      score: r.score,
      status: r.status as 'not_started' | 'learning' | 'weak' | 'familiar' | 'mastered',
      updatedAt: r.updated_at
    }))

    const reviewItems = (
      this.db.prepare('SELECT * FROM review_items ORDER BY created_at, rowid').all() as {
      id: string
      target_type: string
      target_id: string
      last_reviewed_at: number | null
      next_review_at: number
      review_count: number
      success_streak: number
      failure_count: number
      interval_days: number
      created_at: number
    }[]
    ).map((r) => ({
      id: r.id,
      targetType: r.target_type as 'knowledge_point' | 'problem',
      targetId: r.target_id,
      lastReviewedAt: r.last_reviewed_at,
      nextReviewAt: r.next_review_at,
      reviewCount: r.review_count,
      successStreak: r.success_streak,
      failureCount: r.failure_count,
      intervalDays: r.interval_days,
      createdAt: r.created_at
    }))

    const reviewHistory = (
      this.db.prepare('SELECT * FROM review_history ORDER BY reviewed_at, rowid').all() as {
      id: string
      review_item_id: string
      result: string
      reviewed_at: number
      submission_id: string | null
    }[]
    ).map((r) => ({
      id: r.id,
      reviewItemId: r.review_item_id,
      result: r.result as 'again' | 'hard' | 'good' | 'easy',
      reviewedAt: r.reviewed_at,
      submissionId: r.submission_id
    }))

    const sessionRows = this.db.prepare('SELECT * FROM practice_sessions ORDER BY created_at, rowid').all() as {
      id: string
      kind: string
      knowledge_point_id: string | null
      config: string
      status: string
      total: number
      created_at: number
      finished_at: number | null
    }[]
    const sessionItemRows = this.db
      .prepare('SELECT * FROM practice_session_items ORDER BY session_id, sort_order')
      .all() as {
      id: string
      session_id: string
      problem_id: string
      sort_order: number
      status: string
      attempts: number
      first_accepted_submission_id: string | null
      first_result_at: number | null
    }[]
    const itemsBySession = new Map<string, typeof sessionItemRows>()
    for (const i of sessionItemRows) {
      const list = itemsBySession.get(i.session_id)
      if (list !== undefined) list.push(i)
      else itemsBySession.set(i.session_id, [i])
    }
    const practiceSessions = sessionRows.map((s) => ({
      id: s.id,
      kind: s.kind as 'random' | 'knowledge_point' | 'review' | 'mistake',
      knowledgePointId: s.knowledge_point_id,
      config: JSON.parse(s.config) as Record<string, unknown>,
      status: s.status as 'active' | 'finished',
      total: s.total,
      createdAt: s.created_at,
      finishedAt: s.finished_at,
      items: (itemsBySession.get(s.id) ?? []).map((i) => ({
        id: i.id,
        problemId: i.problem_id,
        sortOrder: i.sort_order,
        status: i.status as 'pending' | 'accepted' | 'failed' | 'skipped',
        attempts: i.attempts,
        firstAcceptedSubmissionId: i.first_accepted_submission_id,
        firstResultAt: i.first_result_at
      }))
    }))

    const reviewSessionResults = (
      this.db
        .prepare('SELECT * FROM review_session_results ORDER BY graded_at, rowid')
        .all() as {
        session_id: string
        review_item_id: string
        grade: string
        submission_id: string | null
        graded_at: number
      }[]
    ).map((r) => ({
      sessionId: r.session_id,
      reviewItemId: r.review_item_id,
      grade: r.grade as 'again' | 'hard' | 'good' | 'easy',
      submissionId: r.submission_id,
      gradedAt: r.graded_at
    }))

    return {
      settings,
      learningPaths,
      problems,
      problemKnowledge,
      submissions,
      errorRecords,
      mistakeBook,
      mistakeNotes,
      mastery,
      reviewItems,
      reviewHistory,
      reviewSessionResults,
      practiceSessions
    }
  }

  /** 依赖序清空全部业务表（settings 一并清空，由写回阶段决定保留哪些键） */
  clearAll(): void {
    this.db.exec(`
      DELETE FROM review_session_results;
      DELETE FROM practice_session_items;
      DELETE FROM practice_sessions;
      DELETE FROM review_history;
      DELETE FROM review_items;
      DELETE FROM mastery;
      DELETE FROM mistake_notes;
      DELETE FROM error_records;
      DELETE FROM test_case_results;
      DELETE FROM submissions;
      DELETE FROM mistake_book;
      DELETE FROM problem_knowledge_points;
      DELETE FROM test_cases;
      DELETE FROM problems;
      DELETE FROM knowledge_points;
      DELETE FROM learning_stages;
      DELETE FROM learning_paths;
      DELETE FROM settings;
    `)
  }

  /** 依赖序写回备份数据（调用方处于事务内） */
  writeAll(data: BackupData): void {
    // settings
    const insSetting = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(data.settings)) insSetting.run(k, v)

    // 学习路线（父→子）
    const insPath = this.db.prepare(
      `INSERT INTO learning_paths (id, slug, title, description, is_builtin, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insStage = this.db.prepare(
      `INSERT INTO learning_stages (id, path_id, title, description, sort_order) VALUES (?, ?, ?, ?, ?)`
    )
    const insKp = this.db.prepare(
      `INSERT INTO knowledge_points (id, stage_id, name, description, sort_order, tags) VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const p of data.learningPaths) {
      insPath.run(p.id, p.slug, p.title, p.description, p.isBuiltin ? 1 : 0, p.sortOrder)
      for (const s of p.stages) {
        insStage.run(s.id, s.pathId, s.title, s.description, s.sortOrder)
        for (const k of s.knowledgePoints) {
          insKp.run(k.id, k.stageId, k.name, k.description, k.sortOrder, JSON.stringify(k.tags))
        }
      }
    }

    // 题目 + 用例
    const insProblem = this.db.prepare(
      `INSERT INTO problems (id, title, description, difficulty, tags, input_desc, output_desc, samples, initial_code, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insCase = this.db.prepare(
      `INSERT INTO test_cases (id, problem_id, stdin, expected_stdout, timeout_ms, "order") VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const p of data.problems) {
      insProblem.run(
        p.id,
        p.title,
        p.description,
        p.difficulty,
        JSON.stringify(p.tags),
        p.inputDesc,
        p.outputDesc,
        JSON.stringify(p.samples),
        JSON.stringify(p.initialCode),
        p.isBuiltin ? 1 : 0,
        p.createdAt ?? Date.now(),
        p.updatedAt ?? Date.now()
      )
      for (const [i, c] of p.testCases.entries()) {
        insCase.run(c.id, p.id, c.stdin, c.expectedStdout, c.timeoutMs, i)
      }
    }

    // 提交 + 明细
    const insSub = this.db.prepare(
      `INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insResult = this.db.prepare(
      `INSERT INTO test_case_results (id, submission_id, test_case_id, "order", stdin, expected, actual, stderr, status, exit_code, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of data.submissions) {
      insSub.run(
        s.id,
        s.problemId,
        s.language,
        s.code,
        s.status,
        s.passedCount,
        s.totalCount,
        s.durationMs,
        s.createdAt
      )
      for (const r of s.results) {
        insResult.run(
          `${s.id}:${r.testCaseId}`,
          s.id,
          r.testCaseId,
          r.order,
          r.stdin,
          r.expected,
          r.actual,
          r.stderr,
          r.status,
          r.exitCode,
          r.durationMs
        )
      }
    }

    const insErr = this.db.prepare(
      `INSERT INTO error_records (id, submission_id, problem_id, language, error_type, message, created_at, learning_category, category_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const e of data.errorRecords) {
      insErr.run(
        e.id,
        e.submissionId,
        e.problemId,
        e.language,
        e.errorType,
        e.message,
        e.createdAt,
        e.learningCategory,
        e.categorySource
      )
    }

    const insMistake = this.db.prepare(
      `INSERT INTO mistake_book (problem_id, failed_count, first_failed_at, last_failed_at, last_error_type, error_type_counts, mastered, mastered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const m of data.mistakeBook) {
      insMistake.run(
        m.problemId,
        m.failedCount,
        m.firstFailedAt,
        m.lastFailedAt,
        m.lastErrorType,
        JSON.stringify(m.errorTypeCounts),
        m.mastered ? 1 : 0,
        m.masteredAt
      )
    }

    const insNote = this.db.prepare(
      'INSERT INTO mistake_notes (problem_id, note, updated_at) VALUES (?, ?, ?)'
    )
    for (const n of data.mistakeNotes) insNote.run(n.problemId, n.note, n.updatedAt)

    const insPk = this.db.prepare(
      'INSERT INTO problem_knowledge_points (problem_id, knowledge_point_id) VALUES (?, ?)'
    )
    for (const pk of data.problemKnowledge) insPk.run(pk.problemId, pk.knowledgePointId)

    const insMastery = this.db.prepare(
      'INSERT INTO mastery (knowledge_point_id, score, status, updated_at) VALUES (?, ?, ?, ?)'
    )
    for (const m of data.mastery) insMastery.run(m.knowledgePointId, m.score, m.status, m.updatedAt)

    const insReview = this.db.prepare(
      `INSERT INTO review_items (id, target_type, target_id, last_reviewed_at, next_review_at, review_count, success_streak, failure_count, interval_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of data.reviewItems) {
      insReview.run(
        r.id,
        r.targetType,
        r.targetId,
        r.lastReviewedAt,
        r.nextReviewAt,
        r.reviewCount,
        r.successStreak,
        r.failureCount,
        r.intervalDays,
        r.createdAt
      )
    }

    const insRh = this.db.prepare(
      `INSERT INTO review_history (id, review_item_id, result, reviewed_at, submission_id) VALUES (?, ?, ?, ?, ?)`
    )
    for (const h of data.reviewHistory) {
      insRh.run(h.id, h.reviewItemId, h.result, h.reviewedAt, h.submissionId)
    }

    const insSession = this.db.prepare(
      `INSERT INTO practice_sessions (id, kind, knowledge_point_id, config, status, total, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insItem = this.db.prepare(
      `INSERT INTO practice_session_items (id, session_id, problem_id, sort_order, status, attempts, first_accepted_submission_id, first_result_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of data.practiceSessions) {
      insSession.run(
        s.id,
        s.kind,
        s.knowledgePointId,
        JSON.stringify(s.config),
        s.status,
        s.total,
        s.createdAt,
        s.finishedAt
      )
      for (const i of s.items) {
        insItem.run(
          i.id,
          s.id,
          i.problemId,
          i.sortOrder,
          i.status,
          i.attempts,
          i.firstAcceptedSubmissionId,
          i.firstResultAt
        )
      }
    }

    // v1.2.1 会话评分记录（v1 备份缺失 → 空数组；须在 practice_sessions 之后——FK 依赖）
    const insRsr = this.db.prepare(
      `INSERT OR IGNORE INTO review_session_results (session_id, review_item_id, grade, submission_id, graded_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const r of data.reviewSessionResults ?? []) {
      insRsr.run(r.sessionId, r.reviewItemId, r.grade, r.submissionId, r.gradedAt)
    }
  }

  /** 逐表计数（verify 用，与备份载荷长度对比） */
  counts(): Counts {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number }).c
    return {
      problems: count('SELECT COUNT(*) AS c FROM problems'),
      submissions: count('SELECT COUNT(*) AS c FROM submissions'),
      testCaseResults: count('SELECT COUNT(*) AS c FROM test_case_results'),
      errorRecords: count('SELECT COUNT(*) AS c FROM error_records'),
      mistakeBook: count('SELECT COUNT(*) AS c FROM mistake_book'),
      mistakeNotes: count('SELECT COUNT(*) AS c FROM mistake_notes'),
      learningPaths: count('SELECT COUNT(*) AS c FROM learning_paths'),
      learningStages: count('SELECT COUNT(*) AS c FROM learning_stages'),
      knowledgePoints: count('SELECT COUNT(*) AS c FROM knowledge_points'),
      problemKnowledge: count('SELECT COUNT(*) AS c FROM problem_knowledge_points'),
      mastery: count('SELECT COUNT(*) AS c FROM mastery'),
      reviewItems: count('SELECT COUNT(*) AS c FROM review_items'),
      reviewHistory: count('SELECT COUNT(*) AS c FROM review_history'),
      reviewSessionResults: count('SELECT COUNT(*) AS c FROM review_session_results'),
      practiceSessions: count('SELECT COUNT(*) AS c FROM practice_sessions'),
      practiceSessionItems: count('SELECT COUNT(*) AS c FROM practice_session_items'),
      settings: count('SELECT COUNT(*) AS c FROM settings')
    }
  }

  /** settings 原始键值（恢复前读取本地标记用） */
  countsTable(): { key: string; value: string }[] {
    return this.db.prepare('SELECT key, value FROM settings ORDER BY rowid').all() as {
      key: string
      value: string
    }[]
  }

  insertSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  /** 事务包装（恢复整体原子性） */
  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn)
  }

  /** 备份载荷期望计数（verify 对拍） */
  static expectedCounts(data: BackupData): Counts {
    return {
      ...EMPTY_COUNTS,
      problems: data.problems.length,
      submissions: data.submissions.length,
      testCaseResults: data.submissions.reduce((n, s) => n + s.results.length, 0),
      errorRecords: data.errorRecords.length,
      mistakeBook: data.mistakeBook.length,
      mistakeNotes: data.mistakeNotes.length,
      learningPaths: data.learningPaths.length,
      learningStages: data.learningPaths.reduce((n, p) => n + p.stages.length, 0),
      knowledgePoints: data.learningPaths.reduce(
        (n, p) => n + p.stages.reduce((m, s) => m + s.knowledgePoints.length, 0),
        0
      ),
      problemKnowledge: data.problemKnowledge.length,
      mastery: data.mastery.length,
      reviewItems: data.reviewItems.length,
      reviewHistory: data.reviewHistory.length,
      reviewSessionResults: data.reviewSessionResults?.length ?? 0,
      practiceSessions: data.practiceSessions.length,
      practiceSessionItems: data.practiceSessions.reduce((n, s) => n + s.items.length, 0),
      settings: Object.keys(data.settings).length
    }
  }
}
