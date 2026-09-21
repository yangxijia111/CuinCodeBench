# V1_2_ROADMAP.md — v1.2 执行路线（P0–P10）

> 执行原则：数据可靠性 → 学习模型正确性 → 复习体验 → 错题复盘 → 学习路线 → 测试 → UX → 性能。
> 每个 Phase 完成即：实现 → lint → typecheck → test → build →（适用时 E2E）→ 修复 → 再验证 → 更新 docs/CHANGELOG → commit → 自动继续。

## P0 数据库 Migration v2 + 领域类型

- **目标**：v2 migration（全部新表/新列/索引/孤儿清理 SQL）；shared 层类型与 zod schema；内置学习路线种子资源（`seed-learning-path.json`）与幂等灌入；旧 builtin 题自动映射（`learning_v2_mapped`）。
- **模块**：`db/migrations.ts`、`shared/types.ts`、`shared/schemas.ts`、`main/learning/*`、`main/index.ts`（启动灌入）。
- **数据库变化**：本路线图 §P0 即 LEARNING_MODEL §2 全量 DDL。
- **验收**：v1.1 库打开自动升级；旧数据零丢失；灌入幂等（重启不重复）；migration 单测覆盖（v1 库→v2、重复迁移、孤儿清理）。
- **测试**：`tests/migrations.test.ts`。
- **回滚风险**：低——只增不删；v1.1 代码可继续打开 v2 库（不认识的表无影响）。

## P1 完整备份与恢复

- **目标**：BACKUP_SPEC 全量实现（backup-service + 4 IPC + 设置页「数据管理」）。
- **验收**：BACKUP_SPEC §8 全部 11 条用例通过；UI 流程可用（导出/预览确认/恢复/reload）。
- **测试**：`tests/backup.test.ts`（含事务中途失败注入）。
- **回滚风险**：中——恢复是破坏性操作，靠预览确认 + 单事务 + verify 兜底。

## P2 学习路线 Learning Path

- **目标**：learning-service（路径/阶段/知识点/完成度聚合）；题目↔知识点绑定/解绑（题目编辑页 + 题库列表筛选）；学习路线页面（阶段进度条、知识点 x/y、掌握状态、点击进入题目列表）。
- **验收**：路线页展示 C 基础全部阶段与知识点；做过的题实时反映完成度；绑定变更即时可见。
- **测试**：`tests/learning-path.test.ts`（聚合查询、绑定级联、映射规则）。
- **回滚风险**：低。

## P3 Knowledge Mastery

- **目标**：MASTERY_SPEC 公式实现（mastery-service + `mastery.list`/`recalc` IPC）；判题 hook 接入；学习路线页/题库展示掌握状态。
- **验收**：MASTERY_SPEC §7 全部 9 条测试通过；防刷分（单题刷满 ≤ familiar）。
- **测试**：`tests/mastery.test.ts`（注入时钟）。
- **回滚风险**：低——物化缓存可随时全量重算。

## P4 间隔复习系统

- **目标**：REVIEW_SPEC 全量（review-service + 调度阶梯表 + Review Session 流程页 + Dashboard「今日复习」卡片 + 完成页统计）。
- **验收**：REVIEW_SPEC §8 全部 8 条测试；错题入选即到期可复习；完成页四项统计正确。
- **测试**：`tests/review-scheduler.test.ts`（纯函数对拍 + 注入时钟集成）。
- **回滚风险**：低。

## P5 错题复盘增强

- **目标**：错误历史（首次/最近错误代码 + 失败时间线，从 submissions 派生）；`mistake_notes` 笔记 UI；错误分类（自动规则 §MASTERY 6 + 手动选择）；「重新练习」观察态衔接（复习系统已覆盖）。
- **验收**：错题详情可看完整错误历史；笔记保存回显；分类自动/手动均可落库。
- **测试**：`tests/mistake-review.test.ts`。
- **回滚风险**：低。

## P6 Dashboard 2.0

- **目标**：stats-repository 扩展（今日复习、7/30 天趋势聚合、掌握度概览、错题待复习）+ Knowledge Heatmap + 自研 SVG 趋势图；`stats.dashboardV2`。
- **验收**：全部指标卡片有数据；10000 提交量级 < 2s（性能测试）；趋势图纯 SVG 无新依赖。
- **测试**：`tests/dashboard-v2.test.ts` + `tests/perf-large-db.test.ts`。
- **回滚风险**：低。

## P7 练习体验增强 + Practice Queue

- **目标**：练习页上一题/下一题 + 知识点导航 + 完成状态/首过/掌握度标识；随机练习（难度/语言/标签/知识点/未做/错题/低掌握过滤）；专项训练 + 队列进度与总结。
- **验收**：会话进度 x/y 正确推进；完成统计（正确率/首次 AC/错误类型/掌握度变化）正确。
- **测试**：`tests/practice-session.test.ts`。
- **回滚风险**：低。

## P8 搜索增强

- **目标**：keyword 覆盖标题/描述/标签/知识点名称；`knowledgePointId` 筛选与难度组合。
- **验收**：`数组 + Easy` 组合正确；知识点名称可搜到关联题。
- **测试**：并入 `tests/learning-path.test.ts` / `problem-service` 扩展用例。
- **回滚风险**：低。

## P9 Seed 扩充 + 性能验证

- **目标**：题库扩至 30~50 道经真实验证的 C 基础题（`seed-verify` 集成测试批量跑参考解）；老用户 `seeded_v2` 幂等补灌；`perf-large-db` 性能门禁（100 题/10000 提交/大量错误与复习数据）。
- **验收**：种子验证测试在有工具链的机器全绿；性能阈值内。
- **测试数据**：运行时动态生成，**不提交**任何生成的数据文件。
- **回滚风险**：低。

## P10 全流程 E2E + 最终审计 + Release

- **目标**：E2E_PLAN 全量落地（Playwright + e2e.yml workflow）；12 项最终审计（Learning UX / Database / Migration / Backup / Mastery / Review Scheduler / Mistake / Dashboard / E2E / Performance / Security Regression / Documentation）；最终门禁（ci/lint/typecheck/test/build/dist:dir/E2E 全绿）；安全扫描；版本 1.2.0 + CHANGELOG + README；`v1.2.0` tag → Release workflow → GitHub Release 确认；`V1_2_FINAL_REPORT.md`。
- **验收**：PRODUCT §7 成功标准逐条满足；CI 双平台绿灯 + E2E workflow 绿灯；Release 含 Setup exe + zip。
- **回滚风险**：低。

## 依赖关系

```
P0 → P1（备份需含 v2 表）
P0 → P2 → P3 → P4（掌握度依赖知识点；复习依赖掌握度与错题）
P2 → P7（知识点导航）、P8（知识点筛选）
P4 → P5（观察态）、P6（今日复习卡片）
P0..P9 → P10
```

## 推迟到 v1.3（V1_2_PRODUCT §4 + 执行中发现的可延后项）

Windows Job Object 沙箱、clangd/pyright、智能补全、多文件项目、云同步、账号、在线题库、AI 辅导、插件系统、（新增）错题错误代码 diff 视图、复习日历热力图、跨路径多路线管理 UI。
