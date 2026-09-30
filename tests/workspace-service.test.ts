import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SOURCE_FILENAMES } from '@shared/constants'
import { safeJoinWithin, validateFileSet, validateWorkspacePath } from '../src/shared/workspace-path'
import { WorkspaceService } from '../src/main/services/workspace-service'
import type { LspService } from '../src/main/services/lsp-service'
import type { ProblemService } from '../src/main/services'
import type { ProblemDetail } from '@shared/types'

/**
 * v1.4 P4：工作区服务与路径校验（docs/V1_4_DESIGN.md §1/§5）。
 * LSP 依赖用记录桩（不 spawn）；题目服务用最小桩（initialCode）。
 */

function makeProblem(id: string, initialCode: string): ProblemDetail {
  return {
    id,
    title: `题 ${id}`,
    description: '',
    difficulty: 'easy',
    tags: [],
    inputDesc: '',
    outputDesc: '',
    samples: [],
    initialCode: { c: initialCode, cpp: initialCode, python: initialCode },
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
    testCases: [],
    files: []
  }
}

/** LSP 记录桩：捕获 openWorkspace/syncDocs 调用序列 */
function makeLspSpy(): { spy: LspService; opens: string[][]; syncs: unknown[][] } {
  const opens: string[][] = []
  const syncs: unknown[][] = []
  const spy = {
    openWorkspace: (problemId: string, language: string, dir: string, files: { path: string }[]) => {
      opens.push([problemId, language, dir, files.map((f) => f.path).join(',')])
      return Promise.resolve()
    },
    syncDocs: (problemId: string, language: string, dir: string, changed: unknown, removed: unknown) => {
      syncs.push([problemId, language, dir, changed, removed])
    }
  } as unknown as LspService
  return { spy, opens, syncs }
}

function makeService(): {
  service: WorkspaceService
  lsp: ReturnType<typeof makeLspSpy>
  dataDir: string
  problem: ProblemDetail
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'ccb-ws-'))
  const lsp = makeLspSpy()
  const problem = makeProblem('p1', 'int main(){}\n')
  const problems = { get: (id: string) => (id === 'p1' ? problem : null) } as unknown as ProblemService
  const service = new WorkspaceService(dataDir, lsp.spy, () => problems)
  return { service, lsp, dataDir, problem }
}

describe('validateWorkspacePath（恶意路径矩阵）', () => {
  const cases: { path: string; ok: boolean; why: string }[] = [
    { path: 'util.h', ok: true, why: '普通文件' },
    { path: 'sub/util.cpp', ok: true, why: '子目录' },
    { path: 'a/b/c/d/e/f/g/h/i.cpp', ok: true, why: '深度 9 超限', },
    { path: '../escape.c', ok: false, why: '父目录遍历' },
    { path: 'a/../../escape.c', ok: false, why: '中段遍历' },
    { path: '..\\escape.c', ok: false, why: '反斜杠' },
    { path: 'C:/abs.c', ok: false, why: '盘符' },
    { path: '/abs.c', ok: false, why: '绝对路径' },
    { path: 'main.py', ok: false, why: '与入口同名（python）' },
    { path: 'main.cpp', ok: true, why: 'python 工作区中的 main.cpp 不是入口' },
    { path: 'compile_flags.txt', ok: false, why: 'LSP 保留名' },
    { path: '.clangd', ok: false, why: 'LSP 保留名' },
    { path: 'a//b.c', ok: false, why: '空段' },
    { path: 'a/./b.c', ok: false, why: '"." 段' },
    { path: '坏 文件.c', ok: false, why: '非法字符（空格/中文）' },
    { path: '', ok: false, why: '空路径' }
  ]
  for (const c of cases) {
    // main.py 是 python 入口；a/b/... 深度 9 段超限
    const expected = c.path === 'a/b/c/d/e/f/g/h/i.cpp' ? false : c.path === 'main.py' ? false : c.ok
    it(`${JSON.stringify(c.path)} → ${expected ? '通过' : '拒绝'}（${c.why}）`, () => {
      if (c.path === 'main.py') {
        // python 入口禁止；但同名文件在 c 工作区合法（c 入口是 main.c）
        expect(validateWorkspacePath('main.py', 'c').ok).toBe(true)
      }
      expect(validateWorkspacePath(c.path, 'python').ok).toBe(expected)
    })
  }

  it('深度边界：8 段通过', () => {
    expect(validateWorkspacePath('a/b/c/d/e/f/g/h.c', 'c').ok).toBe(true)
  })
})

describe('validateFileSet', () => {
  it('数量/重复/总量校验', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ path: `f${i}.c`, content: 'x' }))
    expect(validateFileSet('c', many).ok).toBe(false)

    expect(validateFileSet('c', [{ path: 'a.c', content: 'x' }, { path: 'a.c', content: 'y' }]).ok).toBe(false)

    const big = Array.from({ length: 16 }, () => ({ path: 'f.c', content: 'x'.repeat(80_000) }))
    expect(validateFileSet('c', big.map((f, i) => ({ ...f, path: `f${i}.c` }))).ok).toBe(false)

    expect(
      validateFileSet('c', [
        { path: 'a.c', content: 'x' },
        { path: 'b.c', content: 'y' }
      ]).ok
    ).toBe(true)
  })
})

describe('safeJoinWithin', () => {
  it('规范化后仍在域内', () => {
    expect(safeJoinWithin('sub/a.c')).toBe('sub/a.c')
    expect(safeJoinWithin('a//b.c')).toBe('a/b.c')
    expect(safeJoinWithin('..\\x')).toBeNull()
    expect(safeJoinWithin('../x')).toBeNull()
    expect(safeJoinWithin('')).toBeNull()
  })
})

