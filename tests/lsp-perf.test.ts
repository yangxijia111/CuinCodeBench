import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { Toolchain } from '@shared/types'
import type { LspDiagnosticsEvent } from '@shared/types'
import type { ToolchainService } from '../src/main/services/toolchain-service'
import { LspService } from '../src/main/services/lsp-service'
import { overridePyrightEntry } from '../src/main/lsp/pyright-resolve'

/**
 * v1.4 P9 性能门槛（docs/V1_4_DESIGN.md §11）：
 * 内置 pyright 真实会话——冷启动至首个诊断、补全请求往返。
 * 门槛取宽松值（CI 共享 runner 噪声）：设计目标 <100ms 的补全在本地实测远低于此。
 */

const projectRoot = resolve(__dirname, '..')
const pyrightEntry = join(projectRoot, 'node_modules', 'pyright', 'langserver.index.js')
const hasPyright = existsSync(pyrightEntry)

const pyToolchain: Toolchain = {
  id: 'python:test',
  languageIds: ['python'],
  kind: 'python',
  program: 'python.exe',
  version: 'test',
  source: 'path'
}

const services: LspService[] = []
const dirs: string[] = []

afterEach(() => {
  for (const s of services.splice(0)) s.shutdown()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  overridePyrightEntry(undefined)
})

describe.skipIf(!hasPyright)('LSP 性能门槛（pyright 真实会话）', () => {
  it('冷启动 → 首个 error 诊断 < 15s', async () => {
    overridePyrightEntry(pyrightEntry)
    const dir = mkdtempSync(join(tmpdir(), 'ccb-lspperf-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'main.py'), 'def broken(:\n    pass\n', 'utf8')
    const events: LspDiagnosticsEvent[] = []
    const service = new LspService({
      toolchains: { select: () => Promise.resolve(null) } as unknown as ToolchainService,
      settings: () => ({}),
      pushEvent: (e) => events.push(e)
    })
    services.push(service)
    const t0 = Date.now()
    await service.openWorkspace('perf', 'python', dir, [{ path: 'main.py', content: 'def broken(:\n    pass\n' }])
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const hit = events.find((e) => e.path === 'main.py' && e.diagnostics.some((d) => d.severity === 'error'))
      if (hit !== undefined) {
        expect(Date.now() - t0).toBeLessThan(15_000)
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`15s 内未收到 error 诊断（事件数：${events.length}）`)
  }, 30_000)

  it('补全请求往返 < 2s（中位）', async () => {
    overridePyrightEntry(pyrightEntry)
    const dir = mkdtempSync(join(tmpdir(), 'ccb-lspperf2-'))
    dirs.push(dir)
    const service = new LspService({
      toolchains: { select: () => Promise.resolve(pyToolchain) } as unknown as ToolchainService,
      settings: () => ({}),
      pushEvent: () => {}
    })
    services.push(service)
    await service.openWorkspace('perf', 'python', dir, [
      { path: 'main.py', content: 'import os\nx = os.\n' }
    ])
    // 预热（首个补全含初始化分析）
    await service.requestCompletion('perf', 'python', dir, 'main.py', 1, 7, 'import os\nx = os.\n')
    const durations: number[] = []
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      const items = await service.requestCompletion('perf', 'python', dir, 'main.py', 1, 7, 'import os\nx = os.\n')
      durations.push(Date.now() - t0)
      expect(items.length).toBeGreaterThan(0)
    }
    durations.sort((a, b) => a - b)
    const median = durations[1] ?? durations[0] ?? 0
    expect(median).toBeLessThan(2_000)
  }, 30_000)
})
