# V1_2_FINAL_REPORT.md — v1.2.0 最终报告

**版本**：v1.2.0 — Learning Experience
**发布日期**：2026-09-22
**仓库**：https://github.com/yangxijia111/CuinCodeBench
**Release**：https://github.com/yangxijia111/CuinCodeBench/releases/tag/v1.2.0
**Tag**：`v1.2.0`（HEAD：6eb1d64）

## Summary

v1.2.0 将 CuinCodeBench 从「本地代码练习工具」升级为「个人编程学习系统」：
学习路线组织练习、可解释规则量化知识点掌握度、确定性间隔复习对抗遗忘、
错题复盘沉淀教训、完整备份保障数据资产，全程保持 **Local First / Offline First**，
无 AI、无遥测、无联网。v1.1 全部功能与安全基线无回归。

**质量门禁**：lint / typecheck / **302 项单元与集成测试** / build / dist:dir / **8 项 Electron E2E** 全绿；
CI 双平台（ubuntu + windows）+ E2E workflow + Release workflow 全部成功。

## Learning Path（学习路线）

- 数据模型：`learning_paths / learning_stages / knowledge_points / problem_knowledge_points`（题目↔知识点 N:N）
- 内置「C 基础」路线：6 阶段 15 知识点（输入输出 → 变量 → 运算符 → 分支 → 循环 → 数组与字符串 → 函数 → 指针与结构体），确定性 id 幂等灌入
- 学习路线页：路线总览进度条、阶段卡片、知识点完成度 x/y 与掌握状态、点击展开题目开始练习、专项训练入口
- 旧题自动映射：升级时对内置题按显式映射表 + tag 别名兜底一次性绑定（`learning_v2_mapped` 标记），用户题目手动绑定
- 聚合进度单 SQL 查询（无 N+1），绑定/解绑幂等

## Knowledge Mastery（知识点掌握度）

- 可解释公式：`score = 0.45×表现 + 0.30×覆盖 + 0.15×复习 + 0.10×连击`（指数衰减 0.85）
- 防刷分：每题表现样本上限 2 次；知识点题目数 <3 时信心折扣；mastered 硬性门槛（score≥80 且折后 coverage≥70 且复习无连续 again）
- 五态：not_started / learning / weak / familiar / mastered；weak 优先级判定；45 天无活动惰性衰减
- 物化缓存可全量重算（幂等）；判题落库 hook 自动重算（失败不阻断判题）
- 规范与测试：V1_2_MASTERY_SPEC.md §7 全部 9 类场景（13 项测试）

## Review Algorithm（间隔复习）

- 确定性阶梯表：good [1,3,7,14,30,60] 天 / easy [2,5,10,21,45,60] / hard ×1.2 / again 当日 10 分钟重现；60 天封顶；纯函数对拍
- 复习项生命周期：错题入选（失败≥2）即到期；知识点首次学习次日进入循环；标记掌握删除、再次失败重建
- Review Session：错题优先组题、知识点展开、会话去重、判题 hook 自动回报、完成自动按默认映射评分（AC→good 失败→again）并推进调度
- Dashboard「今日复习」计数与按知识点聚合
- 规范与测试：V1_2_REVIEW_SPEC.md §8 全部场景（11 项测试）

## Mistake Review（错题复盘）

- 错误历史时间线（状态/语言/错误信息/错误代码），从 submissions + error_records 派生（无冗余存储）
- 首次/最近错误代码对比
- 错因笔记（`mistake_notes`，本地）
- 学习错误分类：编译→语法、超时→算法效率（自动，可靠才判定）；其余手动归类（10 类），`unknown` 不伪装判断
- 错题本「错误复盘」展开 UI（7 项测试）

## Backup & Restore（完整备份与恢复）

