import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { z } from 'zod'
import {
  problemQuerySchema,
  runOnceInputSchema,
  judgeSubmitSchema,
  submissionQuerySchema,
  appSettingsPatchSchema,
  randomSessionConfigSchema
} from '@shared/schemas'
import type { AppSettings, ErrorCategory } from '@shared/types'
import { handle, getDataDir, AppError } from './index'
import { getServices } from '../services'
import type { ToolchainService } from '../services/toolchain-service'
import type { JudgeService } from '../services/judge-service'
import { logger } from '../lib/logger'
import {
  previewRestore,
  confirmRestore,
  cancelPendingRestore,
  getRestoreStatus,
  type RestoreDeps
} from '../backup/restore-coordinator'
import { startJob } from '../backup/backup-worker-client'
import { LearningRepository } from '../db/repositories/learning-repository'
import { resolveLearningSeedFile, loadLearningPathSeed, ensureLearningSeed } from '../learning/learning-seed'

/**
 * IPC 通道注册总入口：按模块拆分，全部走 zod 校验 + 统一错误信封。
 */

const noArgs = z.unknown()

export interface IpcDeps {
  toolchains: ToolchainService
  judge: JudgeService
}

export function registerIpcHandlers(deps: IpcDeps): void {
  // —— 应用信息 ——
  handle('app.getInfo', noArgs, () => ({
    version: app.getVersion(),
    dataDir: getDataDir()
  }))

  // —— 题库 ——
  const svc = () => getServices()
  handle('problems.list', problemQuerySchema, (q) => svc().problems.list(q))
  handle('problems.get', z.string(), (id) => {
    const p = svc().problems.get(id)
    if (!p) throw new AppError('not_found', `题目不存在: ${id}`)
    return p
  })
  handle('problems.create', z.unknown(), (input) => svc().problems.create(input))
  handle('problems.update', z.tuple([z.string(), z.unknown()]), ([id, input]) =>
    svc().problems.update(id, input)
  )
  handle('problems.delete', z.string(), (id) => {
    // v1.2.1 P0-D：服务层防线——删除题目先清理其多态复习项
    // （DB 触发器为第二道防线，见 migration v3 trg_problems_delete_review_cleanup）
    svc().reviewSvc.deleteByProblem(id)
    svc().problems.remove(id)
    return undefined
  })
  handle('problems.listTags', noArgs, () => svc().problems.listTags())
  handle('problems.export', z.array(z.string()).nullable(), (ids) => svc().problems.exportJson(ids))
  handle('problems.import', z.string(), (text) => svc().problems.importJson(text))

  // —— 工具链 ——
  handle('toolchains.detect', z.boolean(), (force) => deps.toolchains.detectAll(force))

  // —— 运行与判题 ——
  handle('run.once', runOnceInputSchema, (input) => deps.judge.runOnce(input))
  handle('judge.submit', judgeSubmitSchema, ([problemId, language, code]) =>
    deps.judge.submit(problemId, language, code)
  )

  // —— 历史 ——
  handle('history.list', submissionQuerySchema, (q) =>
    svc().history.list(q).map((s) => ({ ...s, problemTitle: s.problemTitle ?? '' }))
  )
  handle('history.detail', z.string(), (id) => svc().history.getById(id))
  handle('history.problemStats', z.string(), (problemId) => svc().history.getProblemStats(problemId))

  // —— 错题本 ——
  handle('mistakes.list', noArgs, () => svc().mistakes.listUnmastered())
  handle('mistakes.setMastered', z.tuple([z.string(), z.boolean()]), ([problemId, mastered]) => {
    svc().mistakes.setMastered(problemId, mastered)
    // v1.2：标记掌握 → 删除该题复习项（重新失败时重建，spec §2）
    if (mastered) svc().reviewSvc.onMistakeMastered(problemId)
    return undefined
  })

  // —— 统计 ——
  handle('stats.dashboard', noArgs, () => svc().stats.getDashboard())
  handle('stats.dashboardV2', noArgs, () => svc().stats.getDashboardV2(Date.now()))

  // —— 设置 ——
  handle('settings.get', noArgs, () => svc().settings.get())
  handle('settings.update', appSettingsPatchSchema, (patch) =>
    svc().settings.update(patch as Partial<AppSettings>)
  )

  // —— 学习路线（v1.2）——
  handle('learning.paths', noArgs, () => svc().learning.listPaths())
  handle('learning.pathDetail', z.string(), (id) => svc().learning.getPathProgress(id))
  handle('learning.allKps', noArgs, () => svc().learningRepo.listKnowledgePoints())
  handle('learning.kpProblems', z.string(), (kpId) => svc().learning.listKpProblems(kpId))
  handle('learning.problemKps', z.string(), (problemId) =>
    svc().learningRepo
      .knowledgePointIdsForProblem(problemId)
      .map((id) => svc().learningRepo.getKnowledgePoint(id))
      .filter((kp) => kp !== null)
  )
  handle('learning.bindProblem', z.tuple([z.string(), z.array(z.string())]), ([problemId, kpIds]) => {
    svc().learning.bindProblem(problemId, kpIds)
    return undefined
  })
  handle('learning.unbindProblem', z.tuple([z.string(), z.string()]), ([problemId, kpId]) => {
    svc().learning.unbindProblem(problemId, kpId)
    return undefined
  })

  // —— 错题复盘（v1.2）——
  handle('mistake.history', z.string(), (problemId) => svc().mistakeReview.getHistory(problemId))
  handle('mistake.firstLatestCode', z.string(), (problemId) =>
    svc().mistakeReview.firstAndLatestCode(problemId)
  )
  handle('mistake.notes.get', z.string(), (problemId) => svc().mistakeReview.getNote(problemId))
  handle('mistake.notes.set', z.tuple([z.string(), z.string().max(100_000)]), ([problemId, note]) =>
    svc().mistakeReview.setNote(problemId, note, Date.now())
  )
  handle('mistake.setCategory', z.tuple([z.string(), z.string().max(30)]), ([problemId, category]) => {
    svc().mistakeReview.setCategory(problemId, category as ErrorCategory, Date.now())
    return undefined
  })
  handle('mistake.latestCategory', z.string(), (problemId) =>
    svc().mistakeReview.latestCategory(problemId)
  )

  // —— 间隔复习（v1.2）——
  handle('review.today', noArgs, () => svc().reviewSvc.todayOverview(Date.now()))
  handle('review.startSession', z.number().int().min(5).max(20), (size) =>
    svc().reviewSvc.startSession(size, Date.now())
  )
  handle('review.getSession', z.string(), (id) => {
    const session = svc().reviewSvc.sessions.getSession(id)
    if (session === null) throw new AppError('not_found', `复习会话不存在: ${id}`)
    return session
  })
  handle('review.latestActive', noArgs, () => svc().reviewSvc.sessions.getLatestActive('review'))
  handle('review.lastFinished', noArgs, () => svc().reviewSvc.lastFinishedSession(Date.now()))
  handle(
    'review.finishSession',
    z.tuple([z.string(), z.record(z.string(), z.enum(['again', 'hard', 'good', 'easy']))]),
    ([sessionId, grades]) => svc().reviewSvc.finishSession(sessionId, grades, Date.now())
  )
  handle('review.cancelSession', z.string(), (id) => {
    svc().reviewSvc.sessions.finish(id, Date.now())
    return undefined
  })

  // —— 掌握度（v1.2）——
  // P1-B：读路径走 effective 状态（45 天无活动 mastered → familiar，读时计算不写库）
  handle('mastery.list', noArgs, () => svc().masterySvc.list(Date.now()))
  handle('mastery.recalc', noArgs, () => {
    svc().masterySvc.recalcAll(Date.now())
    return undefined
  })

  // —— 练习会话（v1.2）——
  handle('sessions.createRandom', z.unknown(), (input) => {
    const parsed = randomSessionConfigSchema.parse(input)
    return svc().practiceSvc.createRandomSession(parsed, Date.now())
  })
  handle('sessions.createKp', z.tuple([z.string(), z.number().int().min(1).max(50)]), ([kpId, size]) =>
    svc().practiceSvc.createKpSession(kpId, size, Date.now())
  )
  handle('sessions.get', z.string(), (id) => {
    const s = svc().practiceSvc.getSession(id)
    if (s === null) throw new AppError('not_found', `会话不存在: ${id}`)
    return s
  })
  handle('sessions.summary', z.string(), (id) => svc().practiceSvc.summarize(id))
  handle('sessions.finish', z.string(), (id) => {
    svc().practiceSvc.sessions.finish(id, Date.now())
    return undefined
  })

  // —— 备份与恢复 v1.3（docs/V1_3_BACKUP_V2_SPEC.md §6）——
  // 路径只来自主进程 dialog，renderer 永远不传文件路径（纵深防御）；
  // 导出 = v2 NDJSON 流式（worker，内存 O(batch)）；恢复 = staging 原子切换（v1/v2 双兼容）。
  // pending 状态与 swap 编排集中在 RestoreCoordinator；进度经 backup.getRestoreStatus 轮询。

  const backupDeps = (): RestoreDeps => ({
    dataDir: getDataDir(),
    appVersion: app.getVersion(),
    dbPath: join(getDataDir(), 'cuincodebench.db'),
    onRestored: () => {
      // 恢复后 renderer 全量重载（重新拉取所有业务数据）
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload()
    },
    postRestoreMigrate: () => {
      // v1 备份可能携带位置型知识点 id：恢复后强制重跑 seed 迁移（幂等，见 v1.2.1 P1）
      const seed = loadLearningPathSeed(
        resolveLearningSeedFile(app.isPackaged, app.getAppPath(), process.resourcesPath)
      )
      if (seed !== null) ensureLearningSeed(new LearningRepository(getServices().db), seed)
      else logger.warn('恢复后跳过内置内容 id 迁移：种子文件缺失', '')
    }
  })

  /** v2 记录计数 → UI 展示键（与 v1 摘要同形，SettingsView 无需分叉） */
  const displayCounts = (recordCounts: Record<string, number>): Record<string, number> => ({
    problems: recordCounts['problem'] ?? 0,
    submissions: recordCounts['submission'] ?? 0,
    errorRecords: recordCounts['error_record'] ?? 0,
    mistakeBook: recordCounts['mistake_book'] ?? 0,
    mistakeNotes: recordCounts['mistake_note'] ?? 0,
    mastery: recordCounts['mastery'] ?? 0,
    reviewItems: recordCounts['review_item'] ?? 0,
    reviewHistory: recordCounts['review_history'] ?? 0,
    practiceSessions: recordCounts['practice_session'] ?? 0
  })

  let exporting = false

  handle('backup.export', noArgs, () => {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return dialog
      .showSaveDialog({
        title: '导出完整备份',
        defaultPath: `CuinCodeBench-Backup-${stamp}.ccbbackup`,
        filters: [
          { name: 'CuinCodeBench 备份', extensions: ['ccbbackup'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      .then(async (ret) => {
        if (ret.canceled || ret.filePath === undefined) return { canceled: true as const }
        if (exporting) throw new AppError('busy', '已有导出正在进行，请稍候')
        exporting = true
        const job = startJob(
          {
            kind: 'export',
            dbPath: join(getDataDir(), 'cuincodebench.db'),
            outPath: ret.filePath,
            appVersion: app.getVersion()
          },
          { onProgress: () => {} } // 进度经 backup.getRestoreStatus 轮询
        )
        return job.promise
          .then((result) => {
            if (result.export === undefined) throw new AppError('internal', '导出失败：未知结果')
            const counts: Record<string, number> = {
              ...displayCounts(result.export.counts),
              total: Object.values(result.export.counts).reduce((n, v) => n + (v ?? 0), 0)
            }
            return {
              canceled: false as const,
              path: ret.filePath ?? '',
              counts
            }
          })
          .finally(() => {
            exporting = false
          })
      })
  })

  handle('backup.importPreview', noArgs, () =>
    dialog
      .showOpenDialog({
        title: '导入完整备份',
        filters: [
          { name: 'CuinCodeBench 备份', extensions: ['ccbbackup', 'json'] },
          { name: '全部文件', extensions: ['*'] }
        ],
        properties: ['openFile']
      })
      .then(async (ret) => {
        if (ret.canceled || ret.filePaths.length === 0) return { canceled: true as const }
        const path = ret.filePaths[0] ?? ''
        const p = await previewRestore(path)
        return {
          canceled: false as const,
          fileName: path.replace(/\\/g, '/').split('/').pop() ?? path,
          summary: p.summary
        }
      })
      .catch((err: unknown) => {
        cancelPendingRestore()
        throw err
      })
  )

  handle('backup.confirmRestore', noArgs, () => confirmRestore(backupDeps()))

  handle('backup.cancelImport', noArgs, () => {
    cancelPendingRestore()
    return undefined
  })

  handle('backup.getRestoreStatus', noArgs, () => ({
    ...getRestoreStatus(),
    exporting
  }))
}
