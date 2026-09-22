import { describe, expect, it } from 'vitest'
import { existsSync, rmSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll } from 'vitest'
import { launchApp, e2eDataRoot, rmDirForce, hasPython, findOrphanElectronProcesses } from './cdp-harness'

// P1-D 全局断言：本文件全部用例结束后不允许遗留本项目 Electron 测试进程
afterAll(() => {
  const orphans = findOrphanElectronProcesses()
  if (orphans.length > 0) {
    throw new Error(`E2E 结束后存在遗留 Electron 进程: ${JSON.stringify(orphans)}`)
  }
})

/**
 * 备份恢复闭环 E2E + Migration E2E（docs/V1_2_E2E_PLAN.md §4.2–4.3）。
 * 系统文件对话框由 CCB_E2E 桩替换（CCB_E2E_SAVE_PATH / CCB_E2E_OPEN_PATH）。
 */

const skip = process.env['CCB_SKIP_E2E'] === '1' || !existsSync(join(process.cwd(), 'out', 'main', 'index.js'))

describe.skipIf(skip)('E2E 备份恢复闭环', () => {
  it('导出 → 制造脏数据 → 导入恢复 → 全量替换', async () => {
    const dir = join(e2eDataRoot, `backup-${Date.now()}`)
    await rmDirForce(dir)
    mkdirSync(dir, { recursive: true })
    const backupPath = join(dir, 'backup.json')
    rmSync(backupPath, { force: true })

    // 第一次启动：种子数据 + 导出备份
    const s1 = await launchApp(dir, { CCB_E2E_SAVE_PATH: backupPath, CCB_E2E_OPEN_PATH: backupPath })
    try {
      await s1.waitFor(`document.querySelector('.problem-item') !== null`)
      await s1.evaluate(`document.querySelector('a[href="#/settings"]')?.click()`)
      await s1.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('导出完整备份'))`)
      await s1.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('导出完整备份')).click()`)
      await s1.waitFor(`document.body.textContent.includes('备份已导出')`, 20_000)
    } finally {
      await s1.close()
    }
    expect(existsSync(backupPath), '备份文件已生成').toBe(true)
    expect(readFileSync(backupPath, 'utf-8').length).toBeGreaterThan(1000)

    // 记录基线题数（直接读库，避免 UI 计数受分页影响）
    const db = new Database(join(dir, 'cuincodebench.db'), { readonly: true })
    const baseline = (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c
    db.close()
    expect(baseline).toBeGreaterThanOrEqual(45)

    // 制造脏数据（直接写库：题目，绕过 UI 提速）——但应用正在运行会锁库；改为 UI 建题
    const s2 = await launchApp(dir, { CCB_E2E_SAVE_PATH: backupPath, CCB_E2E_OPEN_PATH: backupPath })
    try {
      const page = s2
      await page.waitFor(`document.querySelector('button') !== null`)
      await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('新建题目')).click()`)
      await page.waitFor(`location.hash.startsWith('#/problems/new')`)
      await page.waitFor(`document.querySelector('input[placeholder*="A+B"]') !== null`, 15_000)
      await page.evaluate(
        `(() => { const inp = document.querySelector('input[placeholder*="A+B"]');` +
          `const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;` +
          `setter.call(inp, '恢复前应消失的题'); inp.dispatchEvent(new Event('input', {bubbles: true})) })()`
      )
      const setCase = (slot: number, val: string): string =>
        `(() => { const tas = document.querySelectorAll('.case-editor')[0].querySelectorAll('textarea');` +
        `const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;` +
        `setter.call(tas[${slot}], ${JSON.stringify(val)}); tas[${slot}].dispatchEvent(new Event('input', {bubbles: true})) })()`
      await page.evaluate(setCase(0, '1'))
      await page.evaluate(setCase(1, '1'))
      await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === '保存').click()`)
      await page.waitFor(`document.querySelector('.problem-panel-title')?.textContent === '恢复前应消失的题'`, 20_000)

      // 导入恢复（confirm 自动接受：重写 window.confirm）
      await page.evaluate(`window.confirm = () => true; window.alert = () => undefined`)
      await page.evaluate(`document.querySelector('a[href="#/settings"]')?.click()`)
      await page.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('导入备份'))`)
      await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('导入备份')).click()`)
      // 恢复完成后 UI reload；等题库重新渲染
      // 恢复完成 reload 后 hash 保留在设置页，先导航回题库再断言
      await page.evaluate(`location.hash = '#/problems'`)
      await page.waitFor(`document.querySelector('.problem-item') !== null`, 30_000)
      const after = await page.evaluate<string>(
        `Array.from(document.querySelectorAll('.problem-title')).map(n => n.textContent).join('|')`
      )
      expect(after).not.toContain('恢复前应消失的题')
      const countText = await page.evaluate<number>(
        `document.querySelectorAll('.problem-item').length`
      )
      expect(countText).toBe(baseline)
    } finally {
      await s2.close()
      await rmDirForce(dir)
    }
  }, 240_000)
})

