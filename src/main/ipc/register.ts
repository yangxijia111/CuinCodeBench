import { app, dialog } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { z } from 'zod'
import {
  problemQuerySchema,
  runOnceInputSchema,
  judgeSubmitSchema,
  submissionQuerySchema,
  appSettingsPatchSchema,
  backupJsonTextSchema
} from '@shared/schemas'
import type { AppSettings } from '@shared/types'
import { handle, getDataDir, AppError } from './index'
import { getServices } from '../services'
import { BackupService, type BackupSummary } from '../services/backup-service'
import type { ToolchainService } from '../services/toolchain-service'
import type { JudgeService } from '../services/judge-service'
import { logger } from '../lib/logger'

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
  handle('mastery.list', noArgs, () => svc().mastery.listAll())
  handle('mastery.recalc', noArgs, () => {
    svc().masterySvc.recalcAll(Date.now())
    return undefined
  })

  // —— 备份与恢复（docs/V1_2_BACKUP_SPEC.md §6）——
  // 路径只来自主进程 dialog，renderer 永远不传文件路径（纵深防御）；
  // pendingImport 缓存在主进程内存，confirmRestore 时二次校验文件 mtime 防调包。
  const backup = (): BackupService => new BackupService(svc().db)

  let pendingImport: { path: string; mtimeMs: number; summary: BackupSummary } | null = null

  handle('backup.export', noArgs, () => {
    const { json, counts } = backup().exportJson(app.getVersion())
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return dialog
      .showSaveDialog({
        title: '导出完整备份',
        defaultPath: `CuinCodeBench-Backup-${stamp}.json`,
        filters: [{ name: 'CuinCodeBench 备份', extensions: ['json'] }]
      })
      .then((ret) => {
        if (ret.canceled || ret.filePath === undefined) return { canceled: true as const }
        writeFileSync(ret.filePath, json, 'utf-8')
        return { canceled: false as const, path: ret.filePath, counts }
      })
  })

  handle('backup.importPreview', noArgs, () =>
    dialog
      .showOpenDialog({
        title: '导入完整备份',
        filters: [{ name: 'CuinCodeBench 备份', extensions: ['json'] }, { name: '全部文件', extensions: ['*'] }],
        properties: ['openFile']
      })
      .then((ret) => {
        if (ret.canceled || ret.filePaths.length === 0) return { canceled: true as const }
        const path = ret.filePaths[0] ?? ''
        const stat = statSync(path)
        const text = readFileSync(path, 'utf-8')
        const parsed = backupJsonTextSchema.parse(text)
        const { summary } = backup().validate(parsed)
        pendingImport = { path, mtimeMs: stat.mtimeMs, summary }
        return {
          canceled: false as const,
          fileName: path.replace(/\\/g, '/').split('/').pop() ?? path,
          summary
        }
      })
      .catch((err: unknown) => {
        pendingImport = null
        // zod 校验失败（ZodError 带 issues 数组，与 ipc/index.ts 同一识别方式）
        if (
          err !== null &&
          typeof err === 'object' &&
          'issues' in err &&
          Array.isArray(err.issues)
        ) {
          const issues = err.issues as { path: (string | number)[]; message: string }[]
          const detail = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          throw new AppError('validation', `备份内容校验失败：${detail.slice(0, 500)}`)
        }
        throw err
      })
  )

  handle('backup.confirmRestore', noArgs, () => {
    const pending = pendingImport
    if (pending === null) {
      throw new AppError('validation', '没有待恢复的备份：请重新选择备份文件')
    }
    // 二次校验：文件仍在且未被替换（预览 → 确认之间防调包）
    if (!existsSync(pending.path)) {
      pendingImport = null
      throw new AppError('validation', '备份文件已不存在，请重新选择')
    }
    const mtime = statSync(pending.path).mtimeMs
    if (Math.abs(mtime - pending.mtimeMs) > 1) {
      pendingImport = null
      throw new AppError('validation', '备份文件在确认前被修改，已取消恢复；请重新导入')
    }
    const { envelope, summary } = backup().validate(
      backupJsonTextSchema.parse(readFileSync(pending.path, 'utf-8'))
    )
    const res = backup().restore(envelope)
    pendingImport = null
    logger.info('备份恢复完成', `problems=${summary.counts.problems} submissions=${summary.counts.submissions}`)
    return res
  })

  handle('backup.cancelImport', noArgs, () => {
    pendingImport = null
    return undefined
  })
}