- `cuincodebench.backup` versioned 格式（version=1），zod 全字段校验 + 交叉引用完整性校验
- 恢复单一事务：依赖序清空 → 写回 → 逐表计数 verify；任一失败整体回滚（含中途失败注入测试）
- settings 标记键保留本地（防种子误重灌）；备份内含标记则以备份为准
- IPC 安全：文件路径只在主进程（dialog + pendingImport 内存态 + mtime 防调包），renderer 不传路径
- 设置页「数据管理」：导出/导入/确认对话框/隐私提示（13 项测试 + E2E 闭环）

## Dashboard（Dashboard 2.0）

- 新增：今日复习、错题待复习、知识点掌握度列表；7/30 天趋势（每日提交/AC/复习，SQL 聚合 + 本地日历日连续序列）
- 自研轻量 SVG 趋势图（无新依赖）；Knowledge Heatmap（颜色进度条 + 点击进入学习路线）
- 10000 提交量级 Dashboard 查询 < 2s（性能门禁测试）

## Practice Experience（练习体验）

- 练习页：上一题/下一题（题库顺序导航 + 位置指示）、知识点徽章（点击进入学习路线）
- 随机练习：难度/语言初始代码/知识点过滤 + 未做题/错题/低掌握度范围，随机组题（5/10/20）
- 专项训练：学习路线知识点一键组题；练习会话页（进度 x/y、判题自动回报、完成总结：正确率与首次 AC 数）

## Database Migration（数据库迁移）

- SQLite schema 1 → 2：新增 10 张表（学习路线/掌握度/复习/错题笔记/练习队列）+ error_records 学习分类列
- 只增不删；v1.1 数据零改动；v1.1 代码可打开 v2 库；幂等（schema_migrations）
- 孤儿数据兜底清理 SQL；删除题目级联覆盖全部 v2 表
- 测试：单元（升级/幂等/约束）+ E2E（手工构造 v1 库 → v1.2 启动 → 旧数据完整 + 路线灌入 + 旧题映射）

## E2E（端到端测试）

- **选型记录**：Playwright `_electron.launch`（1.49 / 1.63 实测）loader 劫持 `app.whenReady` 后其 CDP 连接与 Electron 44 断开（code=1006）导致应用挂起；原生 DevTools 端点正常 → **自制 CDP harness**（spawn electron + stderr 解析端口 + WebSocket Runtime.evaluate / Input 域），零新增运行时依赖
- 8 个用例：启动/学习路线/Dashboard/复习页/设置数据管理/判题闭环（真实 python 判题→错题→笔记→复习会话→调度推进 + 数据层验证）/备份导出导入恢复/v1.1→v1.2 迁移
- 测试钩子：仅 `CCB_E2E=1` 时替换文件对话框为受控桩并关闭 sandbox（生产不受影响）
- 独立 workflow：`.github/workflows/e2e.yml`（windows-latest）

## Performance（性能）

- 门禁测试（tests/perf-large-db.test.ts）：100 题目 / 10000 提交 / 大量错误与复习数据下，
  Dashboard、错题列表、复习到期队列、学习路线聚合、关键词搜索均 < 2s（本机实测最大 ~700ms）
- 索引依据：idx_submissions_problem、idx_submissions_created、idx_review_due、idx_pkk_kp 等；聚合走 SQL，无全表 JS 扫描

## Security（安全）

- v1.1 安全基线零回退：外部 URL 白名单、IPC sender 校验、Markdown XSS 防护、contextIsolation/sandbox、Runner 无 shell 拼接、输出限制、超时、临时目录隔离——v1.2 新增 IPC 全部走统一 `handle()`（sender 校验 + zod）
- E2E 测试钩子（CCB_E2E）仅测试进程生效，生产行为不变
- 安全扫描：API Key / Token / Password / Private Key / .env / Cookie / 数据库 / 日志 / 真实用户数据 / 备份文件 / 绝对个人路径 —— 全部无命中；npm audit 0 漏洞；测试/运行时数据目录（.e2e-data）不入库

## Tests（测试）

