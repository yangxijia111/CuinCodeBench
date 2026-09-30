import { describe, expect, it } from 'vitest'
import { join } from 'path'
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
    // 平台无关：期望值由同一 path 模块构造（Linux CI 上分隔符为 /）
    expect(plan.run.program).toBe(join('D:\\tmp\\abc', 'app.exe'))
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

// ============================================================
// v1.4 多文件：buildRunPlan 附加源并入编译命令（docs/V1_4_DESIGN.md §7）
// ============================================================
describe('buildRunPlan 多源编译（v1.4）', () => {
  it('gcc-cpp：附加 .cpp 去重排序后并入；头文件与 .c 不进命令行', () => {
    const plan = buildRunPlan(tc('gcc-cpp'), 'D:/tmp/x', ['util.cpp', 'util.h', 'z.cpp', 'util.cpp', 'a.c'])
    expect(plan.compile?.args).toEqual([
      'main.cpp',
      'util.cpp',
      'z.cpp',
      '-O2',
      '-std=c++17',
      '-Wall',
      '-o',
      'app.exe'
    ])
  })

  it('gcc-c：只并入 .c；python 忽略附加源（同目录 import）', () => {
    const planC = buildRunPlan(tc('gcc-c'), 'D:/tmp/x', ['util.c', 'util.cpp', 'util.h'])
    expect(planC.compile?.args).toEqual(['main.c', 'util.c', '-O2', '-std=c11', '-Wall', '-o', 'app.exe'])
    const py = buildRunPlan(tc('python'), 'D:/tmp/x', ['helper.py'])
    expect(py.compile).toBeNull()
    expect(py.run.args).toEqual(['-I', '-X', 'utf8', 'main.py'])
  })

  it('msvc-cpp：附加源在 /Fe: 之前', () => {
    const plan = buildRunPlan(tc('msvc-cpp'), 'D:/tmp/x', ['util.cpp'])
    expect(plan.compile?.args).toEqual(['/O2', '/std:c++17', '/EHsc', '/W3', 'main.cpp', 'util.cpp', '/Fe:app.exe'])
  })

  it('子目录源文件按相对路径并入；.cc/.cxx 计入 cpp', () => {
    const plan = buildRunPlan(tc('gcc-cpp'), 'D:/tmp/x', ['sub/a.cc', 'd/b.cxx'])
    expect(plan.compile?.args).toEqual([
      'main.cpp',
      'd/b.cxx',
      'sub/a.cc',
      '-O2',
      '-std=c++17',
      '-Wall',
      '-o',
      'app.exe'
    ])
  })
})
