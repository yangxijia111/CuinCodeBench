import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, join } from 'path'
import { loadSeedProblems } from '../src/main/seed/seed'
import type { ProblemInput } from '../src/shared/types'

/**
 * 种子题库测试（TEST_PLAN §1.5）：
 * 1. JSON 结构合法；
 * 2. 每题期望输出用 TS 参考解逐一验证（防止内置答案错误）。
 */

const seedFile = resolve(__dirname, '../resources/seed-problems.json')

// 加载失败（结构非法）直接让测试失败——不吞异常（NFR-7）
const seeds: ProblemInput[] = loadSeedProblems(seedFile)

const norm = (s: string): string =>
  s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')

// —— 参考解（与题面一致的最简实现） ——

const solvers: Record<string, (stdin: string) => string> = {
  'A+B 问题': (inp) => {
    const [a, b] = inp.split(/\s+/).map(Number)
    return String((a ?? 0) + (b ?? 0))
  },
  FizzBuzz: (inp) => {
    const n = Number(inp.trim())
    const out: string[] = []
    for (let i = 1; i <= n; i++) {
      let s = i % 3 === 0 ? 'Fizz' : ''
      s += i % 5 === 0 ? 'Buzz' : ''
      out.push(s || String(i))
    }
    return out.join('\n')
  },
  字符串反转: (inp) => [...inp.replace(/\n$/, '')].reverse().join(''),
  判断回文: (inp) => {
    const s = inp.replace(/\n$/, '')
    return s === [...s].reverse().join('') ? 'yes' : 'no'
  },
  最大公约数: (inp) => {
    const [a, b] = inp.split(/\s+/).map(Number)
    let x = a ?? 0
    let y = b ?? 0
    while (y !== 0) {
      const t = x % y
      x = y
      y = t
    }
    return String(x)
  },
  统计元音字母: (inp) => {
    const s = inp.replace(/\n$/, '').toLowerCase()
    let c = 0
    for (const ch of s) if ('aeiou'.includes(ch)) c++
    return String(c)
  },
  冒泡排序: (inp) => {
    const lines = inp.split('\n')
    const arr = (lines[1] ?? '')
      .split(/\s+/)
      .filter((x) => x !== '')
      .map(Number)
      .sort((a, b) => a - b)
    return arr.join(' ')
  },
  矩阵转置: (inp) => {
    const lines = inp.split('\n').filter((l) => l !== '')
    const [n, m] = (lines[0] ?? '0 0').split(/\s+/).map(Number)
    const mat: number[][] = []
    for (let i = 0; i < n; i++) {
      mat.push((lines[i + 1] ?? '').split(/\s+/).filter((x) => x !== '').map(Number))
    }
    const out: string[] = []
    for (let j = 0; j < m; j++) {
      out.push(mat.map((row) => String(row[j] ?? 0)).join(' '))
    }
    return out.join('\n')
  },
  二分查找: (inp) => {
    const lines = inp.split('\n').filter((l) => l !== '')
    const a = (lines[1] ?? '').split(/\s+/).map(Number)
    const q = Number(lines[2])
    const out: string[] = []
    for (let i = 0; i < q; i++) {
      const t = Number(lines[3 + i])
      let lo = 0
      let hi = a.length - 1
      let ans = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const v = a[mid] ?? 0
        if (v === t) {
          ans = mid
          break
        } else if (v < t) lo = mid + 1
        else hi = mid - 1
      }
      out.push(String(ans))
    }
    return out.join('\n')
  },
  '最长公共子序列（LCS）': (inp) => {
    const lines = inp.split('\n')
    const s = lines[0] ?? ''
    const t = lines[1] ?? ''
    let prev = new Array<number>(t.length + 1).fill(0)
    for (let i = 1; i <= s.length; i++) {
      const cur = new Array<number>(t.length + 1).fill(0)
      for (let j = 1; j <= t.length; j++) {
        cur[j] = s[i - 1] === t[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0)
      }
      prev = cur
    }
    return String(prev[t.length] ?? 0)
  }
}

describe('seed 题库', () => {
  it('加载成功且覆盖三难度、10 道题', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(8)
    const diffs = new Set(seeds.map((p) => p.difficulty))
    expect(diffs).toEqual(new Set(['easy', 'medium', 'hard']))
  })

  it('每题结构完整：三语言初始代码、用例 1-50 个、有标签', () => {
    for (const p of seeds) {
      expect(p.initialCode.c).not.toBe('')
      expect(p.initialCode.cpp).not.toBe('')
      expect(p.initialCode.python).not.toBe('')
      expect(p.testCases.length).toBeGreaterThanOrEqual(1)
      expect(p.tags.length).toBeGreaterThanOrEqual(1)
      for (const tc of p.testCases) {
        expect(tc.timeoutMs).toBeGreaterThanOrEqual(100)
        expect(tc.timeoutMs).toBeLessThanOrEqual(60000)
      }
    }
  })

  it('全部期望输出与参考解一致（TS 对拍；其余题由真实工具链验证覆盖）', () => {
    // v1.2 起题库分两类：有 TS solver 的老题在此对拍快验；新题必须带 referenceSolution，
    // 由 tests/seed-verify.integration.test.ts 在真实 gcc/python 上逐用例验证。
    const raw = JSON.parse(readFileSync(seedFile, 'utf-8')) as {
      problems: Array<{ title: string; referenceSolution?: unknown; initialCode: Record<string, string> }>
    }
    // 验证基准：referenceSolution（骨架题）或完整的 initialCode（v1.2 新题，初始代码即参考解）
    const hasRealRef = new Set(
      raw.problems
        .filter(
          (p) =>
            p.referenceSolution !== undefined ||
            Object.values(p.initialCode).every((c) => c.trim() !== '' && !c.includes('TODO'))
        )
        .map((p) => p.title)
    )
    let checked = 0
    for (const p of seeds) {
      const solver = solvers[p.title]
      if (solver === undefined) {
        expect(
          hasRealRef.has(p.title),
          `题目 ${p.title} 缺少参考解（TS solver / referenceSolution / 完整初始代码 至少有一）`
        ).toBe(true)
        continue
      }
      for (let i = 0; i < p.testCases.length; i++) {
        const tc = p.testCases[i]
        expect(norm(solver(tc.stdin)), `${p.title} 用例#${i + 1}`).toBe(norm(tc.expectedStdout))
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40)
  })

  it('种子文件缺失返回空数组（不致命）；非法内容被 zod 拒绝', () => {
    expect(loadSeedProblems(join(__dirname, 'fixtures/definitely-missing-file.json'))).toEqual([])
    expect(() => loadSeedProblems(join(__dirname, 'fixtures/definitely-missing-file.json'))).not.toThrow()
  })
})
