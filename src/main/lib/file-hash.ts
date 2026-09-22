import { createHash } from 'crypto'
import { closeSync, openSync, readSync } from 'fs'

/**
 * 流式（分块同步读）SHA-256：备份导入的防调包校验（P1-C）。
 * 替代 mtime 比较——同尺寸改写可保留 mtime，哈希不可伪造（对本地威胁模型足够）。
 * 分块读取保证内存占用恒定（1MB），不随文件大小增长。
 */
const CHUNK_BYTES = 1024 * 1024

export function sha256FileSync(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(CHUNK_BYTES)
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null)
      if (n === 0) break
      hash.update(n === CHUNK_BYTES ? buf : buf.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}
