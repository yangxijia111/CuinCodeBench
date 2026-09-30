import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { registerTrustedSender, pushToTrustedWindows } from '../src/main/ipc/validate-sender'
import { lspDiagnosticsEventSchema } from '../src/shared/schemas'
import type { LspDiagnosticsEvent } from '../src/shared/types'

/**
 * v1.4 P2：main→renderer 事件推送基建（docs/V1_4_DESIGN.md §4）。
 * 目标注册表：只推给注册过的可信窗口；destroyed 移除；单窗口异常不阻断。
 * electron 依赖在 validate-sender 中仅 type-only，测试用桩对象驱动。
 */

interface FakeWindow {
  send: ReturnType<typeof vi.fn>
  destroyedCbs: Map<string, () => void>
  destroyed: boolean
}

function makeFakeWindow(): { fake: FakeWindow; wc: WebContents } {
  const fake: FakeWindow = {
    send: vi.fn(),
    destroyedCbs: new Map(),
    destroyed: false
  }
  const wc = {
    send: fake.send,
    once: (event: string, cb: () => void) => {
      fake.destroyedCbs.set(event, cb)
    },
    isDestroyed: () => fake.destroyed
  } as unknown as WebContents
  return { fake, wc }
}

const sampleEvent: LspDiagnosticsEvent = {
  problemId: 'p1',
  language: 'python',
  path: 'main.py',
  diagnostics: [{ line: 0, col: 4, endLine: 0, endCol: 8, severity: 'error', message: '未定义变量 x', source: 'pyright' }]
}

describe('pushToTrustedWindows', () => {
  it('推送 payload 符合事件契约 schema', () => {
    expect(() => lspDiagnosticsEventSchema.parse(sampleEvent)).not.toThrow()
  })

  it('注册过的窗口收到事件；未注册的不收', () => {
    const a = makeFakeWindow()
    const b = makeFakeWindow()
    registerTrustedSender(a.wc)
    pushToTrustedWindows('lsp.diagnostics', sampleEvent)
    expect(a.fake.send).toHaveBeenCalledExactlyOnceWith('lsp.diagnostics', sampleEvent)
    expect(b.fake.send).not.toHaveBeenCalled()
  })

  it('destroyed 后不再接收', () => {
    const a = makeFakeWindow()
    registerTrustedSender(a.wc)
    a.fake.destroyedCbs.get('destroyed')?.()
    pushToTrustedWindows('lsp.diagnostics', sampleEvent)
    expect(a.fake.send).not.toHaveBeenCalled()
  })

  it('isDestroyed=true（destroyed 事件竞态兜底）不发送且不抛错', () => {
    const a = makeFakeWindow()
    registerTrustedSender(a.wc)
    a.fake.destroyed = true
    expect(() => pushToTrustedWindows('lsp.diagnostics', sampleEvent)).not.toThrow()
    expect(a.fake.send).not.toHaveBeenCalled()
  })

  it('一个窗口 send 抛错不阻断其余窗口', () => {
    const bad = makeFakeWindow()
    const good = makeFakeWindow()
    bad.fake.send = vi.fn(() => {
      throw new Error('窗口已销毁')
    })
    registerTrustedSender(bad.wc)
    registerTrustedSender(good.wc)
    expect(() => pushToTrustedWindows('lsp.diagnostics', sampleEvent)).not.toThrow()
    expect(good.fake.send).toHaveBeenCalledExactlyOnceWith('lsp.diagnostics', sampleEvent)
  })
})
