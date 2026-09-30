import { contextBridge, ipcRenderer } from 'electron'
import type { AppApi, IpcResult } from '../shared/ipc'
import { LSP_DIAGNOSTICS_CHANNEL } from '../shared/ipc'
import type { LspDiagnosticsEvent } from '../shared/types'

/**
 * preload：经 contextBridge 暴露白名单 API（security §3.6）。
 * 实现 AppApi 接口；每个方法对应一条 invoke 通道。
 * 唯一例外：onLspDiagnostics（v1.4 事件订阅，受控白名单通道，返回退订函数）。
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

const api: AppApi = {
  getAppInfo: () => invoke('app.getInfo'),

  listProblems: (query) => invoke('problems.list', query),
  getProblem: (id) => invoke('problems.get', id),
  createProblem: (input) => invoke('problems.create', input),
  updateProblem: (id, input) => invoke('problems.update', id, input),
  deleteProblem: (id) => invoke('problems.delete', id),
  listTags: () => invoke('problems.listTags'),
  exportProblems: (ids) => invoke('problems.export', ids),
  importProblems: (jsonText) => invoke('problems.import', jsonText),

  detectToolchains: (force) => invoke('toolchains.detect', force),

  runOnce: (input) => invoke('run.once', input),
  judgeSubmit: (problemId, language, code) => invoke('judge.submit', problemId, language, code),

  listSubmissions: (query) => invoke('history.list', query),
  getSubmissionDetail: (id) => invoke('history.detail', id),
  getProblemStats: (problemId) => invoke('history.problemStats', problemId),

  listMistakes: () => invoke('mistakes.list'),
  setMistakeMastered: (problemId, mastered) => invoke('mistakes.setMastered', problemId, mastered),

  createRandomSession: (config) => invoke('sessions.createRandom', config),
  createKpSession: (kpId, size) => invoke('sessions.createKp', [kpId, size]),
  getSession: (id) => invoke('sessions.get', id),
  getSessionSummary: (id) => invoke('sessions.summary', id),
  finishSession: (id) => invoke('sessions.finish', id),

  getMistakeHistory: (problemId) => invoke('mistake.history', problemId),
  getMistakeFirstLatestCode: (problemId) => invoke('mistake.firstLatestCode', problemId),
  getMistakeNote: (problemId) => invoke('mistake.notes.get', problemId),
  setMistakeNote: (problemId, note) => invoke('mistake.notes.set', [problemId, note]),
  setMistakeCategory: (problemId, category) => invoke('mistake.setCategory', [problemId, category]),
  getMistakeLatestCategory: (problemId) => invoke('mistake.latestCategory', problemId),

  getDashboardStats: () => invoke('stats.dashboard'),
  getDashboardV2Stats: () => invoke('stats.dashboardV2'),

  getSettings: () => invoke('settings.get'),
  updateSettings: (patch) => invoke('settings.update', patch),

  listLearningPaths: () => invoke('learning.paths'),
  getLearningPathDetail: (pathId) => invoke('learning.pathDetail', pathId),
  listAllKnowledgePoints: () => invoke('learning.allKps'),
  listKpProblems: (kpId) => invoke('learning.kpProblems', kpId),
  getProblemKnowledgePoints: (problemId) => invoke('learning.problemKps', problemId),
  bindProblemKnowledgePoints: (problemId, kpIds) => invoke('learning.bindProblem', [problemId, kpIds]),
  unbindProblemKnowledgePoint: (problemId, kpId) => invoke('learning.unbindProblem', [problemId, kpId]),

  listMastery: () => invoke('mastery.list'),
  recalcMastery: () => invoke('mastery.recalc'),

  getReviewToday: () => invoke('review.today'),
  startReviewSession: (size) => invoke('review.startSession', size),
  getReviewSession: (id) => invoke('review.getSession', id),
  getLatestActiveReviewSession: () => invoke('review.latestActive'),
  getLastFinishedReviewSession: () => invoke('review.lastFinished'),
  finishReviewSession: (sessionId, grades) => invoke('review.finishSession', [sessionId, grades]),
  cancelReviewSession: (id) => invoke('review.cancelSession', id),

  exportBackup: () => invoke('backup.export'),
  importBackupPreview: () => invoke('backup.importPreview'),
  confirmBackupRestore: () => invoke('backup.confirmRestore'),
  cancelBackupImport: () => invoke('backup.cancelImport'),
  getBackupStatus: () => invoke('backup.getRestoreStatus'),

  onLspDiagnostics: (cb) => {
    const listener = (_event: unknown, payload: LspDiagnosticsEvent): void => cb(payload)
    ipcRenderer.on(LSP_DIAGNOSTICS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(LSP_DIAGNOSTICS_CHANNEL, listener)
    }
  },

  workspaceOpen: (problemId, language, draft) => invoke('workspace.open', [problemId, language, draft]),
  workspaceSync: (problemId, language, changed, removed) =>
    invoke('workspace.sync', [problemId, language, changed, removed]),
  workspaceReset: (problemId, language) => invoke('workspace.reset', [problemId, language]),

  lspStatus: () => invoke('lsp.status'),
  lspComplete: (problemId, language, path, line, col, content) =>
    invoke('lsp.complete', [problemId, language, path, line, col, content]),
  lspHover: (problemId, language, path, line, col, content) =>
    invoke('lsp.hover', [problemId, language, path, line, col, content])
}

contextBridge.exposeInMainWorld('api', api)
