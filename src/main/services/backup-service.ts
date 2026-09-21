import type { Database } from 'better-sqlite3'
import {
  BACKUP_FORMAT_NAME,
  BACKUP_FORMAT_VERSION,
  backupEnvelopeSchema,
  type BackupData,
  type BackupEnvelope
} from '@shared/schemas'
import { AppError } from '../lib/app-error'
import { BackupRepository } from '../db/repositories/backup-repository'

/**
 * 备份服务（docs/V1_2_BACKUP_SPEC.md）：
 * - 导出：读全部业务表 → 信封 JSON（versioned）
 * - 校验：JSON parse → zod 全量 schema → 版本兼容 → 交叉引用
 * - 恢复：单一事务（清空 → 写回 → verify 计数），任一步失败整体回滚
 */

export interface BackupSummary {
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

export class BackupService {
  private readonly repo: BackupRepository

  constructor(db: Database) {
    this.repo = new BackupRepository(db)
  }

  /** 导出：组装信封（appVersion 由调用方传入） */
  exportJson(appVersion: string): { json: string; counts: ReturnType<BackupRepository['counts']> } {
    const data = this.repo.readAll()
    const envelope: BackupEnvelope = {
      format: BACKUP_FORMAT_NAME,
      version: BACKUP_FORMAT_VERSION,
      createdAt: Date.now(),
      appVersion,
      data
    }
    return { json: JSON.stringify(envelope, null, 2), counts: this.repo.counts() }
  }

  /** 校验备份文本：parse → 版本 → zod → 交叉引用。返回信封与人类可读摘要。 */
  validate(jsonText: string): { envelope: BackupEnvelope; summary: BackupSummary } {
    let raw: unknown
    try {
      raw = JSON.parse(jsonText)
    } catch {
      throw new AppError('validation', '不是合法的 JSON 文件：备份文件已损坏或不完整')
    }
    if (isFormatMismatch(raw)) {
      throw new AppError(
        'validation',
        '这不是 CuinCodeBench 完整备份文件（可能是题目导出 JSON，请使用题库导入功能）'
      )
    }

    const envelope = backupEnvelopeSchema.parse(raw)

    if (envelope.version > BACKUP_FORMAT_VERSION) {
      throw new AppError(
        'validation',
        `备份版本过新（v${envelope.version}），当前应用支持到 v${BACKUP_FORMAT_VERSION}。请先升级应用。`
      )
    }
    if (envelope.version < BACKUP_FORMAT_VERSION) {
      throw new AppError(
        'validation',
        `备份版本过旧（v${envelope.version}），不再支持导入。`
      )
    }

    this.checkCrossReferences(envelope.data)

    const d = envelope.data
    return {
      envelope,
      summary: {
        createdAt: envelope.createdAt,
        appVersion: envelope.appVersion ?? null,
        counts: {
          problems: d.problems.length,
          submissions: d.submissions.length,
          errorRecords: d.errorRecords.length,
          mistakeBook: d.mistakeBook.length,
          mistakeNotes: d.mistakeNotes.length,
          knowledgePoints: d.learningPaths.reduce(
            (n, p) => n + p.stages.reduce((m, s) => m + s.knowledgePoints.length, 0),
            0
          ),
          mastery: d.mastery.length,
          reviewItems: d.reviewItems.length,
          reviewHistory: d.reviewHistory.length,
          practiceSessions: d.practiceSessions.length
        }
      }
    }
  }