describe.skipIf(skip)('E2E Migration（v1.1 → v1.2）', () => {
  it('v1 库自动升级：旧数据完整 + 学习路线灌入 + 旧题映射', async () => {
    const dir = join(e2eDataRoot, `migration-${Date.now()}`)
    await rmDirForce(dir)
    mkdirSync(dir, { recursive: true })

    // 手工构造 v1.1 schema 库
    const db = new Database(join(dir, 'cuincodebench.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init', 0);
      CREATE TABLE problems (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
        tags TEXT NOT NULL DEFAULT '[]', input_desc TEXT NOT NULL DEFAULT '', output_desc TEXT NOT NULL DEFAULT '',
        samples TEXT NOT NULL DEFAULT '[]', initial_code TEXT NOT NULL DEFAULT '{}',
        is_builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE test_cases (
        id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        stdin TEXT NOT NULL DEFAULT '', expected_stdout TEXT NOT NULL DEFAULT '',
        timeout_ms INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 60000), "order" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE submissions (
        id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        language TEXT NOT NULL CHECK (language IN ('c','cpp','python')), code TEXT NOT NULL, status TEXT NOT NULL,
        passed_count INTEGER NOT NULL, total_count INTEGER NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE test_case_results (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        test_case_id TEXT NOT NULL, "order" INTEGER NOT NULL, stdin TEXT NOT NULL, expected TEXT NOT NULL,
        actual TEXT, stderr TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER NOT NULL
      );
      CREATE TABLE error_records (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE, language TEXT NOT NULL,
        error_type TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE mistake_book (
        problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
        failed_count INTEGER NOT NULL DEFAULT 0, first_failed_at INTEGER, last_failed_at INTEGER,
        last_error_type TEXT, error_type_counts TEXT NOT NULL DEFAULT '{}',
        mastered INTEGER NOT NULL DEFAULT 0, mastered_at INTEGER
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('seeded', '1');
      INSERT INTO problems (id, title, description, difficulty, tags, input_desc, output_desc, samples, initial_code, is_builtin, created_at, updated_at)
        VALUES ('v1-p1', 'v1 时代的旧题', '旧描述', 'easy', '["数组"]', '', '', '[]', '{}', 1, 1, 1);
      INSERT INTO test_cases (id, problem_id, stdin, expected_stdout, timeout_ms, "order")
        VALUES ('v1-tc1', 'v1-p1', '1', '1', 5000, 0);
      INSERT INTO submissions (id, problem_id, language, code, status, passed_count, total_count, duration_ms, created_at)
        VALUES ('v1-s1', 'v1-p1', 'c', 'old code', 'accepted', 1, 1, 5, 100);
      INSERT INTO mistake_book (problem_id, failed_count, last_error_type) VALUES ('v1-p1', 2, 'wrong_answer');
    `)
    db.close()

    const app = await launchApp(dir)
    try {
      // v1 数据可读（seeded 在 → 不重灌种子 → 只有这一题）
      await app.waitFor(`document.querySelector('.problem-item') !== null`)
      const count = await app.evaluate<number>(`document.querySelectorAll('.problem-item').length`)
      expect(count).toBe(1)

      // 学习路线：v2 灌入
      await app.evaluate(`document.querySelector('a[href="#/learning"]')?.click()`)
      await app.waitFor(`document.querySelector('.lp-overview h3')?.textContent === 'C 基础'`)
      // 旧 builtin 题已映射到知识点（数组别名 → 一维数组）
      await app.evaluate(
        `[...document.querySelectorAll('.lp-kp')].find(k => k.textContent.includes('一维数组')).querySelector('.lp-kp-head').click()`
      )
      await app.waitFor(
        `[...document.querySelectorAll('.lp-kp-problem')].some(p => p.textContent.includes('v1 时代的旧题'))`
      )
    } finally {
      await app.close()
      await rmDirForce(dir)
    }
  }, 180_000)
})

void hasPython
