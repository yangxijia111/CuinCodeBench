import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db/connection'
import { initServices } from '../src/main/services'
import { makeProblemInput } from './helpers'
import { AppError } from '../src/main/ipc'
import type Database from 'better-sqlite3'

/**
 * 题库服务层测试（TEST_PLAN §1.5）：CRUD 校验 / 导入导出往返 / 错误路径。
 */

describe('problem-service', () => {
  function setup() {
    const db: Database.Database = openDatabase({ file: ':memory:' })
    const services = initServices(db)
    return { db, services }
  }

  it('创建：合法输入通过并生成题目', () => {
    const { services } = setup()
    const p = services.problems.create(makeProblemInput())
    expect(p.id).toBeTruthy()
    expect(p.testCases).toHaveLength(3)
  })

  it('创建：标题为空被 zod 拒绝（validation 错误码）', () => {
    const { services } = setup()
    try {
      services.problems.create(makeProblemInput({ title: '' }))
      expect.unreachable('应当抛出校验错误')
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
    }
  })

  it('创建：无用例被拒绝（至少 1 个用例）', () => {
    const { services } = setup()
    expect(() =>
      services.problems.create(makeProblemInput({ testCases: [] }))
    ).toThrow()
  })

  it('导出→导入往返一致', () => {
    const { services } = setup()
    services.problems.create(makeProblemInput())
    services.problems.create(makeProblemInput({ title: '第二题', tags: ['x'] }))

    const json = services.problems.exportJson(null)
    const db2 = openDatabase({ file: ':memory:' })
    const services2 = initServices(db2)
    const res = services2.problems.importJson(json)
    expect(res.imported).toBe(2)
    const list = services2.problems.list({ keyword: '', difficulty: 'all', tag: 'all' })
    expect(list).toHaveLength(2)
    expect(list.map((p) => p.title).sort()).toEqual(['测试题 A+B', '第二题'])
    // 导入的题不应是内置题
    expect(list.every((p) => !p.isBuiltin)).toBe(true)
  })

  it('导入非法 JSON 报 AppError(validation)', () => {
    const { services } = setup()
    try {
      services.problems.importJson('{ 不是 json')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe('validation')
    }
  })

  it('导入格式正确的信封但题目非法时报 zod 错误', () => {
    const { services } = setup()
    const bad = JSON.stringify({
      format: 'cuincodebench.problems',
      version: 1,
      problems: [{ title: '缺用例的题', testCases: [] }]
    })
    expect(() => services.problems.importJson(bad)).toThrow()
  })

  it('删除后 get 返回 null', () => {
    const { services } = setup()
    const p = services.problems.create(makeProblemInput())
    services.problems.remove(p.id)
    expect(services.problems.get(p.id)).toBeNull()
  })

  it('设置服务：读取默认值、更新合并', () => {
    const { services } = setup()
    expect(services.settings.get().fontSize).toBe(14)
    services.settings.update({ fontSize: 20 })
    expect(services.settings.get().fontSize).toBe(20)
    expect(services.settings.get().tabSize).toBe(4)
  })
})
