import { useEffect, useState } from 'react'

/**
 * P0 冒烟页面：验证窗口 + IPC 通路。后续 Phase 替换为完整布局。
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<string>('正在连接主进程…')

  useEffect(() => {
    void window.api.getAppInfo().then((res) => {
      if (res.ok) {
        setInfo(`v${res.data.version} · 数据目录：${res.data.dataDir}`)
      } else {
        setInfo(`IPC 错误：${res.message}`)
      }
    })
  }, [])

  return (
    <div className="app-shell">
      <h1>CuinCodeBench</h1>
      <p className="subtitle">本地代码练习 · 运行 · 自动判题 · 错题分析</p>
      <p className="meta">{info}</p>
    </div>
  )
}