  /** 交叉引用完整性：孤立外键的备份一律拒绝（docs/V1_2_BACKUP_SPEC.md §3） */
  private checkCrossReferences(data: BackupData): void {
    const problemIds = new Set(data.problems.map((p) => p.id))
    const kpIds = new Set<string>()
    for (const p of data.learningPaths) {
      for (const s of p.stages) {
        for (const k of s.knowledgePoints) kpIds.add(k.id)
      }
    }
    const reviewItemIds = new Set(data.reviewItems.map((r) => r.id))
    const submissionIds = new Set(data.submissions.map((s) => s.id))

    const problems: string[] = []
    const add = (cond: boolean, msg: string): void => {
      if (cond && problems.length < 10) problems.push(msg)
    }

    for (const s of data.submissions) {
      add(!problemIds.has(s.problemId), `提交 ${s.id} 指向不存在的题目 ${s.problemId}`)
    }
    for (const e of data.errorRecords) {
      add(!submissionIds.has(e.submissionId), `错误记录 ${e.id} 指向不存在的提交`)
      add(!problemIds.has(e.problemId), `错误记录 ${e.id} 指向不存在的题目`)
    }
    for (const pk of data.problemKnowledge) {
      add(!problemIds.has(pk.problemId), `题目绑定指向不存在的题目 ${pk.problemId}`)
      add(!kpIds.has(pk.knowledgePointId), `题目绑定指向不存在的知识点 ${pk.knowledgePointId}`)
    }
    for (const m of data.mastery) {
      add(!kpIds.has(m.knowledgePointId), `掌握度指向不存在的知识点 ${m.knowledgePointId}`)
    }
    for (const r of data.reviewItems) {
      if (r.targetType === 'problem') add(!problemIds.has(r.targetId), `复习项指向不存在的题目 ${r.targetId}`)
      else add(!kpIds.has(r.targetId), `复习项指向不存在的知识点 ${r.targetId}`)
    }
    for (const h of data.reviewHistory) {
      add(!reviewItemIds.has(h.reviewItemId), `复习历史指向不存在的复习项 ${h.reviewItemId}`)
    }
    for (const n of data.mistakeNotes) {
      add(!problemIds.has(n.problemId), `错题笔记指向不存在的题目 ${n.problemId}`)
    }
    for (const m of data.mistakeBook) {
      add(!problemIds.has(m.problemId), `错题聚合指向不存在的题目 ${m.problemId}`)
    }
    const sessionProblemIds = new Set<string>()
    for (const s of data.practiceSessions) {
      for (const i of s.items) sessionProblemIds.add(i.problemId)
    }
    for (const pid of sessionProblemIds) {
      add(!problemIds.has(pid), `练习队列包含不存在的题目 ${pid}`)
    }
    for (const s of data.practiceSessions) {
      if (s.knowledgePointId !== null) {
        add(!kpIds.has(s.knowledgePointId), `练习会话指向不存在的知识点`)
      }
    }

    if (problems.length > 0) {
      throw new AppError('validation', `备份数据不完整（引用断裂）：${problems.join('；')}`)
    }
  }

  /**
   * 恢复（全量覆盖）：单一事务 清空 → 写回 → verify。
   * settings 特例：备份缺失的键保留本地现值（防止旧备份恢复后种子/升级标记丢失导致意外重灌）。
   * 任何异常（含 verify 失败）→ 整体回滚，数据库保持恢复前状态。
   */
  restore(envelope: BackupEnvelope): { counts: ReturnType<BackupRepository['counts']> } {
    const data = envelope.data
    // 恢复前的本地标记键（seeded / learning_v2_mapped / seeded_v2 等），备份缺失时回写
    const localMarkerKeys = ['seeded', 'learning_v2_mapped', 'seeded_v2']
    const localSettings: Record<string, string> = {}
    for (const r of this.repo.countsTable()) {
      localSettings[r.key] = r.value
    }

    const tx = this.repo.transaction(() => {
      this.repo.clearAll()
      this.repo.writeAll(data)
      // settings 特例：备份缺失的标记键回写本地现值
      let restoredKeys = Object.keys(data.settings).length
      for (const key of localMarkerKeys) {
        if (!(key in data.settings) && key in localSettings) {
          this.repo.insertSetting(key, localSettings[key] ?? '')
          restoredKeys++
        }
      }
      // verify：逐表计数对拍
      const actual = this.repo.counts()
      const expected = BackupRepository.expectedCounts(data)
      expected.settings = restoredKeys
      for (const [table, exp] of Object.entries(expected)) {
        const act = actual[table as keyof typeof actual]
        if (act !== exp) {
          throw new AppError(
            'internal',
            `恢复校验失败：表 ${table} 期望 ${exp} 行，实际 ${act} 行`
          )
        }
      }
    })
    tx()
    return { counts: this.repo.counts() }
  }
}

/** 识别"格式正确的 JSON 但不是备份格式"（如题目导出文件），给出可行动的错误提示 */
function isFormatMismatch(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || !('format' in raw)) return false
  return raw.format !== BACKUP_FORMAT_NAME
}
