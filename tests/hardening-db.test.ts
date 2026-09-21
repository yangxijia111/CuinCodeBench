import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db/connection'
import { initServices, closeServices } from '../src/main/services'
import { ProblemRepository } from '../src/main/db/repositories/problem-repository'
import { makeProblemInput } from './helpers'

/**
 * v1.1 Hardening H8：数据库可靠性——导入事务回滚与显式关闭。
 */

describe('题库导入事务回滚', () => {
  it('createMany 中途失败时整体回滚，不留半份数据', () => {
    const db = openDatabase({ file: ':memory:' })
    const repo = new ProblemRepository(db)

    const good = makeProblemInput({ title: '合法题 1' })
    const bad = makeProblemInput({ title: '非法难度题', difficulty: 'impossible' as never })

    // repo 层不做 zod 校验（zod 在 service 层），非法 difficulty 触发 DB CHECK 约束失败
    expect(() => repo.createMany([good, bad], false)).toThrow()

    // 回滚验证：第一题不应存在
    const list = repo.list({ keyword: '', difficulty: 'all', tag: 'all' })
    expect(list).toHaveLength(0)
    const caseCount = db.prepare('SELECT COUNT(*) AS c FROM test_cases').get() as { c: number }
    expect(caseCount.c).toBe(0)
  })

  it('service.importJson 全部合法时原子写入', () => {
    const db = openDatabase({ file: ':memory:' })
    const services = initServices(db)
    const json = JSON.stringify({
      format: 'cuincodebench.problems',
      version: 1,
      problems: [makeProblemInput({ title: '导入 A' }), makeProblemInput({ title: '导入 B' })]
    })
    const res = services.problems.importJson(json)
    expect(res.imported).toBe(2)
    expect(services.problems.count()).toBe(2)
    closeServices()
  })

  it('closeServices 后重复关闭安全（幂等）', () => {
    const db = openDatabase({ file: ':memory:' })
    initServices(db)
    closeServices()
    expect(() => closeServices()).not.toThrow()
  })
})
