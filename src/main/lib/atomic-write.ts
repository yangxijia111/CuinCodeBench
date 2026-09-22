import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs'

/**
 * 原子文件写入（P1-C）：临时文件 → 全量写入 → fsync → rename。
 * - 读者要么看到完整旧文件、要么看到完整新文件——进程中途被杀不会留下半文件；
 * - fsync 保证数据落盘后才 rename（掉电不丢已完成导出）；
 * - 失败时尽力清理临时文件，不留垃圾。
 */
export function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, data, 'utf-8')
    // 显式 fsync：writeFileSync 只保证写入 OS 缓冲
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件清理失败不影响错误上抛
    }
    throw err
  }
}
