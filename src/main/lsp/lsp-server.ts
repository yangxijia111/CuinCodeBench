import { spawn, type ChildProcess } from 'child_process'
import { logger } from '../lib/logger'
import { RpcDecoder, encodeRpcMessage, rpcRequest, rpcNotification, RpcProtocolError, type RpcMessage } from './jsonrpc'

/**
 * 单个 LSP 语言服务器连接（docs/V1_4_DESIGN.md §2）。
 * 职责：spawn + JSON-RPC 帧协议 + 请求/响应配对 + 通知分发；
 * 生命周期决策（重启/降级）在 LspService。
 *
 * 本模块不 import electron（node 桩服务器可测）；
 * server→client 请求经 onServerRequest 钩子由上层应答，未应答统一 MethodNotFound。
 */

/** LSP wire 诊断（宽松类型，映射到共享类型在 lsp-mapping.ts） */
export interface RawLspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  message: string
  source?: string
}

export interface LspServerOptions {
  program: string
  args: string[]
  /** 叠加在 process.env 之上的环境变量（pyright：ELECTRON_RUN_AS_NODE） */
  env?: Record<string, string>
  rootUri: string
  initializationOptions?: unknown
  serverName: string
  /** publishDiagnostics 等通知回调 */
  onNotification?: (method: string, params: unknown) => void
  /** 非主动关闭的退出（崩溃）；主动 close() 不触发 */
  onExit?: (code: number | null) => void
  /** server→client 请求应答钩子；返回 undefined = 未处理（回 MethodNotFound） */
  onServerRequest?: (method: string, params: unknown) => unknown
  /** 单请求默认超时（毫秒） */
  requestTimeoutMs?: number
  /** initialize 握手超时（毫秒） */
  initializeTimeoutMs?: number
}

export class LspServerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspServerError'
  }
}

export class LspServer {
  private readonly proc: ChildProcess
  private readonly decoder = new RpcDecoder()
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private intentionalClose = false
  private exited = false
  private readonly opts: Required<Pick<LspServerOptions, 'requestTimeoutMs' | 'initializeTimeoutMs'>> &
    LspServerOptions

  private constructor(opts: LspServerOptions, proc: ChildProcess) {
    this.opts = { requestTimeoutMs: 5_000, initializeTimeoutMs: 30_000, ...opts }
    this.proc = proc
    // stdin 写入在进程退出后可能 EPIPE（异步 error 事件，try/catch 不可见）：静默忽略
    this.proc.stdin?.on('error', () => {})
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      // 语言服务器自身日志（pyright/clangd 落 stderr）：截断记录，不进协议层
      const text = chunk.toString('utf8').trim()
      if (text !== '') logger.info(`[${this.opts.serverName}] stderr`, text.slice(0, 200))
    })
    this.proc.on('error', (err) => {
      this.failPending(new LspServerError(`语言服务器进程错误: ${err.message}`))
      this.handleExit(null)
    })
    this.proc.on('close', (code) => {
      this.failPending(new LspServerError('语言服务器已退出'))
      this.handleExit(code)
    })
  }

  /** spawn + initialize 握手；失败（spawn 错误/握手超时/错误响应）即清理并抛出 */
  static async start(opts: LspServerOptions): Promise<LspServer> {
    let proc: ChildProcess
    try {
      proc = spawn(opts.program, opts.args, {
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      throw new LspServerError(`语言服务器 spawn 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    // spawn 异步错误（ENOENT）落到 'error' 事件；提前监听由构造完成
    const server = new LspServer(opts, proc)
    try {
      await server.request(
        'initialize',
        {
          processId: null,
          rootUri: opts.rootUri,
          workspaceFolders: [{ uri: opts.rootUri, name: opts.serverName }],
          capabilities: {
            textDocument: { synchronization: { dynamicRegistration: false } },
            workspace: { workspaceFolders: true }
          },
          ...(opts.initializationOptions !== undefined ? { initializationOptions: opts.initializationOptions } : {})
        },
        opts.initializeTimeoutMs ?? 30_000
      )
      server.notify('initialized', {})
    } catch (err) {
      server.close()
      throw err instanceof LspServerError ? err : new LspServerError(`initialize 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    return server
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.feed(chunk)
    } catch (err) {
      // 协议损坏：等同崩溃，交由 LspService 走重启/降级
      this.failPending(new LspServerError(`协议损坏: ${err instanceof RpcProtocolError ? err.message : String(err)}`))
      this.killProcess()
      return
    }
    for (const raw of messages) this.handleMessage(raw as RpcMessage)
  }

  private handleMessage(msg: RpcMessage): void {
    // server → client 请求（workspace/configuration 等）
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      let result: unknown
      try {
        result = this.opts.onServerRequest?.(msg.method, msg.params)
      } catch (err) {
        logger.warn(`[${this.opts.serverName}] server 请求处理失败`, `${msg.method}: ${String(err)}`)
      }
      if (result !== undefined) {
        this.send({ jsonrpc: '2.0', id: msg.id, result })
      } else {
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'MethodNotFound' } })
      }
      return
    }
    // 响应（配对请求）
    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(Number(msg.id))
      if (entry === undefined) return
      clearTimeout(entry.timer)
      this.pending.delete(Number(msg.id))
      if (msg.error !== undefined) {
        entry.reject(new LspServerError(`LSP ${String(msg.method ?? '')}错误: ${msg.error.message}`))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    // 通知
    if (msg.method !== undefined) this.opts.onNotification?.(msg.method, msg.params)
  }

  private send(message: unknown): void {
    if (this.exited || this.intentionalClose) return
    try {
      this.proc.stdin?.write(encodeRpcMessage(message))
    } catch (err) {
      logger.warn(`[${this.opts.serverName}] 写入失败`, err instanceof Error ? err.message : String(err))
    }
  }

  /** 发请求并等待响应（超时拒绝；进程退出时全部 pending 拒绝） */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const req = rpcRequest(method, params)
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id)
        reject(new LspServerError(`LSP 请求超时: ${method}`))
      }, timeout)
      this.pending.set(req.id, { resolve, reject, timer })
      this.send(req)
    })
  }

  notify(method: string, params: unknown): void {
    this.send(rpcNotification(method, params))
  }

  private failPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  private handleExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    if (!this.intentionalClose) {
      logger.warn(`[${this.opts.serverName}] 异常退出`, `code=${code ?? 'null'}`)
      this.opts.onExit?.(code)
    }
  }

  private killProcess(): void {
    this.intentionalClose = true
    try {
      this.proc.kill()
    } catch {
      // 已退出
    }
  }

  /** 主动关闭：尽力发送 LSP shutdown/exit → 兜底 kill；不触发 onExit */
  close(): void {
    if (this.exited) return
    this.intentionalClose = true
    try {
      // 不经 this.send（intentionalClose 已置位会被拦截）；响应无人等待，直接弃置
      this.proc.stdin?.write(encodeRpcMessage({ jsonrpc: '2.0', id: Date.now(), method: 'shutdown', params: undefined }))
      this.proc.stdin?.write(encodeRpcMessage(rpcNotification('exit', undefined)))
      this.proc.stdin?.end()
    } catch {
      // 已退出
    }
    try {
      this.proc.kill()
    } catch {
      // 已退出
    }
  }

  get pid(): number | null {
    return this.proc.pid ?? null
  }
}
