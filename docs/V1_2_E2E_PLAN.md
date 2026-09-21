# V1_2_E2E_PLAN.md — 端到端测试方案

## 1. 技术选型

**Playwright（`@playwright/test`）+ `_electron.launch`**：

- 不需要下载浏览器二进制（`playwright install` 可跳过），直接 launch Electron，依赖增量可控；
- 支持 `firstWindow()`、`evaluate`、完整 DOM 断言，比 v1.1 的自制 ui-smoke 脚本可维护性高得多；
- v1.1 的 `scripts/ui-smoke.mjs` 保留（dev 冒烟），v1.2 起正式 E2E 以 Playwright 为准。

## 2. 启动方式

- 前置：`npm run build`（产物在 `out/`）；
- `_electron.launch({ args: ['.'], env: { ...process.env, CCB_DATA_DIR: <临时目录>, CCB_E2E: '1', ELECTRON_ENABLE_LOGGING: '1' } })`；
- **`CCB_E2E=1` 测试钩子**（唯一豁免点，主进程显式判定）：`dialog.showSaveDialog/showOpenDialog` 被替换为受控桩（返回测试注入的路径），使备份导出/导入可端到端测试。生产环境无此环境变量，行为完全不变。桩实现在 `src/main/index.ts` 启动处集中完成并注释用途。
- 每个用例独立临时数据目录（`os.tmpdir()` 下建/删），用例间零污染。

## 3. 等待策略（反 flaky）

- 禁止 `sleep`/固定等待；统一：
  - locator 断言自动等待（`expect(locator).toBeVisible()` 等，Playwright 自带重试）；
  - 数据就绪以 **UI 状态可见** 为准（如种子题渲染出来 = DB 就绪）；
  - 判题异步结果等待结果面板状态标签出现（`通过` / `答案错误` …）；
- 判题依赖真实工具链：E2E 判题用例**仅在检测到 python 时执行**（`beforeAll` 探测，缺失则 `test.skip`）——与 v1.1 单元测试的 `describe.skipIf` 语义一致；非判题流程（导航/备份/错题界面）不依赖工具链，永远执行。

## 4. 用例矩阵（`tests/e2e/`）

### 4.1 主流程 `app-flow.e2e.ts`（无工具链依赖部分 + 条件判题部分）

| # | 流程 | 断言 |
|---|---|---|
| 1 | 启动 → 题库页 | 种子题可见，侧边栏导航完整 |
| 2 | 打开一道题 → 练习页 | 题目描述渲染、编辑器存在 |
| 3 | （条件）python 可用：创建测试题目 → Run → Submit | 判题结果「通过」；提交历史出现该提交 |
| 4 | 历史面板 / 提交详情 | 代码、状态、用例明细可见 |
| 5 | Dashboard | 今日练习等卡片渲染 |
| 6 | 学习路线页 | C 基础路径、阶段、知识点与完成度可见 |
| 7 | （条件）制造失败提交 ×2 → 错题本 | 错题出现；笔记可写入并回显 |
| 8 | 复习页 | 错题复习项到期可见；进入 Review Session；完成页统计渲染 |
| 9 | 备份导出（CCB_E2E 桩） | 文件生成且为合法备份 JSON |

### 4.2 备份恢复闭环 `backup-restore.e2e.ts`

```
建数据（种子 + 若干提交）→ 导出备份 → 关闭 app
→ 删除临时数据目录（清库）→ 重启 app（同 env）→ 确认数据已空
→ 导入备份 → 恢复完成 reload
→ 逐页验证：题库（题目一致）/ 历史（提交一致）/ Dashboard 计数 / 学习路线完成度 / 复习项
```

重点验证：提交历史、题库、设置、mastery、review 五类数据完全恢复。

### 4.3 迁移 `migration.e2e.ts`

用 v1.1 schema 建库（测试内手写 v1 DDL + 种子数据 + `schema_migrations(version=1)`）→ v1.2 应用启动 → 断言：
- 旧数据完整可读（题目/提交/错题）；
- v2 表已创建且内置学习路线已灌入；
- builtin 旧题已自动映射知识点（`learning_v2_mapped`）。

## 5. CI 集成

- **独立 workflow `.github/workflows/e2e.yml`**：`windows-latest`（真实用户平台 + 自带 python），`npm ci → npm run build → npx playwright test`；
- `ci.yml`（ubuntu + windows 双平台）保持单元/集成/构建门禁，不引入 Electron 启动，保持快速稳定；
- 不追求「全平台 E2E」：Ubuntu 无 python 命令（python3）判题流必跳过，强行跑只会制造 flaky——决策记录于 ROADMAP。
- 缓存：`actions/cache` 缓存 `~/.cache/electron` 与 electron-builder（如已配置）。

## 6. 范围外

- 性能压测（vitest 内独立 perf 测试负责，见 ROADMAP P9）；
- 视觉回归截图（无基线资产，暂不引入）。
