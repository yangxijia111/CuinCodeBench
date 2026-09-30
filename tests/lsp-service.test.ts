import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Toolchain, LspCompletionItem, LspDiagnosticsEvent } from '@shared/types'
import type { ToolchainService } from '../src/main/services/toolchain-service'
import { LspService } from '../src/main/services/lsp-service'
import type { FallbackRunCommand } from '../src/main/lsp/fallback-diagnostics'
import { overridePyrightEntry } from '../src/main/lsp/pyright-resolve'
import { overrideClangdPath } from '../src/main/lsp/clangd-detect'

/**
 * v1.4 P3：LspService 编排（docs/V1_4_DESIGN.md §2/§3）。
 * 用桩语言服务器（fixtures/stub-langserver.mjs，经 overridePyrightEntry 注入）
 * 驱动真实子进程：启动/工作区挂载/诊断推送/补全/崩溃退避重启/降级回退链。
 */

const stubEntry = join(__dirname, 'fixtures', 'stub-langserver.mjs')

const gccToolchain: Toolchain = {
  id: 'gcc-c:x',
  languageIds: ['c'],
  kind: 'gcc-c',
  program: 'gcc.exe',
  version: 'test',
  source: 'path'
}

function fakeToolchains(toolchain: Toolchain | null): ToolchainService {
  return { select: () => Promise.resolve(toolchain) } as unknown as ToolchainService
}

const services: LspService[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const s of services.splice(0)) s.shutdown()
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  overridePyrightEntry(undefined)
  overrideClangdPath(undefined)
})

function makeHarness(toolchain: Toolchain | null, runCommand?: FallbackRunCommand): {
  service: LspService
  events: LspDiagnosticsEvent[]
  dir: string
} {
  const events: LspDiagnosticsEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'ccb-lspsvc-'))
  tempDirs.push(dir)
  const service = new LspService({
    toolchains: fakeToolchains(toolchain),
    settings: () => ({}),
    pushEvent: (e) => events.push(e),
    ...(runCommand !== undefined ? { runCommand } : {}),
    restartBaseMs: 1,
    fallbackDebounceMs: 5
  })
  services.push(service)
  return { service, events, dir }
}

type Awaitable<V> = V | Promise<V>

function waitFor<T>(predicate: () => Awaitable<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  const tick = async (): Promise<T> => {
    const hit = await predicate()
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 20))
    return tick()
  }
  return tick()
}

