/**
 * LSP JSON-RPC over stdio 编解码（Content-Length 帧，LSP 基础协议 §Base Protocol）。
 * 消息 = `Content-Length: N\r\n\r\n` + N 字节 UTF-8 JSON，连续排列。
 * 仅纯编解码（可独立单测）；进程 IO 在 lsp-server.ts。
 */

/** 单条消息 body 上限（16MB：诊断批量/补全列表远小于此，防失控防线） */
export const MAX_RPC_BODY_BYTES = 16 * 1024 * 1024

export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcProtocolError'
  }
}

/** 编码一条消息（发送侧） */
export function encodeRpcMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_RPC_BODY_BYTES) {
    throw new RpcProtocolError(`RPC 消息体超限：${body.length}`)
  }
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * 增量解码器：feed 任意分块字节，产出完整 JSON 消息对象。
 * 头部畸形 / 长度超限 / JSON 解析失败 = 协议损坏，抛 RpcProtocolError（上层转 server 降级）。
 */
export class RpcDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private headerText = ''
  private expectedLen: number | null = null

  /** 喂入字节；返回本次凑齐的全部消息 */
  feed(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      if (this.expectedLen === null) {
        const sep = this.buffer.indexOf('\r\n\r\n')
        if (sep < 0) {
          // 头部兜底上限：正常头 <100 字节，防对端发垃圾导致无限累积
          if (this.buffer.length > 64 * 1024) {
            throw new RpcProtocolError('RPC 头部超限（未找到 \\r\\n\\r\\n）')
          }
          return messages
        }
        this.headerText = this.buffer.subarray(0, sep).toString('ascii')
        this.buffer = this.buffer.subarray(sep + 4)
        const m = /^Content-Length:\s*(\d+)\s*$/i.exec(this.headerText.split('\r\n')[0] ?? '')
        if (m === null) {
          throw new RpcProtocolError(`RPC 头部缺失 Content-Length：${this.headerText.slice(0, 60)}`)
        }
        this.expectedLen = Number(m[1])
        if (this.expectedLen > MAX_RPC_BODY_BYTES) {
          throw new RpcProtocolError(`RPC 消息体长度超限：${this.expectedLen}`)
        }
      }
      if (this.buffer.length < this.expectedLen) return messages
      const body = this.buffer.subarray(0, this.expectedLen)
      this.buffer = this.buffer.subarray(this.expectedLen)
      this.expectedLen = null
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch (err) {
        throw new RpcProtocolError(`RPC JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
      }
      messages.push(parsed)
    }
  }
}

// ============================================================
// LSP 消息构造辅助（client → server 方向的最小集合）
// ============================================================

let nextRequestId = 1

/** 构造一条请求（有 id，等待响应） */
export function rpcRequest(method: string, params: unknown): { jsonrpc: '2.0'; id: number; method: string; params: unknown } {
  return { jsonrpc: '2.0', id: nextRequestId++, method, params }
}

/** 构造一条通知（无 id，单向） */
export function rpcNotification(method: string, params: unknown): { jsonrpc: '2.0'; method: string; params: unknown } {
  return { jsonrpc: '2.0', method, params }
}

/** LSP server 消息的宽松类型面（method 可选：响应消息只有 id/result/error） */
export interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