| 层 | 数量 | 说明 |
|---|---|---|
| 单元 + 集成 | 302 | v1.1 的 137 项全保留无回归 + v1.2 新增 165 项 |
| 种子验证 | 92 | 45 题 × C/Python 参考解真实工具链逐用例验证（无工具链自动跳过）+ 结构检查 |
| E2E | 8 | 真实 Electron 产物 CDP 驱动（windows） |

## CI（持续集成）

- `ci.yml`：ubuntu（快速门禁）+ windows（真实 MSVC/Python 工具链）双平台 — **绿灯**（run 35686440914）
- `e2e.yml`：windows-latest 端到端 — **绿灯**（run 35686440866）
- `release.yml`：tag 触发构建发布 — **成功**（run 35686916833）

## Build（构建）

- `npm run build`：三端产物 ✓；`npm run dist:dir`：win-unpacked ✓；`npm run dist`：NSIS + zip（由 Release workflow 产出 ✓）
- electron-builder extraResources 补充 seed-learning-path.json

## Release（发布）

- Tag：`v1.2.0`（push 触发 Release workflow，7m32s 完成）
- GitHub Release：https://github.com/yangxijia111/CuinCodeBench/releases/tag/v1.2.0
- 资产确认：`CuinCodeBench-Setup-1.2.0.exe`（Windows 安装器）+ `CuinCodeBench-1.2.0-win-x64.zip`（便携版）✓
- Changelog：docs/CHANGELOG.md `[1.2.0]`（Added/Changed/Fixed/Testing 分类完整）

## Seed Problems（种子题库）

- 10 → **45 道**（新增 35 道高质量 C 基础题，覆盖全部知识点）；标题唯一；每题三语言参考解
- `referenceSolution` 机制：v1.1 骨架题（含 TODO 的学生初始代码）与参考解分离
- 真实工具链验证：gcc 16.2.0 + Python 3.13 逐题逐用例比对（judge 同款归一化）

## Known Limitations（已知限制）

1. 判题仍为串行队列、无内存/CPU 限制（沙箱定位不变）
2. 复习评分的「四档手动改评」UI 保留在完成确认流程，但判题 hook 自动收尾路径按默认映射（AC→good 失败→again）推进，暂无改评入口
3. 错题错误分类的历史数据不回填（诚实原则），仅新错误自动分类 + 手动补录
4. 学习路线仅内置「C 基础」一条；多路线管理 UI 未做（数据模型已支持）
5. E2E 未覆盖 Ubuntu（判题依赖 python 命令且 Electron GUI 场景 Windows 为真实用户平台）
6. 备份文件为明文 JSON（含代码与学习记录），文档已提示隐私注意事项

## Deferred to v1.3（推迟项）

Windows Job Object 沙箱、clangd/pyright、智能补全、多文件项目、云同步、账号、在线题库、AI 辅导、插件系统、
错题错误代码 diff 视图、复习日历热力图、跨路径多路线管理 UI、复习四档改评入口、备份加密。

## 提交清单（v1.1.0 → v1.2.0）

```
6eb1d64 test(e2e): 判题流最终断言兼容完成统计页
d2073b8 ci(e2e): npm ci 后显式安装 Electron 二进制
f426602 chore: release v1.2.0（版本/CHANGELOG/README）
9cde9e6 feat(p9): 全流程 E2E（自制 CDP 驱动 Electron）+ e2e workflow
9a0d301 feat(p9-seed): 题库扩充至 45 题全部真实工具链验证 + 性能门禁
40fd26a feat(p7,p8): 练习体验增强 + 随机练习/专项训练 + 搜索增强
9e02754 feat(p6): Dashboard 2.0
76240b4 feat(p5): 错题复盘增强
099f823 feat(p4): 间隔复习系统
a0295f3 feat(p3): Knowledge Mastery 掌握度模型
9ddc6db feat(p2): 学习路线页面 + 题目知识点绑定 + 进度聚合
4c9c1df feat(p1): 完整备份与恢复
07f4b1e feat(p0): 数据库 v2 migration + 内置学习路线种子 + 领域类型
e6fd941 docs: v1.2 设计文档（7 份）
```
