# TEST_PLAN.md — 测试计划

工具：vitest（版本随 package.json）。分层：**单元**（纯逻辑/DB）、**集成**（Runner 真实执行、service 组合）、**UI**（轻量组件 + 核心流程 mock）。命令：`npm run test`（一次性）、`npm run test:watch`。

## 1. 单元测试

### 1.1 判题核心（judge/normalize，验证 FR-J4）

| 用例 | 输入 → 期望 |
|---|---|
| CRLF 归一 | `"1\r\n2\r\n"` vs `"1\n2\n"` → AC |
| 孤立 CR | `"a\rb"` vs `"a\nb"` → AC |
| 行尾空格 | `"1 \t\n2"` vs `"1\n2"` → AC |
| 末尾换行差异 | `"1\n2"` vs `"1\n2\n\n\n"` → AC |
| 行首空格敏感 | `" 1"` vs `"1"` → WA |
| 中间空行敏感 | `"1\n\n2"` vs `"1\n2"` → WA |
| 完全相同 | 任意相同文本 → AC |
| 空输出 vs 空输出 | `""` vs `""` → AC |
| 空输出 vs 换行 | `""` vs `"\n"` → AC |
| 数字内容不同 | `"12"` vs `"13"` → WA |
| 多行大文本 | 1000 行随机对比正确 |

### 1.2 判定策略（judge/normalize，验证 FR-J2/J5）

- 全 AC → accepted；第一个失败用例状态决定总体（含 WA→WA、RE 优先于后续 WA 等顺序性）
- exitCode≠0 → runtime_error；超时 → tle；超限 → ole；编译失败 → compile_error（用例全 skipped 语义由 service 层验证）

### 1.3 语言配置与命令构造（runner/languages，验证 FR-R1/R3）

- 各语言 sourceExt、编译/运行 argv 纯函数输出（gcc/g++/clang/MSVC/python 分支），断言为数组、不含 shell 元字符拼接点
- MSVC cl 参数（/std:c11、/Fe: 等）；python `-I` 参数

### 1.4 数据库（db，验证 NFR-2、FR-H3）

- 内存库跑 migration：版本推进、重复应用幂等
- problem-repo CRUD：创建→读→更新→删除；级联删除用例
- test-case-repo：排序、更新、级联
- history-repo：提交写入/明细写入/按题目分页/统计口径（尝试次数、首次通过时间）
- mistake-repo：聚合重算、mastered 保留
- settings-repo：读写合并默认值
- stats：正确率、连续天数（构造跨天数据）、语言分布、错误类型 Top

### 1.5 服务层（services）

- problem-service：创建校验（标题长度、用例数 1-50、timeout 范围）、JSON 导入合法/非法（zod 错误路径）、导出信封格式、搜索与筛选组合
- mistake-service：0/1/多次失败 → 是否进入列表；AC 后保留；mastered 后隐藏、可恢复
- judge-service（mock runner）：编排正确、结果落库、错误记录生成、无工具链友好错误
- seed：灌入幂等（二次启动不重复）

## 2. Runner 集成测试（真实子进程）

策略：**条件执行**——检测到对应工具链才跑（`describe.skipIf`）；另设 **node 桩语言**（把 `.cjs` 文件交给 `node` 解释执行）用于在无任何编译器的机器上验证 Runner 全管线。本机已有 MSVC + Python + 便携 MinGW（.tools/），三类都会真实执行。

| 用例 | 语言 | 验证（FR-R*） |
|---|---|---|
| Hello World | 全部 | 编译+运行、stdout 捕获、exit 0 |
| stdin/stdout 回显求和 | 全部 | stdin 写入、交互输出 |
| 编译错误 | C/C++ | compile_error、stderr 全文、exit code |
| 运行时错误 | 全部 | C 段错误 / Python 异常 → 非零 exit、stderr |
| 无限循环超时 | 全部 | TLE、进程树被杀（无残留）、耗时≈timeout |
| 大量输出（>1MB） | 全部 | OLE、截断标记 |
| Unicode（中文/emoji） | 全部 | UTF-8 往返一致 |
| 空输入 | 全部 | stdin 为空串正常结束 |
| 多用例顺序执行 | 全部 | 逐用例结果 |
| 输出含 CRLF | 全部 | 原样捕获（归一化交给 judge） |
| 临时目录清理 | 全部 | 运行后目录被删除 |
| 超时杀树（子进程派生孙进程） | C（Windows） | `system("app2.exe 循环")` 场景孙进程同死 |

## 3. UI 核心流程（@testing-library/react，jsdom）

范围取舍：不渲染 CodeMirror 的组件做组件测试；编辑器行为以 Runner/Judge 集成 + 手工验收清单兜底（记录于 FINAL_REPORT）。

- App 路由壳：五个视图可达、侧栏导航
- 题目列表：mock api → 搜索/难度/标签筛选联动
- 练习页（mock 编辑器为纯 textarea 桩）：判题按钮 → 结果面板状态渲染（AC/WA/CE/TLE 分支）
- Dashboard：mock 数据 → 卡片数值渲染
- ErrorBoundary：api 抛错时展示兜底 UI

## 4. 异常情况测试

| 场景 | 期望 |
|---|---|
| 判题时工具链缺失 | 友好错误对象，UI 提示（FR-R9） |
| 题目无用例 | internal_error + 明确消息 |
| DB 迁移失败 | 启动失败、错误可见 |
| 导入非法 JSON | zod 错误路径返回，不落库 |
| 运行中删除题目 | 提交写入外键失败 → 转 internal_error，不崩溃 |
| 临时目录被占用 | 清理重试后放弃并告警，不影响后续任务 |

## 5. 覆盖率目标

核心纯逻辑（normalize/verdict/languages/服务层/repo）≥ 90% 行覆盖；Runner 集成以行为断言为主不追求覆盖率数字。`npm run test:coverage` 查看。

## 6. 每阶段门禁（与 ROADMAP 对齐）

每个 Phase 完成：`npm run lint && npm run typecheck && npm run test && npm run build` 全绿后才 commit。
