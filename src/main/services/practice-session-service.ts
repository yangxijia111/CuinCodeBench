import type Database from 'better-sqlite3'
import type { PracticeSession, RandomSessionConfig } from '@shared/types'
import { PracticeRepository } from '../db/repositories/practice-repository'
import { AppError } from '../lib/app-error'

/**
 * 练习会话服务（docs/V1_2_ROADMAP.md P7）：
 * 随机练习（难度/语言/标签/知识点/范围过滤）与专项训练（知识点内选题）。
 * 判题结果经 judge hook 自动回报（PracticeRepository.findActiveSessionsForProblem）。
 */

export const SESSION_SIZES = [5, 10, 20] as const
export const DEFAULT_RANDOM_SIZE = 10

/** 低掌握度阈值：关联知识点 score < 40 或 weak 状态 */
const WEAK_SCORE = 40

export class PracticeSessionService {
  private readonly db: Database.Database
  readonly sessions: PracticeRepository

  constructor(db: Database.Database) {
    this.db = db
    this.sessions = new PracticeRepository(db)
  }

  /** 随机组题（docs/V1_2_ROADMAP.md P7）：过滤条件 AND 组合，RANDOM() 随机截断 */
  createRandomSession(rawConfig: RandomSessionConfig, now: number): PracticeSession {
    const config: RandomSessionConfig = {
      difficulty: rawConfig.difficulty ?? 'all',
      language: rawConfig.language ?? 'all',
      tag: rawConfig.tag ?? 'all',
      knowledgePointId: rawConfig.knowledgePointId ?? 'all',
      scope: rawConfig.scope ?? 'all',
      size: Math.min(Math.max(rawConfig.size ?? DEFAULT_RANDOM_SIZE, 1), 50)
    }

    const conditions: string[] = []
    const params: unknown[] = []
    if (config.difficulty !== 'all') {
      conditions.push('p.difficulty = ?')
      params.push(config.difficulty)
    }
    if (config.tag !== 'all' && config.tag !== '') {
      conditions.push("p.tags LIKE ? ESCAPE '\\'")
      params.push(`%"${String(config.tag).replace(/[\\%_]/g, (c) => `\\${c}`)}"%`)
    }
    if (config.knowledgePointId !== 'all' && config.knowledgePointId !== '') {
      conditions.push('EXISTS (SELECT 1 FROM problem_knowledge_points pk WHERE pk.problem_id = p.id AND pk.knowledge_point_id = ?)')
      params.push(config.knowledgePointId)
    }
    // 语言过滤：题目为该语言提供了非空初始代码（练习入口语义）
    if (config.language !== 'all') {
      conditions.push("COALESCE(json_extract(p.initial_code, ?), '') != ''")
      params.push(`$.${config.language}`)
    }
    switch (config.scope) {
      case 'unsolved':
        conditions.push('NOT EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.status = \'accepted\')')
        break
      case 'mistakes':
        conditions.push('EXISTS (SELECT 1 FROM mistake_book mb WHERE mb.problem_id = p.id AND mb.mastered = 0 AND mb.failed_count >= 2)')
        break
      case 'weak':
        conditions.push(`EXISTS (
          SELECT 1 FROM problem_knowledge_points pk
          JOIN knowledge_points k ON k.id = pk.knowledge_point_id
          LEFT JOIN mastery m ON m.knowledge_point_id = k.id
          WHERE pk.problem_id = p.id AND (COALESCE(m.score, 0) < ${WEAK_SCORE} OR COALESCE(m.status, 'learning') = 'weak')
        )`)
        break
      case 'all':
        break
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT p.id FROM problems p ${where} ORDER BY RANDOM() LIMIT ${config.size}`
      )
      .all(...params) as { id: string }[]

    if (rows.length === 0) {
      throw new AppError('validation', '没有符合条件的题目，请放宽过滤条件')
    }
    return this.sessions.createSession('random', null, { ...config }, rows.map((r) => r.id), now)
  }

  /** 专项训练：知识点内随机组题 */
  createKpSession(knowledgePointId: string, size: number, now: number): PracticeSession {
    const kp = this.db.prepare('SELECT id, name FROM knowledge_points WHERE id = ?').get(knowledgePointId) as
      | { id: string }
      | undefined
    if (kp === undefined) throw new AppError('not_found', `知识点不存在: ${knowledgePointId}`)
    const clamped = Math.min(Math.max(size, 1), 50)
    const rows = this.db
      .prepare(
        `SELECT p.id FROM problem_knowledge_points pk
         JOIN problems p ON p.id = pk.problem_id
         WHERE pk.knowledge_point_id = ?
         ORDER BY RANDOM() LIMIT ${clamped}`
      )
      .all(knowledgePointId) as { id: string }[]
    if (rows.length === 0) {
      throw new AppError('validation', '该知识点暂无关联题目')
    }
    return this.sessions.createSession('knowledge_point', knowledgePointId, { size: clamped }, rows.map((r) => r.id), now)
  }

  getSession(id: string): PracticeSession | null {
    return this.sessions.getSession(id)
  }

  /** 判题回报入口（与 judge hook 等价；测试与 hook 复用） */
  onSubmission(problemId: string, accepted: boolean, submissionId: string | null, now: number): void {
    for (const session of this.sessions.findActiveSessionsForProblem(problemId, ['review', 'random', 'knowledge_point'])) {
      void this.sessions.reportResult(session.id, problemId, accepted, submissionId, now)
    }
  }

  /** 会话总结：完成数、正确数、首次 AC 数 */
  summarize(id: string): {
    total: number
    answered: number
    accepted: number
    firstAccepted: number
  } {
    const session = this.sessions.getSession(id)
    if (session === null) throw new AppError('not_found', `会话不存在: ${id}`)
    const answered = session.items.filter((i) => i.status === 'accepted' || i.status === 'failed')
    return {
      total: session.items.length,
      answered: answered.length,
      accepted: session.items.filter((i) => i.status === 'accepted').length,
      firstAccepted: session.items.filter((i) => i.firstAcceptedSubmissionId !== null).length
    }
  }
}
