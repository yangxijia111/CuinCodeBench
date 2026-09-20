import { app } from 'electron'
import { z } from 'zod'
import { problemQuerySchema, submissionQuerySchema, appSettingsPatchSchema } from '@shared/schemas'
import type { AppSettings } from '@shared/types'
import { handle, getDataDir, AppError } from './index'
import { getServices } from '../services'

/**
 * IPC 通道注册总入口：按模块拆分，全部走 zod 校验 + 统一错误信封。
 * toolchains / run / judge 通道在 P3/P4 阶段追加。
 */

const noArgs = z.unknown()

export function registerIpcHandlers(): void {
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
    return undefined
  })

  // —— 统计 ——
  handle('stats.dashboard', noArgs, () => svc().stats.getDashboard())

  // —— 设置 ——
  handle('settings.get', noArgs, () => svc().settings.get())
  handle('settings.update', appSettingsPatchSchema, (patch) =>
    svc().settings.update(patch as Partial<AppSettings>)
  )
}
