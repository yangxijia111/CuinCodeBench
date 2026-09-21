# V1_2_BACKUP_SPEC.md — 完整备份与恢复规范

## 1. 备份格式

```json
{
  "format": "cuincodebench.backup",
  "version": 1,
  "createdAt": 1726963200000,
  "appVersion": "1.2.0",
  "data": { ... }
}
```

- `format`：字面量，识别用。
- `version`：**备份格式版本**（v1.2 = 1）。恢复端只接受 `<= 当前支持版本` 的备份；未知更大版本明确拒绝并提示「请升级应用」。
- `appVersion`：导出时的应用版本（提示用，不做硬校验）。
- `data`：全量业务数据，见 §2。

## 2. data 载荷（与表的映射）

| 键 | 来源表 | 结构 |
|---|---|---|
| `settings` | settings | `Record<string,string>`（键值原样） |
| `learningPaths` | learning_paths（含 stages → knowledgePoints 嵌套） | 见 §4.1 |
| `problems` | problems + test_cases | `ProblemDetail[]`（含 id 与 testCases[].id） |
| `problemKnowledge` | problem_knowledge_points | `{problemId, knowledgePointId}[]` |
| `submissions` | submissions + test_case_results | `{Submission, results: TestCaseResult[]}[]`（保留原 id 与 created_at） |
| `errorRecords` | error_records（含 learning_category/category_source） | `ErrorRecord[]` |
| `mistakeBook` | mistake_book | 原行 camelCase 化 |
| `mistakeNotes` | mistake_notes | `{problemId, note, updatedAt}[]` |
| `mastery` | mastery | `MasteryInfo[]` |
| `reviewItems` | review_items | `ReviewItem[]` |
| `reviewHistory` | review_history | `ReviewHistoryEntry[]` |
| `practiceSessions` | practice_sessions（含 items） | `{...session, items}[]` |

设计要点：
- 保留全部主键/外键 id（id 均为应用生成的 UUID，无跨库冲突风险）；
- 保留 `created_at` 等原始时间戳（恢复后统计/趋势/连续天数不漂移）；
- 父子关系用嵌套表达（恢复顺序天然正确）。

## 3. zod 全量校验

`shared/schemas.ts` 定义 `backupEnvelopeSchema`：
- 信封：format/version/createdAt/appVersion/data 严格校验；
- `data` 每个键对应数组/对象 schema，字段级约束与数据库 CHECK 一致（难度枚举、状态枚举、score 0~100、超时范围等）；
- 交叉校验（恢复前于主进程执行）：
  - `submissions[].problemId` ⊆ `problems[].id`；
  - `problemKnowledge` 两端 id 均存在；
  - `reviewItems.target_id` 指向存在的知识点/题目；
  - `reviewHistory.review_item_id` ⊆ `reviewItems[].id`；
  - `mastery.knowledge_point_id`、`mistakeNotes.problemId`、`practiceSessions` 引用完整；
  - 违反 → 恢复拒绝（`validation` 错误，列出前若干条问题）。
- 大小上限：文件 ≤ 512 MB（`data` 数组长度的合理性由 schema 的 max 数量约束兜底）。

## 4. 恢复流程（事务安全）

```
用户点击「导入备份」
 → 主进程 dialog.showOpenDialog（.json / 全部文件）
 → 读文件（UTF-8，≤512MB）
 → JSON.parse（失败 → 明确报错「不是合法 JSON」）
 → backupEnvelopeSchema.parse（失败 → 报告首个 schema 错误位置）
 → 交叉引用校验（§3）
 → 版本兼容检查（version ≤ 1）
 → 生成预览摘要（题目/提交/知识点/复习/练习会话计数 + 导出时间 + appVersion + 警告文案）
 → UI 确认对话框：「恢复将【全量替换】当前全部数据（题库、提交历史、错题、学习记录、掌握度、复习与练习记录、设置）。此操作不可撤销。建议先导出当前数据作为备份。」
 → 用户确认 → backup.confirmRestore
```

### 4.1 confirmRestore 执行（单一 SQLite 事务）

