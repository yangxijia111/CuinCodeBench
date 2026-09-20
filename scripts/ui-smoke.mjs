/**
 * UI 冒烟脚本：启动打包产物 → CDP 连接 → 检查各路由 DOM 渲染。
 * 用法：先手动启动 electron（--remote-debugging-port=9333），再 node scripts/ui-smoke.mjs
 */
const CDP_PORT = process.argv[2] ?? '9333'

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

async function evaluate(pageWsUrl, expression) {
  const ws = new WebSocket(pageWsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const result = await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) resolve(msg)
    }
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
  ws.close()
  return result
}

async function main() {
  const targets = await getTargets()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到页面')

  const routes = ['#/problems', '#/dashboard', '#/mistakes']
  let failed = 0
  for (const route of routes) {
    const r = await evaluate(
      page.webSocketDebuggerUrl,
      `(async () => {
        window.location.hash = '${route}';
        await new Promise((r) => setTimeout(r, 600));
        const app = document.querySelector('.app-layout');
        const sidebar = document.querySelectorAll('.nav-item').length;
        const bodyText = document.body.innerText.slice(0, 100);
        const hasError = document.body.innerText.includes('加载失败');
        return JSON.stringify({ hasApp: app !== null, sidebar, bodyText, hasError });
      })()`
    )
    const raw = r.result?.result?.value
    const data = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
    const ok = data.hasApp === true && data.sidebar >= 4 && data.hasError === false
    console.log(`${ok ? 'PASS' : 'FAIL'} ${route} | nav=${data.sidebar} | ${String(data.bodyText).replace(/\n/g, ' ').slice(0, 60)}`)
    if (!ok) failed++
  }
  console.log(failed === 0 ? 'UI 冒烟全部通过' : `${failed} 个路由失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('冒烟失败:', e.message)
  process.exit(1)
})
