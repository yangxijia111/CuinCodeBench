import { describe, expect, it } from 'vitest'
import { APP_NAME, DEFAULT_TESTCASE_TIMEOUT_MS } from '../src/shared/constants'
import { JUDGE_STATUS_META } from '../src/shared/types'
import { DIFFICULTY_META } from '../src/shared/ipc'

/**
 * P0 冒烟测试：验证测试管线与共享模块可加载。
 */
describe('冒烟：共享模块', () => {
  it('常量可导入且值合理', () => {
    expect(APP_NAME).toBe('CuinCodeBench')
    expect(DEFAULT_TESTCASE_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('判题状态元数据覆盖全部状态', () => {
    const statuses = [
      'accepted',
      'wrong_answer',
      'compile_error',
      'runtime_error',
      'time_limit_exceeded',
      'output_limit_exceeded',
      'internal_error'
    ] as const
    for (const s of statuses) {
      expect(JUDGE_STATUS_META[s].label.length).toBeGreaterThan(0)
    }
  })

  it('难度元数据完整', () => {
    expect(Object.keys(DIFFICULTY_META)).toEqual(['easy', 'medium', 'hard'])
  })
})
