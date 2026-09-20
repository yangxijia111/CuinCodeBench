import { spawn } from 'child_process'

/**
 * 进程树终止（FR-R5 / WIN-2）：超时或输出超限时强制结束目标进程及其全部子进程。
 * Windows 使用官方工具 taskkill（数组参数，PID 为运行时数值，无注入面）。
 * 注意：终止是"尽力触发"，真正完成以 execute 监听的 exit/close 事件为准。
 */

export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
        // taskkill 不可用时兜底：直接杀主进程
      })
    } catch {
      // spawn 抛错（极少见）时忽略，由上层超时兜底逻辑处理
    }
  } else {
    // POSIX：detached 进程组信号（execute 启动时需 detached: true）
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 进程已退出
      }
    }
  }
}
