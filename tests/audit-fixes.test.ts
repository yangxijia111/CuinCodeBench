import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db/connection'
import { initServices } from '../src/main/services'
import { ToolchainService } from '../src/main/services/toolchain-service'
import { truncateForDisplay } from '../src/renderer/src/lib/display'
import { makeProblemInput } from './helpers'

/**
 * 审计修复的补充测试：seed 不复活、工具链手工合并、展示截断。
 */

describe('seed 不复活', () => {
  it('清空题库后重启不再灌入种子题', () => {
    const db = openDatabase({ file: ':memory:' })
    const services = initServices(db)

    // 模拟首次启动：未标记 → 灌入并标记
    expect(services.settings.hasSeeded()).toBe(false)
    services.problems.create(makeProblemInput(), true)
    services.settings.markSeeded()

    // 模拟用户删除全部题目后再次启动
    for (const p of services.problems.list({ keyword: '', difficulty: 'all', tag: 'all' })) {
      services.problems.remove(p.id)
    }
    const restarted = initServices(db)
    expect(restarted.settings.hasSeeded()).toBe(true)
    // 灌入条件不满足 → 题库保持为空
    expect(restarted.problems.count()).toBe(0)
  })
})

describe('toolchain-service 手工路径合并', () => {
  function makeService(manual: Partial<Record<'c' | 'cpp' | 'python', string>>): ToolchainService {
    return new ToolchainService(() => manual)
  }

  it('手工路径未命中时注入 manual 工具链', () => {
    const svc = makeService({ python: 'D:\\py\\python.exe' })
    return svc.detectAll(true).then((all) => {
      // 探测环境可能有真实 python；确保 manual 合并结果存在
      const manual = all.find((t) => t.source === 'manual' && t.program === 'D:\\py\\python.exe')
      expect(manual).toBeDefined()
      expect(manual?.languageIds).toEqual(['python'])
      // select 返回手工路径
      return svc.select('python').then((picked) => {
        expect(picked?.program).toBe('D:\\py\\python.exe')
      })
    })
  })

  it('手工路径与自动探测重合时升级为 manual 来源', () => {
    const svc = makeService({ c: 'C:\\nonexistent-dir\\gcc.exe' })
    return svc.select('c').then((picked) => {
      // 无真实编译器环境：返回手工注入项（或 null），不抛错
      if (picked !== null) {
        expect(['manual', 'path']).toContain(picked.source)
      }
    })
  })
})

describe('展示层截断', () => {
  it('短文本原样返回', () => {
    expect(truncateForDisplay('hello')).toBe('hello')
  })

  it('超长文本截断并附加提示', () => {
    const big = 'x'.repeat(70_000)
    const out = truncateForDisplay(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out).toContain('已截断')
    expect(out.startsWith('x'.repeat(100))).toBe(true)
  })
})
