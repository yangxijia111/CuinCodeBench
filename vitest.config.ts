import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    // 同一时间只跑一个测试文件：Runner 集成测试涉及真实子进程与临时目录
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**', 'src/shared/**'],
      exclude: ['src/main/index.ts', '**/*.test.ts']
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  }
})