```
BEGIN（better-sqlite3 db.transaction）
  1) 按依赖序 DELETE 全部业务表（子→父）：
     practice_session_items → practice_sessions → review_history → review_items →
     mastery → mistake_notes → error_records → test_case_results → submissions →
     mistake_book → problem_knowledge_points → test_cases → problems →
     knowledge_points → learning_stages → learning_paths → settings
  2) 按依赖序 INSERT 备份数据（父→子；id/时间戳原样）
  3) settings 恢复：以备份为准；备份缺失的键（如旧版无 seeded/learning_v2_mapped）保留本地现值
     —— 显式回写本地的 seeded 标记，防止恢复后种子逻辑误触发
  4) verify：逐表 COUNT(*) 对比备份数组长度，任何不一致 → 抛错
COMMIT（任一步骤抛错 → 整体回滚，数据库保持恢复前状态）
```

- **不切换 `PRAGMA foreign_keys`**（事务内无效）：依赖既有的 `ON DELETE CASCADE` + 显式删除顺序保证中间状态合法。
- 恢复完成后：清空 pendingImport；UI `location.reload()` 重新拉取全部数据（HashRouter 状态保留）。
- 恢复失败：错误信息包含失败阶段（parse/schema/cross-ref/tx/verify），数据库保证原样。

### 4.2 备份兼容性

- v1.1 数据库升级到 v1.2 后导出的备份即 §1 格式（含 v2 表）；
- 不支持 v1.1 应用导入 v1.2 备份（格式不同，导入入口不存在，无需处理）。

## 5. 导出流程

1. `backup.export()`：主进程组装 data → `JSON.stringify(envelope)`（2 空格缩进）；
2. `dialog.showSaveDialog`，默认文件名 `CuinCodeBench-Backup-YYYYMMDD-HHmmss.json`（本地时区）；
3. 写文件（UTF-8）；成功返回 `{path, counts}`，UI 展示摘要。

## 6. IPC 与安全

| 通道 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `backup.export` | 无 | `{path, counts}` | 主进程弹保存框并写盘 |
| `backup.importPreview` | 无 | `{fileName, createdAt, appVersion, counts, warnings}` | 主进程弹打开框；解析+校验；`pendingImport` 缓存在**主进程内存** |
| `backup.confirmRestore` | 无 | `{counts}` | 只消费 pendingImport，执行事务恢复 |
| `backup.cancelImport` | 无 | `void` | 清除 pendingImport |

- **renderer 永远不传文件路径**：路径只来自主进程 dialog，pendingImport 存主进程内存（纵深防御：即使 renderer 被攻破也无法指定任意路径写入/读取）。
- 全部通道走统一 `handle()`（sender 校验 + zod；本组无入参，`z.unknown()`）。
- 一次只允许一个 pendingImport；confirmRestore 时二次校验文件存在与 mtime 未变（防「预览后文件被调包」），不一致则拒绝并要求重新选择。

## 7. 隐私声明（UI 固定文案）

> 备份包含你的全部代码、提交历史与学习记录，属于**本地私人数据**。请妥善保管，不要上传到网络或发送给他人。CuinCodeBench 自身不会上传、同步或发送任何数据。

## 8. 测试要求（验收，`tests/backup.test.ts` + E2E）

正路径：
1. 建全量数据（题目/提交/错误/错题/笔记/知识点/映射/mastery/review/history/session）→ 导出 → 清库 → 恢复 → **逐表逐行完全一致**（深度对比，含时间戳与 id）；
2. 空数据库备份 → 恢复到另一空库 → 一致；
3. 恢复后统计一致性：Dashboard 计数 / 连续天数与恢复前相同。

负路径（全部整体回滚，数据库保持原状）：
4. 损坏 JSON → 报错，原数据无损；
5. format 错误 / version 更大 / version 缺失 → 明确拒绝；
6. 字段缺失（如 problems 缺 testCases）→ schema 拒绝；
7. 交叉引用断裂（submission 指向不存在题目）→ 拒绝；
8. 重复数据（主键冲突的题目）→ 拒绝；
9. **事务中途失败注入**：restore 执行中在某表 INSERT 后抛错 → 全表回滚（原数据逐表一致）；
10. 恢复后 verify 计数不匹配注入 → 回滚；
11. confirmRestore 前文件被替换/删除 → 拒绝并要求重新导入。
