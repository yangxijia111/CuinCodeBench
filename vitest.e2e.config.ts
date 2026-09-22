import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/** E2E 专用 vitest 配置：只跑 tests/e2e 下的 *.e2e.test.ts（需先 npm run build） */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  }
})
