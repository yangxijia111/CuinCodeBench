/**
 * 打包产物端到端判题验证：CDP 驱动 renderer 调 window.api 全链路判题。
 * 用法：node scripts/e2e-judge.mjs <cdpPort>
 */
const port = process.argv[2] ?? '9336'

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const r = await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === 1) resolve(m)
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
  if (r.result?.exceptionDetails !== undefined) {
    throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  }
  return r.result?.result?.value
}

const main = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到页面')

  // 1) 取种子题（A+B）
  const problems = await evaluate(page.webSocketDebuggerUrl, `window.api.listProblems({keyword:'',difficulty:'all',tag:'all'}).then(r => JSON.stringify(r))`)
  const parsed = JSON.parse(problems)
  if (!parsed.ok) throw new Error('listProblems 失败: ' + parsed.message)
  const first = parsed.data.find((p) => p.title.includes('A+B')) ?? parsed.data[0]
  console.log('题目:', first.title, '| 内置:', first.isBuiltin)

  // 2) Python 正确代码判题（期望 AC）
  const acCode = "a, b = map(int, input().split())\nprint(a + b)"
  const r1 = await evaluate(page.webSocketDebuggerUrl, `window.api.judgeSubmit(${JSON.stringify(first.id)}, 'python', ${JSON.stringify(acCode)}).then(r => JSON.stringify(r))`)
  const j1 = JSON.parse(r1)
  console.log('Python AC 判题:', j1.ok ? `${j1.data.status} (${j1.data.passedCount}/${j1.data.totalCount})` : 'FAIL: ' + j1.message)

  // 3) C 错误代码判题（期望 WA）
  const waCode = '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a-b);return 0;}'
  const r2 = await evaluate(page.webSocketDebuggerUrl, `window.api.judgeSubmit(${JSON.stringify(first.id)}, 'c', ${JSON.stringify(waCode)}).then(r => JSON.stringify(r))`)
  const j2 = JSON.parse(r2)
  console.log('C WA 判题:', j2.ok ? `${j2.data.status} (${j2.data.passedCount}/${j2.data.totalCount})` : 'FAIL: ' + j2.message)

  // 4) 工具链状态
  const r3 = await evaluate(page.webSocketDebuggerUrl, `window.api.detectToolchains(false).then(r => JSON.stringify(r))`)
  const j3 = JSON.parse(r3)
  console.log('工具链:', j3.ok ? j3.data.map((t) => t.kind).join(', ') : 'FAIL')

  // 5) Dashboard 统计
  const r4 = await evaluate(page.webSocketDebuggerUrl, `window.api.getDashboardStats().then(r => JSON.stringify(r))`)
  const j4 = JSON.parse(r4)
  console.log('统计:', j4.ok ? `提交 ${j4.data.totalSubmissions} 次 / AC 题 ${j4.data.acceptedProblems} / 今日 ${j4.data.todaySubmissions}` : 'FAIL')

  const passed = j1.ok && j1.data.status === 'accepted' && j2.ok && j2.data.status === 'wrong_answer' && j4.ok && j4.data.totalSubmissions >= 2
  console.log(passed ? '端到端判题验证通过' : '端到端验证失败')
  process.exit(passed ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 失败:', e.message)
  process.exit(1)
})
