import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, execSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { RpcDecoder, encodeRpcMessage, rpcRequest, rpcNotification, type RpcMessage } from '../src/main/lsp/jsonrpc'

/**
 * v1.4 P1 PoC：LSP 语言服务器真实验证（docs/V1_4_DESIGN.md §12 P1）。
 * 三项可行性验证：
 *  ① pyright（内置依赖）spawn + JSON-RPC 握手 + publishDiagnostics + completion 请求往返；
 *  ② clangd（检测到才跑，skipIf）握手 + compile_flags.txt 生效；
 *  ③ gcc -fsyntax-only 回退诊断输出格式可解析。
 * 本测试同时是 src/main/lsp/jsonrpc.ts 编解码器的真实子进程驱动用例。
 */

const projectRoot = resolve(__dirname, '..')
const pyrightEntry = join(projectRoot, 'node_modules', 'pyright', 'langserver.index.js')
const hasPyright = existsSync(pyrightEntry)

function hasClangd(): boolean {
  try {
    execSync('where clangd', { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}
const clangdPath = hasClangd()
  ? execSync('where clangd', { timeout: 5_000 })
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? null
  : null

const portableGcc = join(projectRoot, '.tools', 'w64devkit', 'bin', 'gcc.exe')
const hasGcc = existsSync(portableGcc)

interface Notification {
  method: string
  params: unknown
}

/** 最小 LSP 客户端会话（PoC 内联；生产实现见 P3 LspService） */
class LspSession {
  private readonly proc: ChildProcess
  private readonly decoder = new RpcDecoder()
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readonly notifications: Notification[] = []

  constructor(program: string, args: string[]) {
    this.proc = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      let messages: unknown[]
      try {
        messages = this.decoder.feed(chunk)
      } catch (err) {
        this.proc.kill()
        throw err
      }
      for (const raw of messages) this.handle(raw as RpcMessage)
    })
  }

  private handle(msg: RpcMessage): void {
    if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) {
      // server → client 请求：最小响应（pyright 的 workspace/configuration 等）
      const result =
        msg.method === 'workspace/configuration'
          ? Array.isArray((msg.params as { items?: unknown[] })?.items)
            ? ((msg.params as { items: unknown[] }).items.map(() => null))
            : []
          : null
      this.send({ jsonrpc: '2.0', id: msg.id, result })
      return
    }
    if (msg.id !== undefined && msg.id !== null) {
      if (msg.error !== undefined) {
        this.pending.get(Number(msg.id))?.reject(new Error(`LSP ${msg.method ?? ''} 错误: ${msg.error.message}`))
      } else {
        this.pending.get(Number(msg.id))?.resolve(msg.result)
      }
      this.pending.delete(Number(msg.id))
      return
    }
    if (msg.method !== undefined) this.notifications.push({ method: msg.method, params: msg.params })
  }

  send(message: unknown): void {
    this.proc.stdin!.write(encodeRpcMessage(message))
  }

  request(method: string, params: unknown): Promise<unknown> {
    const req = rpcRequest(method, params)
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject })
      this.send(req)
    })
  }

  notify(method: string, params: unknown): void {
    this.send(rpcNotification(method, params))
  }

  /** 等待首条满足条件的通知（轮询，超时抛错） */
  async waitForNotification(method: string, predicate: (n: Notification) => boolean, timeoutMs: number): Promise<Notification> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.notifications.find((n) => n.method === method && predicate(n))
      if (hit !== undefined) return hit
      if (Date.now() > deadline) {
        throw new Error(`等待通知 ${method} 超时（已收：${this.notifications.map((n) => n.method).join(',')}）`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  close(): void {
    this.proc.kill()
  }
}

/** 握手：initialize → initialized，返回 initialize 结果（server capabilities） */
async function handshake(session: LspSession, rootDir: string): Promise<Record<string, unknown>> {
  const result = (await session.request('initialize', {
    processId: null,
    rootUri: pathToFileURL(rootDir).href,
    workspaceFolders: [{ uri: pathToFileURL(rootDir).href, name: 'poc' }],
    capabilities: {
      textDocument: { synchronization: { dynamicRegistration: false } },
      workspace: { workspaceFolders: true }
    }
  })) as Record<string, unknown>
  session.notify('initialized', {})
  return result
}

/** LSP publishDiagnostics 参数的宽松类型 */
interface DiagnosticsParams {
  uri: string
  diagnostics: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string }[]
}

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ccb-lsp-poc-${prefix}-`))
}

describe.skipIf(!hasPyright)('PoC① pyright（内置语言服务器）', () => {
  it('握手 → didOpen 含错误文件 → 收到 publishDiagnostics（error 级）', async () => {
    const dir = tempWorkspace('pyright')
    try {
      const badCode = 'def f(:\n    pass\n\nx = undefined_variable\nprint(x)\n'
      const filePath = join(dir, 'main.py')
      writeFileSync(filePath, 'x = 0\n', 'utf8') // 磁盘占位（clangd 需要；pyright 以 didOpen 文本为准）
      const session = new LspSession(process.execPath, [pyrightEntry, '--stdio'])
      try {
        const caps = await handshake(session, dir)
        expect(caps['capabilities']).toBeTruthy()

        session.notify('textDocument/didOpen', {
          textDocument: { uri: pathToFileURL(filePath).href, languageId: 'python', version: 1, text: badCode }
        })
        const note = await session.waitForNotification(
          'textDocument/publishDiagnostics',
          (n) => (n.params as DiagnosticsParams).diagnostics.length > 0,
          20_000
        )
        const params = note.params as DiagnosticsParams
        const messages = params.diagnostics.map((d) => `${d.severity}:${d.message}`).join('\n')
        // 语法错误（error=1）必须出现；undefined variable 视配置可能为 1/2，不强绑
        expect(params.diagnostics.some((d) => d.severity === 1)).toBe(true)
        expect(messages).toBeTruthy()
      } finally {
        session.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 45_000)

  it('补全请求往返：import os 后 os. 处返回补全项', async () => {
    const dir = tempWorkspace('pyright-comp')
    try {
      const code = 'import os\nx = os.\n'
      const filePath = join(dir, 'main.py')
      writeFileSync(filePath, code, 'utf8')
      const session = new LspSession(process.execPath, [pyrightEntry, '--stdio'])
      try {
        await handshake(session, dir)
        session.notify('textDocument/didOpen', {
          textDocument: { uri: pathToFileURL(filePath).href, languageId: 'python', version: 1, text: code }
        })
        // 等诊断稳定（确保分析完成），再请求补全
        await session.waitForNotification('textDocument/publishDiagnostics', () => true, 20_000)
        const completion = (await session.request('textDocument/completion', {
          textDocument: { uri: pathToFileURL(filePath).href },
          position: { line: 1, character: 7 } // "x = os." 行末
        })) as { items?: { label: string }[] } | null
        const items = completion?.items ?? (completion as unknown as { label: string }[]) ?? []
        const labels = (Array.isArray(items) ? items : []).map((i) => i.label)
        expect(labels.length).toBeGreaterThan(0)
        // os 模块成员应出现（path / sep 等）
        expect(labels.some((l) => /path|sep|name/i.test(l))).toBe(true)
      } finally {
        session.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 45_000)
})

describe.skipIf(clangdPath === null)('PoC② clangd（检测到才跑）', () => {
  it('握手 + compile_flags.txt → didOpen 含错误 cpp → 诊断', async () => {
    const dir = tempWorkspace('clangd')
    try {
      writeFileSync(join(dir, 'compile_flags.txt'), '-std=c++17\n-Wall\n', 'utf8')
      const badCode = '#include <iostream>\nint main() {\n  int x = ;\n  returny 0;\n}\n'
      const filePath = join(dir, 'main.cpp')
      writeFileSync(filePath, badCode, 'utf8')
      const session = new LspSession(clangdPath!, ['--background-index=false', '--pch-storage=memory'])
      try {
        const caps = await handshake(session, dir)
        expect(caps['capabilities']).toBeTruthy()
        session.notify('textDocument/didOpen', {
          textDocument: { uri: pathToFileURL(filePath).href, languageId: 'cpp', version: 1, text: badCode }
        })
        const note = await session.waitForNotification(
          'textDocument/publishDiagnostics',
          (n) => (n.params as DiagnosticsParams).diagnostics.length > 0,
          30_000
        )
        const params = note.params as DiagnosticsParams
        expect(params.diagnostics.some((d) => d.severity === 1)).toBe(true)
        expect(params.diagnostics.some((d) => /expected/.test(d.message))).toBe(true)
      } finally {
        session.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(!hasGcc)('PoC③ gcc -fsyntax-only 回退诊断格式', () => {
  it('stderr 输出可按 file:line:col: severity: message 解析', () => {
    const dir = tempWorkspace('gccfb')
    try {
      const badCode = 'int main() {\n  int x = ;\n  return 0;\n}\n'
      const filePath = join(dir, 'main.c')
      writeFileSync(filePath, badCode, 'utf8')
      // 捕获真实 gcc 诊断输出（数组参数 spawn，不经 shell；-fdiagnostics-color=never 确保无 ANSI 色码）
      const res = spawnSync(portableGcc, ['-fsyntax-only', '-fdiagnostics-color=never', '-std=c11', '-Wall', filePath], {
        encoding: 'utf8',
        timeout: 15_000
      })
      const out = `${res.stderr ?? ''}${res.stdout ?? ''}`
      // file:line:col: severity: message
      const re = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/gm
      const matches = [...out.matchAll(re)]
      expect(matches.length).toBeGreaterThan(0)
      const first = matches[0]
      expect(first).toBeDefined()
      expect(first?.[1]).toBe(filePath)
      expect(Number(first?.[2])).toBe(2)
      expect(first?.[4]).toBe('error')
      expect(first[5]).toMatch(/expected/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