describe('WorkspaceService', () => {
  it('open 首次：种 initialCode；LSP 收到 openWorkspace', async () => {
    const h = makeService()
    try {
      const files = await h.service.open('p1', 'python', null)
      expect(files).toEqual([{ path: 'main.py', content: 'int main(){}\n', isEntry: true }])
      expect(existsSync(join(h.dataDir, 'workspaces', 'p1', 'python', 'main.py'))).toBe(true)
      expect(h.lsp.opens).toHaveLength(1)
      expect(h.lsp.opens[0]?.[0]).toBe('p1')
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('open 带 draft（localStorage 迁移）：首次以 draft 为准；磁盘已有则以磁盘为准', async () => {
    const h = makeService()
    try {
      const first = await h.service.open('p1', 'c', '/* 草稿 */\n')
      expect(first[0]?.content).toBe('/* 草稿 */\n')

      // 再次 open（磁盘已存在）：draft 被忽略
      h.problem.initialCode.c = 'int changed(){}\n'
      const second = await h.service.open('p1', 'c', '/* 新草稿 */\n')
      expect(second[0]?.content).toBe('/* 草稿 */\n')
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('sync：写子目录文件 + 删除文件；LSP 收到 syncDocs；入口不可删', async () => {
    const h = makeService()
    try {
      await h.service.open('p1', 'cpp', null)
      await h.service.sync('p1', 'cpp', [{ path: 'sub/util.cpp', content: 'int util(){}\n' }], [])
      expect(readFileSync(join(h.dataDir, 'workspaces', 'p1', 'cpp', 'sub', 'util.cpp'), 'utf8')).toBe('int util(){}\n')
      expect(h.lsp.syncs).toHaveLength(1)

      await h.service.sync('p1', 'cpp', [], ['sub/util.cpp'])
      expect(existsSync(join(h.dataDir, 'workspaces', 'p1', 'cpp', 'sub', 'util.cpp'))).toBe(false)
      expect(h.lsp.syncs).toHaveLength(2)

      await expect(h.service.sync('p1', 'cpp', [], ['main.cpp'])).rejects.toThrow('入口文件不可删除')
      await expect(h.service.sync('p1', 'cpp', [{ path: '../evil.cpp', content: 'x' }], [])).rejects.toThrow()
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('reset：清空并恢复 initialCode', async () => {
    const h = makeService()
    try {
      await h.service.open('p1', 'python', null)
      await h.service.sync('p1', 'python', [
        { path: 'extra.py', content: 'x = 1\n' },
        { path: 'main.py', content: 'EDITED\n' }
      ], [])
      const files = await h.service.reset('p1', 'python')
      expect(files).toEqual([{ path: 'main.py', content: 'int main(){}\n', isEntry: true }])
      expect(existsSync(join(h.dataDir, 'workspaces', 'p1', 'python', 'extra.py'))).toBe(false)
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('list 排除保留名/产物/隐藏文件；入口排首位', async () => {
    const h = makeService()
    try {
      const dir = join(h.dataDir, 'workspaces', 'p1', 'c')
      const files = await h.service.open('p1', 'c', null)
      expect(files).toHaveLength(1)
      // 直接向磁盘投放非用户文件（模拟 LSP/判题产物）
      writeFileSync(join(dir, 'compile_flags.txt'), '-std=c11\n')
      writeFileSync(join(dir, 'app.exe'), 'binary')
      const fs = await import('node:fs')
      fs.mkdirSync(join(dir, '__pycache__'))
      writeFileSync(join(dir, '__pycache__', 'x.pyc'), '')
      await h.service.sync('p1', 'c', [{ path: 'z_last.h', content: 'int z;\n' }], [])
      const listed = await h.service.open('p1', 'c', null)
      expect(listed.map((f) => f.path)).toEqual(['main.c', 'z_last.h'])
      expect(listed[0]?.isEntry).toBe(true)
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('open 补种题目定义的附加文件（v1.4）；已有文件保留 solver 编辑态', async () => {
    const h = makeService()
    try {
      h.problem.files = [
        {
          id: 'f1',
          problemId: 'p1',
          language: 'python',
          path: 'util.py',
          content: 'def add(a, b):\n    return a + b\n',
          sortOrder: 0
        }
      ]
      const files = await h.service.open('p1', 'python', null)
      // 定义文件被补种且出现在列表
      expect(files.map((f) => f.path)).toEqual(['main.py', 'util.py'])
      // solver 编辑定义文件后再 open：编辑态优先（不覆盖）
      await h.service.sync('p1', 'python', [{ path: 'util.py', content: 'EDITED\n' }], [])
      const again = await h.service.open('p1', 'python', null)
      expect(again.find((f) => f.path === 'util.py')?.content).toBe('EDITED\n')
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('removeProblem：清理题目工作区', async () => {
    const h = makeService()
    try {
      await h.service.open('p1', 'c', null)
      await h.service.removeProblem('p1')
      expect(existsSync(join(h.dataDir, 'workspaces', 'p1'))).toBe(false)
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })

  it('题目不存在 → not_found', async () => {
    const h = makeService()
    try {
      await expect(h.service.open('ghost', 'c', null)).rejects.toThrow('题目不存在')
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true })
    }
  })
})

// SOURCE_FILENAMES 从 shared 单源引用（判题命令与工作区模型一致）
describe('SOURCE_FILENAMES 单源', () => {
  it('入口文件名', () => {
    expect(SOURCE_FILENAMES).toEqual({ c: 'main.c', cpp: 'main.cpp', python: 'main.py' })
  })
})
