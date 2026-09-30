import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { LspServer } from '../src/main/lsp/lsp-server'
import { encodeRpcMessage, RpcDecoder, RpcProtocolError } from '../src/main/lsp/jsonrpc'
import { mapCompletions, mapDiagnostics, mapHover, uriToPath } from '../src/main/lsp/lsp-mapping'
import { collectFallbackDiagnostics, fallbackAvailable, listSourceFiles, parseGccDiagnosticLines } from '../src/main/lsp/fallback-diagnostics'
import { overridePyrightEntry, resolvePyrightEntry } from '../src/main/lsp/pyright-resolve'
import type { Toolchain } from '../src/shared/types'

/**
 * v1.4 P3：LspServer（真实子进程 + 桩语言服务器）与纯映射层单测。
 * 桩服务器见 tests/fixtures/stub-langserver.mjs（行为由文档内容驱动）。
 */

const stubEntry = join(__dirname, 'fixtures', 'stub-langserver.mjs')

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ccb-lsp-server-'))
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error(`等待超时：${what}`))
      setTimeout(tick, 25)
    }
    tick()
  })
}

describe('LspServer（真实子进程）', () => {
  it('start 握手 → completion/hover 请求往返', async () => {
    const dir = tempDir()
    const server = await LspServer.start({
      program: process.execPath,
      args: [stubEntry],
      rootUri: pathToFileURL(dir).href,
      serverName: 'stub'
    })
    try {
      const completion = await server.request('textDocument/completion', {
        textDocument: { uri: pathToFileURL(join(dir, 'main.py')).href },
        position: { line: 0, character: 0 }
      })
      const items = mapCompletions(completion)
      expect(items.map((i) => i.label)).toEqual(['stub_alpha', 'stub_beta'])

      const hover = mapHover(await server.request('textDocument/hover', {
        textDocument: { uri: pathToFileURL(join(dir, 'main.py')).href },
        position: { line: 0, character: 0 }
      }))
      expect(hover).toEqual({ contents: '**桩** hover 内容', isMarkdown: true })
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('didOpen 含错误标记 → 收到 publishDiagnostics 通知', async () => {
    const dir = tempDir()
    const notifications: { method: string; params: unknown }[] = []
    const server = await LspServer.start({
      program: process.execPath,
      args: [stubEntry],
      rootUri: pathToFileURL(dir).href,
      serverName: 'stub',
      onNotification: (method, params) => notifications.push({ method, params })
    })
    try {
      const uri = pathToFileURL(join(dir, 'main.py')).href
      server.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text: 'STUB_ERROR\nx = 1\n' }
      })
      await waitFor(() => notifications.some((n) => n.method === 'textDocument/publishDiagnostics'), 5_000, '诊断通知')
      const note = notifications.find((n) => n.method === 'textDocument/publishDiagnostics')
      const diags = (note?.params as { diagnostics: { severity: number; message: string }[] }).diagnostics
      expect(diags.length).toBe(1)
      expect(diags[0]?.severity).toBe(1)
      expect(String(diags[0]?.message)).toContain('stub:')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('崩溃（非主动关闭）触发 onExit；close() 不触发', async () => {
    const dir = tempDir()
    let exits = 0
    const server = await LspServer.start({
      program: process.execPath,
      args: [stubEntry],
      rootUri: pathToFileURL(dir).href,
      serverName: 'stub',
      onExit: () => {
        exits += 1
      }
    })
    try {
      const uri = pathToFileURL(join(dir, 'main.py')).href
      server.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text: 'CRASH_SERVER\n' }
      })
      await waitFor(() => exits === 1, 5_000, '崩溃 onExit')
      // 退出后请求应拒绝（pending 全部失败）
      await expect(
        server.request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } }, 1_000)
      ).rejects.toThrow()
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('请求超时拒绝', async () => {
    const dir = tempDir()
    // STUB_SLOW=1：completion 延迟 2s；超时设 100ms
    const server = await LspServer.start({
      program: process.execPath,
      args: [stubEntry],
      env: { STUB_SLOW: '1' },
      rootUri: pathToFileURL(dir).href,
      serverName: 'stub-slow'
    })
    try {
      await expect(
        server.request('textDocument/completion', {
          textDocument: { uri: pathToFileURL(join(dir, 'main.py')).href },
          position: { line: 0, character: 0 }
        }, 100)
      ).rejects.toThrow('超时')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('jsonrpc 纯编解码', () => {
  it('分块跨界解码多条消息', () => {
    const m1 = encodeRpcMessage({ jsonrpc: '2.0', id: 1, method: 'a' })
    const m2 = encodeRpcMessage({ jsonrpc: '2.0', method: 'b', params: { x: '中文' } })
    const d = new RpcDecoder()
    const all = Buffer.concat([m1, m2])
    // 逐 3 字节喂入（极端分块）
    const out = []
    for (let i = 0; i < all.length; i += 3) {
      out.push(...d.feed(all.subarray(i, Math.min(i + 3, all.length))))
    }
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'a' })
    expect(out[1]).toEqual({ jsonrpc: '2.0', method: 'b', params: { x: '中文' } })
  })

  it('头部缺失 Content-Length 抛协议错误', () => {
    const d = new RpcDecoder()
    expect(() => d.feed(Buffer.from('X-Headers: 1\r\n\r\n{}'))).toThrow(RpcProtocolError)
  })

  it('JSON 体损坏抛协议错误', () => {
    const d = new RpcDecoder()
    const bad = Buffer.from('Content-Length: 4\r\n\r\nnot{')
    expect(() => d.feed(bad)).toThrow(RpcProtocolError)
  })

  it('超长消息拒绝编码', () => {
    expect(() => encodeRpcMessage({ big: 'x'.repeat(17 * 1024 * 1024) })).toThrow(RpcProtocolError)
  })
})

describe('lsp-mapping 纯函数', () => {
  it('severity 映射（1/2/3/4/缺省）', () => {
    const mk = (severity?: number) => ({
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
      ...(severity !== undefined ? { severity } : {}),
      message: 'm'
    })
    const out = mapDiagnostics([mk(1), mk(2), mk(3), mk(4), mk(undefined)], 'gcc')
    expect(out.map((d) => d.severity)).toEqual(['error', 'warning', 'info', 'info', 'info'])
    expect(out[0]).toMatchObject({ line: 1, col: 2, endLine: 1, endCol: 4, source: 'gcc' })
  })

  it('completion：数组 / CompletionList / null 三形态', () => {
    expect(mapCompletions([{ label: 'a' }])).toEqual([{ label: 'a', insertText: 'a' }])
    expect(mapCompletions({ items: [{ label: 'b', textEdit: { newText: 'bb' } }] })).toEqual([
      { label: 'b', insertText: 'bb' }
    ])
    expect(mapCompletions(null)).toEqual([])
    // 超 50 项截断
    expect(mapCompletions(Array.from({ length: 80 }, (_, i) => ({ label: `l${i}` })))).toHaveLength(50)
  })

  it('hover：MarkupContent / 字符串 / 混合数组 / null', () => {
    expect(mapHover({ contents: { kind: 'markdown', value: '**x**' } })).toEqual({ contents: '**x**', isMarkdown: true })
    expect(mapHover({ contents: 'plain text' })).toEqual({ contents: 'plain text', isMarkdown: false })
    expect(mapHover({ contents: ['a', { kind: 'plaintext', value: 'b' }] })).toEqual({
      contents: 'a\n\nb',
      isMarkdown: false
    })
    expect(mapHover(null)).toBeNull()
    expect(mapHover({ contents: '   ' })).toBeNull()
  })

  it('uriToPath：Windows 盘符 URI / 百分号解码 / 非 file URI', () => {
    expect(uriToPath('file:///D:/tmp/x/main.py')).toBe('D:\\tmp\\x\\main.py')
    expect(uriToPath('file:///D:/a%20b/c.py')).toContain('a b')
    expect(uriToPath('not-a-uri')).toBe('not-a-uri')
    // POSIX 形态 URI 在 win32 不是合法路径（无盘符）：fileURLToPath 抛错 → 原样返回
    expect(uriToPath('file:///tmp/x/main.py')).toBe('file:///tmp/x/main.py')
  })
})

describe('pyright 路径解析', () => {
  it('override 注入生效；null 视为不可用', () => {
    overridePyrightEntry('X:/fake/pyright.js')
    expect(resolvePyrightEntry()).toBe('X:/fake/pyright.js')
    overridePyrightEntry(null)
    expect(resolvePyrightEntry()).toBeNull()
    overridePyrightEntry(undefined)
  })
})

const gccToolchain: Toolchain = {
  id: 'gcc-c:x',
  languageIds: ['c'],
  kind: 'gcc-c',
  program: 'gcc.exe',
  version: 'test',
  source: 'path'
}

describe('fallback-diagnostics', () => {
  it('parseGccDiagnosticLines 只匹配带 severity 的行', () => {
    const out = parseGccDiagnosticLines(
      'In file included from main.c:1:0:\nmain.c:3:11: error: expected expression before \';\' token\nmain.c:5:1: warning: unused variable'
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ file: 'main.c', line: 3, col: 11, severity: 'error' })
    expect(out[1]?.severity).toBe('warning')
  })

  it('listSourceFiles 按语言过滤并递归', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-fb-'))
    try {
      writeFileSync(join(dir, 'main.c'), 'int main(){}')
      writeFileSync(join(dir, 'util.cpp'), '')
      writeFileSync(join(dir, 'util.h'), '')
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'deep.c'), '')
      expect(listSourceFiles(dir, 'c')).toEqual(['main.c', 'sub/deep.c'])
      expect(listSourceFiles(dir, 'cpp')).toEqual(['util.cpp'])
      expect(listSourceFiles(dir, 'python')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('collectFallbackDiagnostics：gcc 输出映射；python JSON 映射；MSVC 无回退', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccb-fb2-'))
    try {
      writeFileSync(join(dir, 'main.c'), 'int main(){}')
      writeFileSync(join(dir, 'main.py'), 'x = \n')
      // 桩执行器：对 .c 文件返回固定 gcc 诊断
      const gccStub = (_p: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
        Promise.resolve({
          stdout: '',
          stderr: `${args[args.length - 1]}:2:5: error: expected expression before ';' token\n`
        })
      const result = await collectFallbackDiagnostics('c', dir, gccToolchain, gccStub)
      expect(result.get('main.c')).toEqual([
        { line: 1, col: 4, endLine: 1, endCol: 5, severity: 'error', message: "expected expression before ';' token", source: 'gcc' }
      ])

      // python：JSON 输出（pycheck 助手按文件逐一执行）
      const pyToolchain: Toolchain = { ...gccToolchain, languageIds: ['python'], kind: 'python', program: 'python.exe' }
      const pyStub = (): Promise<{ stdout: string; stderr: string }> =>
        Promise.resolve({
          stdout: '{"ok": false, "diagnostics": [{"line": 1, "col": 3, "message": "SyntaxError: invalid syntax"}]}',
          stderr: ''
        })
      const pyResult = await collectFallbackDiagnostics('python', dir, pyToolchain, pyStub, 'fake-pycheck.py')
      expect(pyResult.get('main.py')).toEqual([
        { line: 1, col: 3, endLine: 1, endCol: 4, severity: 'error', message: 'SyntaxError: invalid syntax', source: 'python' }
      ])

      // MSVC 无回退
      const msvc: Toolchain = { ...gccToolchain, kind: 'msvc-c' }
      expect(fallbackAvailable('c', msvc)).toBe(false)
      const none = (): Promise<{ stdout: string; stderr: string }> => Promise.resolve({ stdout: '', stderr: '' })
      expect((await collectFallbackDiagnostics('c', dir, msvc, none)).size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
