#!/usr/bin/env node
// v1.4 测试桩：最小 LSP 语言服务器（stdio JSON-RPC），驱动 LspServer/LspService 真实子进程测试。
// 行为由文档内容驱动：
// - didOpen 文本含 "STUB_ERROR" → 推送一条 severity=1 诊断（消息含首行）
// - didOpen 文本含 "CRASH_SERVER" → process.exit(1)（模拟崩溃）
// - 其余 didOpen → 推送空诊断
// - completion → 固定两项（env STUB_SLOW=1 时延迟 2s，用于超时测试）
// - hover → markdown 内容
import { Buffer } from 'node:buffer'

let buffer = Buffer.alloc(0)
let expected = null

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { capabilities: { textDocumentSync: 1, completionProvider: {}, hoverProvider: true } }
    })
    return
  }
  if (msg.method === 'initialized') return
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') {
    process.exit(0)
    return
  }
  if (msg.method === 'textDocument/didOpen') {
    const td = msg.params.textDocument
    if (String(td.text).includes('CRASH_SERVER')) {
      setTimeout(() => process.exit(1), 10)
      return
    }
    if (String(td.text).includes('STUB_ERROR')) {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: td.uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1,
              message: 'stub: ' + String(td.text).split('\n')[0],
              source: 'stub'
            }
          ]
        }
      })
    } else {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, diagnostics: [] } })
    }
    return
  }
  if (msg.method === 'textDocument/didChange') return
  if (msg.method === 'textDocument/completion') {
    const reply = () =>
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          items: [
            { label: 'stub_alpha', kind: 3 },
            { label: 'stub_beta', kind: 1, detail: '桩详情' }
          ]
        }
      })
    if (process.env['STUB_SLOW'] === '1') setTimeout(reply, 2_000)
    else reply()
    return
  }
  if (msg.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { contents: { kind: 'markdown', value: '**桩** hover 内容' } }
    })
    return
  }
  if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'MethodNotFound: ' + String(msg.method) } })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    if (expected === null) {
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep < 0) return
      const header = buffer.subarray(0, sep).toString('ascii')
      const m = /^Content-Length:\s*(\d+)\s*$/i.exec(header)
      if (m === null) process.exit(2)
      expected = Number(m[1])
      buffer = buffer.subarray(sep + 4)
    }
    if (buffer.length < expected) return
    const body = buffer.subarray(0, expected)
    buffer = buffer.subarray(expected)
    expected = null
    try {
      handle(JSON.parse(body.toString('utf8')))
    } catch {
      // 坏消息忽略
    }
  }
})
