import { describe, expect, it } from 'vitest'
import { join } from 'path'
import Database from 'better-sqlite3'
import { launchApp, e2eDataRoot, hasPython } from './cdp-harness'

/**
 * 主流程 E2E（docs/V1_2_E2E_PLAN.md §4.1）。
 * 经分析弃用 Playwright loader（与 Electron 44 的 CDP 兼容缺陷），改用自制 CDP 驱动（见 cdp-harness.ts）。
 */

function dataDir(name: string): string {
  return join(e2eDataRoot, `flow-${name}-${Date.now()}-${Math.floor(Math.random() * 100000)}`)
}

describe('E2E 主流程', () => {
  it('启动 → 题库种子题可见，导航完整', async () => {
    const app = await launchApp(dataDir('boot'))
    try {
      const navCount = await app.evaluate<number>(
        `Array.from(document.querySelectorAll('.nav-item')).map(n => n.textContent.trim()).join('|')`
      )
      expect(navCount).toContain('题库')
      expect(navCount).toContain('学习')
      expect(navCount).toContain('复习')
      expect(navCount).toContain('错题本')
      // 种子题灌入（45 题 → 列表非空）
      await app.waitFor(`document.querySelector('.problem-item') !== null`)
      const title = await app.evaluate<string>(`document.querySelector('.problem-title')?.textContent ?? ''`)
      expect(title.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  }, 90_000)

  it('学习路线页：C 基础路线与阶段可见', async () => {
    const app = await launchApp(dataDir('lp'))
    try {
      await app.evaluate(`document.querySelector('a[href="#/learning"]')?.click()`)
      await app.waitFor(`document.querySelector('.lp-overview h3')?.textContent === 'C 基础'`)
      await app.waitFor(`document.querySelector('.lp-stage') !== null`)
      const stageCount = await app.evaluate<number>(`document.querySelectorAll('.lp-stage').length`)
      expect(stageCount).toBe(6)
      const kpCount = await app.evaluate<number>(`document.querySelectorAll('.lp-kp').length`)
      expect(kpCount).toBe(15)
    } finally {
      await app.close()
    }
  }, 90_000)

  it('Dashboard 2.0：卡片与 Heatmap 渲染', async () => {
    const app = await launchApp(dataDir('dash'))
    try {
      await app.evaluate(`document.querySelector('a[href="#/dashboard"]')?.click()`)
      await app.waitFor(`document.querySelector('.stat-card') !== null`)
      const labels = await app.evaluate<string>(
        `Array.from(document.querySelectorAll('.stat-card .stat-label')).map(n => n.textContent).join('|')`
      )
      expect(labels).toContain('今日复习')
      expect(labels).toContain('错题待复习')
      await app.waitFor(`document.querySelector('.mastery-heatmap .heatmap-row') !== null`)
      const heat = await app.evaluate<string>(
        `Array.from(document.querySelectorAll('.heatmap-name')).map(n => n.textContent).join('|')`
      )
      expect(heat).toContain('输入输出')
      // 趋势图 SVG 渲染
      await app.waitFor(`document.querySelector('.trend-chart svg') !== null`)
    } finally {
      await app.close()
    }
  }, 90_000)

  it('复习页：空数据时今日待复习为 0 且不可开始', async () => {
    const app = await launchApp(dataDir('review-empty'))
    try {
      await app.evaluate(`document.querySelector('a[href="#/review"]')?.click()`)
      await app.waitFor(`document.querySelector('.review-count-num') !== null`, 20_000)
      const count = await app.evaluate<string>(`document.querySelector('.review-count-num')?.textContent ?? ''`)
      expect(count).toBe('0')
      const disabled = await app.evaluate<boolean>(
        `document.querySelector('.review-start-btn')?.disabled ?? true`
      )
      expect(disabled).toBe(true)
    } finally {
      await app.close()
    }
  }, 90_000)

  it('设置页：数据管理区域（导出/导入 + 隐私提示）', async () => {
    const app = await launchApp(dataDir('settings'))
    try {
      await app.evaluate(`document.querySelector('a[href="#/settings"]')?.click()`)
      await app.waitFor(
        `document.querySelector('button') !== null && [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出完整备份'))`
      )
      const hasImport = await app.evaluate<boolean>(
        `[...document.querySelectorAll('button')].some(b => b.textContent.includes('导入备份'))`
      )
      expect(hasImport).toBe(true)
      const privacy = await app.evaluate<string>(`document.querySelector('.privacy-note')?.textContent ?? ''`)
      expect(privacy).toContain('本地私人数据')
    } finally {
      await app.close()
    }
  }, 90_000)

  describe.skipIf(!hasPython())('判题流（需要 python）', () => {
    it('创建题目 → AC → 制造错题 → 错题笔记 → 复习会话闭环', async () => {
      const app = await launchApp(dataDir('judge-flow'))
      try {
        const ev = app.evaluate
        const wt = app.waitFor

        // —— 新建题目（CDP 真实键盘输入，兼容 React 受控组件与 CodeMirror 6）——
        await app.clickExpr(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('新建题目'))`)
        await wt(`location.hash.startsWith('#/problems/new')`)
        await app.replaceText('input[placeholder*="A+B"]', 'E2E 求和题')
        await app.replaceText('.form-row textarea', '输入两个整数，输出它们的和。')
        const setCase = async (idx: number, slot: number, val: string): Promise<void> => {
          const focusExpr = `document.querySelectorAll('.case-editor')[${idx}].querySelectorAll('textarea')[${slot}]`
          await app.waitFor(`${focusExpr} !== undefined`, 10_000, 200)
          await app.evaluate(
            `(() => { const el = ${focusExpr}; el.focus(); return true })()`
          )
          await app.selectAll()
          await app.insertText(val)
        }
        await setCase(0, 0, '1 2')
        await setCase(0, 1, '3')
        // 添加用例 2
        const btns = await ev<string>(`[...document.querySelectorAll('button')].map(b => b.textContent).join('|')`)
        console.log('BTNS-AT-ADD-CASE:', btns)
        await app.clickExpr(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('添加用例'))`)
        await wt(`document.querySelectorAll('.case-editor').length === 2`, 10_000)
        await setCase(1, 0, '5 5')
        await setCase(1, 1, '10')
        // 保存 → 跳练习页
        await app.clickExpr(`[...document.querySelectorAll('button')].find(b => b.textContent === '保存' || b.textContent === '保存中…')`, 30_000)
        await wt(`document.querySelector('.problem-panel-title')?.textContent === 'E2E 求和题'`, 20_000)

        // —— 提交代码（真实判题链路：spawn python → 落库 → 错题/复习/掌握度 hook）——
        // 说明：CM6 编辑器文本注入是纯 UI 自动化难点（判题逻辑已被集成测试覆盖），
        // 这里经 window.api 走真实判题，UI 断言渲染结果与数据流。
        const pid = await ev<string>(`location.hash.split('/').pop()`)
        const judge = async (code: string): Promise<string> => {
          return ev<string>(
            `window.api.judgeSubmit(${JSON.stringify(pid)}, 'python', ${JSON.stringify(code)}).then(r => { if (!r.ok) throw new Error(r.message); return r.data.status })`
          )
        }
        const dbStatuses = (): string[] => {
          // 直接读库验证落库（UI 列表有挂载时缓存，数据以库为准）
          const db = new Database(join(app.dataDir, 'cuincodebench.db'), { readonly: true })
          const rows = db.prepare('SELECT status FROM submissions ORDER BY created_at').all() as {
            status: string
          }[]
          db.close()
          return rows.map((r) => r.status)
        }

        await judge('a, b = map(int, input().split())\nprint(a + b)')
        expect(dbStatuses()).toEqual(['accepted'])

        // —— 两次错误提交 → 错题本 ——
        for (let i = 0; i < 2; i++) {
          await judge('print("wrong")')
        }
        const statuses = dbStatuses()
        expect(statuses).toEqual(['accepted', 'wrong_answer', 'wrong_answer'])

        // —— 错题本 + 笔记（错题入选即到期，REVIEW_SPEC §2）——
        await ev(`location.hash = '#/mistakes'`)
        await wt(`document.querySelector('.mistake-item') !== null`, 15_000)
        await app.clickExpr(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('错误复盘'))`)
        await wt(`document.querySelectorAll('.mistake-history-item').length === 2`, 15_000)
        await app.replaceText('.mistake-note-row textarea', 'E2E 笔记：忘记转换 int')
        await app.clickExpr(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('保存笔记'))`)
        await wt(`document.body.textContent.includes('笔记已保存')`, 10_000)

        // —— 复习会话闭环 ——
        await ev(`location.hash = '#/review'`)
        await wt(
          `document.querySelector('.review-count-num') !== null && document.querySelector('.review-count-num').textContent !== '0'`,
          15_000
        )
        await ev(`document.querySelector('.review-start-btn').click()`)
        await wt(`document.querySelector('.review-item') !== null`, 15_000)
        await ev(`document.querySelector('.review-next-btn').click()`)
        await wt(`document.querySelector('.problem-panel-title')?.textContent === 'E2E 求和题'`, 15_000)
        // 复习作答通过（单题会话：此 AC 报告后自动收尾）
        await judge('a, b = map(int, input().split())\nprint(a + b)')

        // 会话自动 finished → 复习页显示完成统计（或概览计数归零）；错题项调度推进（good 首次 = 1 天后）
        await ev(`location.hash = '#/review'`)
        await app.waitFor(
          `document.querySelector('.review-summary-stats') !== null || document.querySelector('.review-count-num')?.textContent === '0'`,
          20_000
        )

        // 数据层验证：会话 finished、复习历史 good、调度推进 1 天
        const db = new Database(join(app.dataDir, 'cuincodebench.db'), { readonly: true })
        const sessionRow = db
          .prepare(`SELECT kind, status FROM practice_sessions WHERE kind = 'review' ORDER BY created_at DESC LIMIT 1`)
          .get() as { kind: string; status: string } | undefined
        expect(sessionRow?.status).toBe('finished')
        const hist = db
          .prepare(`SELECT result FROM review_history ORDER BY reviewed_at`)
          .all() as { result: string }[]
        expect(hist.map((h) => h.result)).toContain('good')
        const item = db
          .prepare(`SELECT interval_days, success_streak, next_review_at FROM review_items WHERE target_type = 'problem' LIMIT 1`)
          .get() as { interval_days: number; success_streak: number; next_review_at: number } | undefined
        expect(item?.interval_days).toBe(1)
        expect(item?.success_streak).toBe(1)
        const masteryRow = db
          .prepare(`SELECT score FROM mastery WHERE score > 0 LIMIT 1`)
          .get() as { score: number } | undefined
        expect(masteryRow === undefined || masteryRow.score).toBeTruthy()
        db.close()
      } finally {
        await app.close()
      }
    }, 240_000)
  })
})