describe('LspService 编排（桩语言服务器）', () => {
  it('openWorkspace 启动服务器；错误文件 → 诊断推送到 renderer；补全/hover 往返', async () => {
    overridePyrightEntry(stubEntry)
    const h = makeHarness(null)
    await h.service.openWorkspace('p1', 'python', h.dir, [{ path: 'main.py', content: 'STUB_ERROR 第一行\n' }])
    const event = await waitFor(
      () => h.events.find((e) => e.path === 'main.py' && e.diagnostics.length > 0),
      10_000,
      '诊断推送'
    )
    expect(event).toMatchObject({ problemId: 'p1', language: 'python', path: 'main.py' })
    expect(event.diagnostics[0]).toMatchObject({ severity: 'error', line: 0, col: 0 })
    expect(String(event.diagnostics[0]?.message)).toContain('stub:')

    const items = await h.service.requestCompletion('p1', 'python', h.dir, 'main.py', 0, 0, 'STUB_ERROR 第一行\n')
    expect(items.map((i) => i.label)).toEqual(['stub_alpha', 'stub_beta'])

    const hover = await h.service.requestHover('p1', 'python', h.dir, 'main.py', 0, 0, 'STUB_ERROR 第一行\n')
    expect(hover).toEqual({ contents: '**桩** hover 内容', isMarkdown: true })

    const st = await h.service.status()
    expect(st.python).toEqual({ server: 'pyright', state: 'ready' })
  }, 30_000)

  it('补全携带最新内容（didChange 先行）：内容变更后请求仍成功', async () => {
    overridePyrightEntry(stubEntry)
    const h = makeHarness(null)
    await h.service.openWorkspace('p1', 'python', h.dir, [{ path: 'main.py', content: 'ok\n' }])
    // 编辑后立即补全（防抖窗口内）：应携带新内容 didChange 而非旧文本
    const items = await h.service.requestCompletion('p1', 'python', h.dir, 'main.py', 1, 0, 'x = 1\nprint(x)\n')
    expect(items.length).toBeGreaterThan(0)
  }, 30_000)

  it('崩溃 → 退避重启（新进程重挂工作区）→ 再次可用', async () => {
    overridePyrightEntry(stubEntry)
    const h = makeHarness(null)
    await h.service.openWorkspace('p1', 'python', h.dir, [{ path: 'main.py', content: 'ok\n' }])
    // 触发崩溃：didOpen 内容含 CRASH_SERVER
    h.service.syncDocs('p1', 'python', h.dir, [{ path: 'main.py', content: 'CRASH_SERVER\n' }], [])
    await new Promise((r) => setTimeout(r, 200)) // 等崩溃与退避重启落地
    // 重启后（新进程）重放 docs，恢复正常内容即可继续补全
    const items = await waitFor<LspCompletionItem[]>(
      () => {
        const pending = h.service.requestCompletion('p1', 'python', h.dir, 'main.py', 0, 0, 'ok\n')
        return pending.then((r) => (r.length > 0 ? r : undefined))
      },
      15_000,
      '重启后补全恢复'
    )
    expect(items.length).toBeGreaterThan(0)
    const st = await h.service.status()
    expect(st.python).toEqual({ server: 'pyright', state: 'ready' })
  }, 45_000)

  it('无 LSP → 编译器回退诊断接管（含清空旧诊断）', async () => {
    overridePyrightEntry(null) // pyright 不可用 → 直接回退
    let runCount = 0
    const fakeRun: FallbackRunCommand = (_program, args) => {
      runCount += 1
      return Promise.resolve(
        runCount <= 1
          ? { stdout: '', stderr: `${args[args.length - 1]}:2:5: error: expected expression\n` }
          : { stdout: '', stderr: '' }
      )
    }
    const h = makeHarness(gccToolchain, fakeRun)
    // 回退诊断读磁盘工作区（生产中 WorkspaceService 先写盘，此处模拟）
    writeFileSync(join(h.dir, 'main.c'), 'int main(){}\n')
    await h.service.openWorkspace('p1', 'c', h.dir, [{ path: 'main.c', content: 'int main(){}\n' }])
    const errEvent = await waitFor(
      () => h.events.find((e) => e.path === 'main.c' && e.diagnostics.length > 0),
      5_000,
      '回退诊断'
    )
    expect(errEvent.diagnostics[0]).toMatchObject({ severity: 'error', source: 'gcc' })
    const st = await h.service.status()
    expect(st.c).toEqual({ server: 'fallback', state: 'ready' })

    // 再次同步（回退执行器此时返回干净）→ 旧诊断被清空
    h.service.syncDocs('p1', 'c', h.dir, [{ path: 'main.c', content: 'int main(){return 0;}\n' }], [])
    const clearEvent = await waitFor(
      () => h.events.find((e) => e.path === 'main.c' && e.diagnostics.length === 0 && e !== errEvent),
      5_000,
      '清空旧诊断'
    )
    expect(clearEvent.diagnostics).toEqual([])
  }, 30_000)

  it('status：无 LSP 无工具链 → none/degraded；有工具链无 LSP → fallback', async () => {
    overridePyrightEntry(null)
    const none = makeHarness(null)
    const stNone = await none.service.status()
    expect(stNone.python).toEqual({ server: 'none', state: 'degraded' })

    const fb = makeHarness(gccToolchain)
    const stFb = await fb.service.status()
    expect(stFb.c).toEqual({ server: 'fallback', state: 'ready' })
  })
})
