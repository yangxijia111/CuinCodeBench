import { rmSync } from 'fs'

/** 强制删除目录（E2E 清理；Windows 句柄延迟释放时忽略失败） */
export function rmDirForce(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响测试结果
  }
}
