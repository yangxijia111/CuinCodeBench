# V1_2_PRODUCT.md — v1.2 产品定义：Learning Experience

## 1. 一句话定位

CuinCodeBench 从「本地代码练习工具」升级为「能够长期辅助学习 C/C++/Python 的个人编程学习系统」：
以**学习路线**组织练习，以**知识点掌握度**量化进度，以**间隔复习**对抗遗忘，以**错题复盘**沉淀教训，
以**完整备份/恢复**保障数据资产，全部能力保持 Local First / Offline First。

## 2. 目标用户与核心场景

| 场景 | v1.1 现状 | v1.2 目标 |
|---|---|---|
| "我不知道该练什么" | 题库是一个平铺列表 | 学习路线给出顺序：输入输出 → 变量 → … → 指针 → struct |
| "我学了但是老忘" | 无任何机制 | 间隔复习：今日复习队列 + Review Session |
| "我总在同类题上犯错" | 错题本只记"错了几次" | 错题复盘：错误历史、错误代码、错误原因笔记、学习错误分类 |
| "我学到什么程度了" | 只有正确率/连续天数 | 知识点掌握度（可解释规则）+ Knowledge Heatmap |
| "换电脑/重装怎么办" | 无备份 | 设置页一键导出/导入完整备份（事务安全恢复） |
| "我想专项突破" | 只能手翻列表 | 随机练习 + 专项训练（按知识点组队 10 题） |

## 3. 功能范围（In Scope）

1. **完整备份与恢复**（P1）：`cuincodebench.backup` 格式（versioned + zod 全量校验），全量覆盖式恢复，单事务，失败即整体回滚；设置页「数据管理」。
2. **学习路线 Learning Path**（P2）：`LearningPath / LearningStage / KnowledgePoint` 数据模型；内置「C 基础」路线；题目 ↔ 知识点多对多关联；学习路线页面（阶段/知识点/完成度/掌握状态）。
3. **知识点掌握度 Knowledge Mastery**（P3）：not_started / learning / weak / familiar / mastered 五态 + 0~100 分；可解释规则公式（见 V1_2_MASTERY_SPEC.md），防刷分；不使用任何 AI。
4. **间隔复习 Spaced Review**（P4）：`review_items + review_history`；Again/Hard/Good/Easy 四级；确定性阶梯间隔算法（见 V1_2_REVIEW_SPEC.md）；Dashboard「今日复习」+ Review Session 流程。
5. **错题复盘 Mistake Review**（P5）：错误历史（首次/最近错误代码、失败时间线）；`mistake_notes` 错因笔记；`Learning Error Category`（明确规则自动分类 + 手动修正）；错题复练「观察态」。
6. **Dashboard 2.0**（P6）：今日练习/今日复习/连续天数/总量/掌握度/错题待复习/7 天与 30 天趋势（每日提交、AC、复习）/语言分布/错误类型分布 + Knowledge Heatmap；趋势图用自研轻量 SVG，不引入图表库。
7. **练习体验增强**（P7）：练习页上一题/下一题、知识点导航、完成状态与首过标识；随机练习（难度/语言/标签/知识点/未做题/错题/低掌握过滤）；专项训练 + Practice Queue（x/10 进度与总结）。
8. **搜索增强**（P8）：题库搜索扩展到标签与知识点名称；知识点 + 难度组合筛选。
9. **全流程 E2E**（P9）：Playwright `_electron` 驱动真实应用（Windows CI），覆盖 启动→题库→答题→AC→历史→Dashboard→学习路线→复习→错题→备份导出导入恢复。
10. **数据可靠性**（贯穿）：v1.1 → v1.2 自动 migration（幂等、可测试）；外键/唯一约束/索引补齐；删除题目时级联清理 mastery/review/session，杜绝孤儿数据。
11. **Seed 题库扩充**：30~50 道高质量 C 基础题，每题参考解 + 测试用例经真实工具链验证（`seed-verify` 集成测试）；老用户升级时幂等补灌新题（按标题去重，`seeded_v2` 标记）。

## 4. 明确不做（Out of Scope，记录到 v1.3 Roadmap）

AI 辅导 / API 集成；账号系统；云同步；社区；在线 OJ；任何联网服务；
Windows Job Object 资源沙箱；clangd/pyright 智能补全；多文件项目；插件系统；
遥测/行为统计/崩溃云端上报（永久禁止，见 §6）。

## 5. 非功能要求

- **性能**：10000 submissions 量级下 Dashboard / 错题列表 / 复习队列查询均 < 2s（CI 内有性能回归测试）；Dashboard 聚合走 SQL GROUP BY + 索引，不做全表 JS 扫描。
- **安全基线不回退**：contextIsolation / sandbox / nodeIntegration:false / IPC sender 校验 + zod schema / 外部 URL 白名单 / Markdown XSS 防护 / Runner 无 shell 拼接、输出限制、超时、临时目录隔离——v1.2 新增 IPC 全部走同一 `handle()` 统一通道。
- **备份隐私**：备份文件包含用户代码与学习记录，UI 明确提示「备份属于本地私人数据，请勿上传或发送给他人」；应用自身不联网、不上传、无遥测。
- **时间策略**：内部统一 UTC 毫秒时间戳（延续 v1.1 `Date.now()` 约定）；「天」的口径沿用 v1.1 SQLite `localtime` 日历日；复习算法使用可注入时钟（`now()` 参数化）保证跨时区/跨平台测试确定性。
- **可回滚**：migration 只增不删；v1.2 数据库文件被 v1.1 代码打开时，多余表不影响 v1.1 运行（v1.1 `MIGRATIONS` 只认 version 1，`SELECT` 不到 v2 表也不会崩溃）。

## 6. 产品红线（继承 v1.1 并永久生效）

1. 禁止遥测：无 Google Analytics / Sentry 云端 / 行为追踪 / 设备指纹 / 在线统计。
2. 禁止删除用户数据库重建；migration 必须幂等且兼容已有数据。
3. 禁止删除测试 / skip 核心测试 / 降低断言 / `any` / `ts-ignore` / 大量 eslint-disable / 空 catch。
4. 发现 Bug 先写复现测试再修。
5. 不移动已有 tag、不修改 v1.1.0 发布、不 force push。

## 7. 成功标准（Definition of Done）

1. v1.1 全部功能无回归（137+ 项既有测试全绿）。
2. 备份导出 → 清库 → 导入 → 数据完全一致（E2E 验证，含损坏 JSON/错误版本/字段缺失等负路径）。
3. v1.1 数据库自动 migration 成功，老数据零丢失。
4. 学习路线 / 知识点 / 掌握度 / 复习 / 错题复盘 / Dashboard 2.0 / 随机与专项练习全部可用。
5. lint / typecheck / test / build / dist:dir / E2E 全绿；CI 双平台绿灯。
6. 敏感信息扫描通过；`v1.2.0` tag + GitHub Release 成功（含 Windows Setup exe + zip）。
