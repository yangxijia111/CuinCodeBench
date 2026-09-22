import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'

/**
 * CDP E2E 公共设施（docs/V1_2_E2E_PLAN.md）。
 *
 * 选型说明：Playwright 的 _electron.launch（1.49 / 1.63 实测）通过注入 loader.js 劫持
 * app.whenReady 等待其 CDP 调用 __playwright_run，但其 CDP WebSocket 与 Electron 44
 * （Chromium 152）连接后立即断开（code=1006），应用永久挂起。而原生 DevTools 端点
 * （--remote-debugging-port）完全正常。故采用自制 CDP 驱动：
 * spawn electron（--remote-debugging-port）→ /json/list 拿 page WS → Runtime.evaluate。
 * 仅依赖 Node 22 内置 WebSocket，无额外依赖。
 */

export const projectRoot = resolve(__dirname, '../..')
export const e2eDataRoot = join(projectRoot, '.e2e-data')

const portableGccDir = join(projectRoot, '.tools', 'w64devkit', 'bin')
if (existsSync(portableGccDir)) {
  process.env['PATH'] = `${portableGccDir};${process.env['PATH'] ?? ''}`
}

export interface AppSession {
  child: ChildProcess
  wsUrl: string
  dataDir: string
  evaluate: <T>(expression: string) => Promise<T>
  waitFor: (expression: string, timeoutMs?: number, intervalMs?: number) => Promise<unknown>
  /** 聚焦元素 + Ctrl+A 全选 + 插入文本（模拟真实键盘输入，CodeMirror 6 兼容） */
  replaceText: (focusSelector: string, text: string) => Promise<void>
  /** 当前焦点处 Ctrl+A 全选 */
  selectAll: () => Promise<void>
  /** 当前焦点处插入文本 */
  insertText: (text: string) => Promise<void>
  /** 带重试的点击：表达式返回可点击元素则点击，轮询直至成功 */
  clickExpr: (findExpression: string, timeoutMs?: number) => Promise<void>
  close: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 单例 WS evaluate 客户端：串行发送（id 自增），保持连接直至 close */
class CdpClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, (v: unknown) => void>()

  constructor(url: string) {
    this.ws = new WebSocket(url)
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    await new Promise<void>((resolveOnce, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs)
      this.ws.onopen = () => {
        clearTimeout(t)
        resolveOnce()
      }
      this.ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('CDP WebSocket 错误'))
      }
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const cb = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        cb?.(msg.result)
      }
    }
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolveOnce, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 30_000)
      this.pending.set(id, (v) => {
        clearTimeout(t)
        resolveOnce(v as T)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

export async function launchApp(dataDir: string, extraEnv: Record<string, string> = {}): Promise<AppSession> {
  mkdirSync(dataDir, { recursive: true })
  // vitest forks 池会设置 ELECTRON_RUN_AS_NODE=1，继承会让 electron 退化为纯 node —— 必须剔除
  const electronEnv = { ...process.env } as Record<string, string | undefined>
  delete electronEnv['ELECTRON_RUN_AS_NODE']
  const child = spawn(
    join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['--remote-debugging-port=0', '.'],
    {
      cwd: projectRoot,
      env: {
        ...electronEnv,
        CCB_DATA_DIR: dataDir,
        CCB_E2E: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  // 从 stderr 的 "DevTools listening on ws://127.0.0.1:<port>" 解析实际端口
  const portPromise = new Promise<number>((resolveOnce, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('等待 DevTools 端口超时（30s）；stderr: ' + buf.slice(-300))), 30_000)
    child.stderr?.on('data', (d: Buffer) => {
      buf += String(d)
      if (process.env['CCB_E2E_VERBOSE'] === '1' && buf.length > 0) {
        console.log('[app-stderr-tail]', String(d).slice(0, 400))
      }
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)
      if (m !== null) {
        clearTimeout(t)
        resolveOnce(Number(m[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(t)
      reject(new Error(`Electron 提前退出（code=${code}）；stderr: ${buf.slice(-300)}`))
    })
  })

  // 等待 DevTools 端点就绪
  const port = await portPromise
  const httpUrl = `http://127.0.0.1:${port}/json/list`
  let pageWs: string | null = null
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(httpUrl)
      const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
      const page = targets.find((t) => t.type === 'page')
      if (page !== undefined) {
        pageWs = page.webSocketDebuggerUrl
        break
      }
    } catch {
      // 端点未就绪，重试
    }
    await sleep(500)
  }
  if (pageWs === null) {
    child.kill()
    throw new Error('DevTools 端点未就绪（60 次重试失败）')
  }

  const client = new CdpClient(pageWs)
  await client.connect()

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await client.send<{ result: { value: T; type: string }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }
    )
    if (r.exceptionDetails !== undefined) {
      throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    }
    return r.result.value
  }

  const waitFor = async (
    expression: string,
    timeoutMs = 15_000,
    intervalMs = 300
  ): Promise<unknown> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await evaluate<boolean>(`Boolean(${expression})`)
      if (v) return v
      if (Date.now() > deadline) {
        throw new Error(`等待超时（${timeoutMs}ms）: ${expression.slice(0, 120)}`)
      }
      await sleep(intervalMs)
    }
  }

  const selectAll = async (): Promise<void> => {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    })
  }

  const insertText = async (text: string): Promise<void> => {
    // CodeMirror 6 对 insertText 的 "\n" 不换行：逐行插入，行间用 Enter 按键
    const lines = text.split('\n')
    for (const [i, line] of lines.entries()) {
      if (i > 0) {
        await client.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          text: '\r'
        })
        await client.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        })
      }
      if (line !== '') await client.send('Input.insertText', { text: line })
    }
    await sleep(100)
  }

  const clickExpr = async (findExpression: string, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await evaluate<boolean>(
        `(() => { const el = (${findExpression}); if (el !== null && el !== undefined) { el.click(); return true } return false })()`
      )
      if (v) return
      if (Date.now() > deadline) {
        throw new Error(`点击目标未找到（${timeoutMs}ms）: ${findExpression.slice(0, 120)}`)
      }
      await sleep(300)
    }
  }

  const replaceText = async (focusSelector: string, text: string): Promise<void> => {
    // 先等元素出现（React 渲染异步）
    await waitFor(
      `document.querySelector(${JSON.stringify(focusSelector)}) !== null`,
      10_000,
      200
    )
    await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(focusSelector)}); el.focus(); return el !== null })()`
    )
    await selectAll()
    await insertText(text)
  }

  // 等应用渲染完成（种子题就绪的标志）
  await waitFor(`document.querySelector('.nav-item') !== null`, 30_000)

  return {
    child,
    wsUrl: pageWs,
    dataDir,
    evaluate,
    waitFor,
    replaceText,
    selectAll,
    insertText,
    clickExpr,
    close: async () => {
      client.close()
      child.kill()
      await sleep(500)
    }
  }
}

/** 轮询等待页面满足条件（等价 Playwright 的自动重试断言） */
export async function waitForApp(
  app: AppSession,
  expression: string,
  timeoutMs = 15_000
): Promise<unknown> {
  return app.waitFor(expression, timeoutMs)
}

/** 强制删除目录（E2E 清理；Windows 句柄延迟释放时忽略失败） */
export function rmDirForce(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响测试结果
  }
}

export function hasPython(): boolean {
  try {
    spawnSyncSafe('python --version')
    return true
  } catch {
    return existsSync('C:/Windows/py.exe')
  }
}

function spawnSyncSafe(cmd: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execSync } = require('child_process') as { execSync: (c: string, o?: object) => unknown }
  execSync(cmd, { stdio: 'ignore' })
}
