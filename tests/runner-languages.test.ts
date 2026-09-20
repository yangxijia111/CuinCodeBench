import { describe, expect, it } from 'vitest'
import { buildRunPlan, selectToolchain, TOOLCHAIN_PRIORITY } from '../src/main/runner/languages'
import type { Toolchain } from '../src/shared/types'

/**
 * Runner 纯函数单测（TEST_PLAN §1.3，FR-R3）：命令构造为数组、无 shell 拼接点。
 */

function tc(kind: Toolchain['kind'], program = 'C:\\tools\\my gcc.exe'): Toolchain {
  return {
    id: `${kind}:${program}`,
    languageIds: kind === 'python' ? ['python'] : kind.endsWith('-c') ? ['c'] : ['cpp'],
    kind,
    program,
    version: 'test',
    source: 'path'
  }
}

describe('buildRunPlan', () => {
  it('gcc C：编译参数正确且为数组', () => {
    const plan = buildRunPlan(tc('gcc-c'), 'D:\\tmp\\abc')
    expect(plan.compile?.program).toBe('C:\\tools\\my gcc.exe')
    expect(plan.compile?.args).toEqual(['main.c', '-O2', '-std=c11', '-Wall', '-o', 'app.exe'])
    expect(plan.run.program).toBe('D:\\tmp\\abc\\app.exe')
    expect(plan.sourceFile).toBe('main.c')
  })

  it('g++ C++：c++17', () => {
    const plan = buildRunPlan(tc('gcc-cpp'), '/tmp/x')
    expect(plan.compile?.args).toContain('-std=c++17')
    expect(plan.sourceFile).toBe('main.cpp')
  })

  it('MSVC：/Fe 指定输出并携带 vcvars env', () => {
    const env = { 'PATH': 'x', INCLUDE: 'inc', LIB: 'lib' }
    const plan = buildRunPlan({ ...tc('msvc-c'), env }, 'D:\\t')
    expect(plan.compile?.args).toEqual(['/O2', '/std:c11', '/W3', 'main.c', '/Fe:app.exe'])
    expect(plan.compile?.env).toEqual(env)
    expect(plan.run.env).toEqual(env)
  })

  it('Python：-I 隔离 + UTF-8 环境', () => {
    const plan = buildRunPlan(tc('python', 'C:\\Python313\\python.exe'), 'D:\\t')
    expect(plan.compile).toBeNull()
    expect(plan.run.args).toEqual(['-I', '-X', 'utf8', 'main.py'])
    expect(plan.run.env?.['PYTHONUTF8']).toBe('1')
    expect(plan.run.env?.['PYTHONIOENCODING']).toBe('utf-8')
  })

  it('构造结果不含 shell 元字符字符串（数组参数审计）', () => {
    for (const kind of ['gcc-c', 'gcc-cpp', 'clang-c', 'clang-cpp', 'msvc-c', 'msvc-cpp', 'python'] as const) {
      const plan = buildRunPlan(tc(kind), 'D:\\dir with space')
      const all = [...(plan.compile?.args ?? []), ...(plan.run.args ?? [])]
      for (const a of all) {
        expect(a).not.toContain('&&')
        expect(a).not.toContain('|')
        expect(a).not.toContain('>')
      }
    }
  })
})

describe('selectToolchain', () => {
  it('按语言过滤并按优先级排序（gcc > clang > msvc）', () => {
    const picked = selectToolchain(
      [tc('msvc-c'), tc('clang-c'), tc('gcc-c'), tc('gcc-cpp'), tc('python')],
      'c'
    )
    expect(picked?.kind).toBe('gcc-c')
  })

  it('无可用工具链返回 null', () => {
    expect(selectToolchain([tc('python')], 'c')).toBeNull()
  })

  it('优先级表覆盖全部 kind', () => {
    const kinds: Toolchain['kind'][] = [
      'gcc-c',
      'gcc-cpp',
      'clang-c',
      'clang-cpp',
      'msvc-c',
      'msvc-cpp',
      'python'
    ]
    for (const k of kinds) {
      expect(TOOLCHAIN_PRIORITY[k]).toBeTypeOf('number')
    }
  })
})
