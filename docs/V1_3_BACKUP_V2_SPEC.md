# Backup v2 规格：流式 NDJSON + Worker + 原子恢复（v1.3）

前身：docs/V1_2_BACKUP_SPEC.md（v1 JSON 信封，v1.2.1 已做 O(N) 读取/原子导出/SHA-256）。
v1.3 目标：**大库内存 O(batch)**、**主进程零重活（worker_threads）**、
**恢复 = staging + 文件级原子切换**、**v1 导入兼容且收敛到同一安全路径**。

## 1. 格式定义（cuincodebench.backup v2）

NDJSON：UTF-8、LF 行分隔、每行一个 JSON 对象、禁止 BOM。
文件扩展名 `.ccbbackup`；导入按**内容显式检测**（首行 meta），绝不按扩展名/首字符猜测。

### 1.1 首行 meta（必须第一行）

```json
{"type":"meta","format":"cuincodebench.backup","version":2,
 "appVersion":"1.3.0","createdAt":1727000000000,"schemaVersion":4,"lineEnding":"lf"}
```

- `format` ≠ cuincodebench.backup → 拒绝（题目导出 JSON 等给可行动提示）；
- `version` > 2 → 拒绝「版本过新」；`version` = 1 且整体是单 JSON → 走 v1 legacy 路径
  （v1 不是 NDJSON，meta 行不会出现；检测顺序：首字节 `{`+整体可解析 → v1 候选；
  首行含 `"type":"meta"` → v2）；
- `schemaVersion`：导出时 DB 当前 schema 版本，仅记录用（恢复目标 schema 由
  staging 迁移决定）。

### 1.2 数据行（type → 载荷）

| type | 载荷 | 行数规模 |
|---|---|---|
| setting | `{key,value}` | 小 |
| learning_path | 完整 path（含 stages/kps 嵌套） | 小 |
| problem | 单题（含 testCases） | 中 |
| problem_knowledge | `{problemId,knowledgePointId}` | 大 |
| submission | 单提交（含 results） | **最大** |
| error_record | 单条 | 大 |
| mistake_book | 单条 | 中 |
| mistake_note | 单条 | 小 |
| mastery | 单条 | 中 |
| review_item | 单条 | 大 |
| review_history | 单条 | 大 |
| review_session_result | 单条 | 中 |
| practice_session | 单会话（含 items） | 中 |

行级 schema = 现有 `backup*Schema`（schemas.ts）的逐行拆分，字段一字不改
（v2 记录与 v1 信封 data 内元素同构，两代格式共享 zod 单源）。

### 1.3 尾行 trailer（必须最后一行）

```json
{"type":"trailer","counts":{"setting":12,"problem":45,"submission":10000,…},
 "bodySha256":"<hex>","bodyBytes":12345678}
```

### 1.4 规范 hash（P8）

- **hash 域 = meta 行末 LF 之后、trailer 行首字节之前的全部原始 UTF-8 字节**
  （含每行结尾 LF；trailer 本身不参与）；
- 导出：流式增量 SHA-256（边写边 hash）；
- 导入：**边读行边增量 hash**，读到 trailer 才比对——禁止先读全文件再 hash；
- `bodyBytes`（body 总字节数）与 `counts` 双重对拍：任一不符即拒绝。

## 2. 导出（流式，内存 O(batch)）

```
worker:
  以只读连接打开 DB 文件（WAL 并发读者；禁用 :memory: → 降级 inline）
  写 meta 行
  按 §1.2 顺序逐表导出：
    每表 rowid 游标分页（SELECT … WHERE rowid > ? ORDER BY rowid LIMIT 500）
    → 行 → serializeLine（JSON.stringify + '\n'）
    → writeStream.write + hash.update
    → 每批检查 cancel 标志、每 100ms 发 progress
  写 trailer（counts = 导出时逐表累计）
  flush → fsync → 关闭临时文件
  rename 临时文件 → 目标路径（原子导出，失败清理临时文件）
```

- 不存在 readAll() 全量对象；任意时刻内存 ≤ 1 批行（500 行）+ 串行化缓冲；
- 主进程只做 dialog / 启动 worker / 转发 progress（100ms 节流）/ cancel；
- 进度：`{phase, processed, total}`，percent 由客户端推算；total 用
  `SELECT COUNT(*)`（大表 COUNT 走索引扫描，10⁶ 行 < 100ms，可接受）。

## 3. 导入 / 校验（流式）

```
worker:
  流式逐行读（readline，行缓冲上限 64MB——单行超限即拒绝，防内存攻击）
  第 1 行 = meta（format/version 校验）
  之后每行 = 记录（zod 行级校验）→ 立即 hash.update(rawLine 含 LF) + counts[type]++
  最后 1 行 = trailer（counts 对拍 + bodySha256 对拍 + bodyBytes 对拍）
  全程不保存已读记录（流过即弃）——预览阶段内存 O(1)
```

- 结构校验与 hash 校验一次完成（preview 阶段）；
- **交叉引用校验不放 preview**（需要全量 id 集合）——放到 staging 落库后用
  SQL/foreign_key_check 检查（§5），这同时让 preview 保持 O(1) 内存；
- preview 产物：summary（counts + createdAt + appVersion + 文件整体 sha256）。

## 4. Worker 协议（主进程 ↔ worker_threads）

消息（postMessage JSON）：

| 方向 | type | 载荷 |
|---|---|---|
| M→W | start-export | `{dbPath, outPath, kind:'v2'}` |
| M→W | start-preview | `{dbPath_UNUSED, filePath}` （纯文件解析，无需 DB） |
| M→W | start-restore | `{filePath, dataDir, stagingPath, backupVersion:'v1'\|'v2'}` |
| M→W | cancel | `{}`（协作式：worker 每批检查） |
| W→M | progress | `{phase, processed, total}` |
| W→M | done | `{kind:'export'，counts}` / `{kind:'preview', summary}` / `{kind:'restore', swapToken…}` |
| W→M | error | `{code, message}`（AppError 同构） |

- 节流：进度每 100ms 或每 1000 条；cancel 后 worker 尽快自退（清理临时产物）；
- worker 异常退出（非正常 exit）：client 统一清理临时文件/staging 后报
  「备份工作线程异常退出，正式数据未改动」；
- `:memory:` DB / worker 创建失败 → **inline 降级**：同一套导出/导入代码在主进程
  同步执行（仅测试与极端环境；生产 userData 必为文件 DB）。

## 5. Restore：staging + 原子 swap（P6 核心）

### 5.1 staging 阶段（worker 内）

```
stagingPath = <dataDir>/restore-staging-<ts>.sqlite
openDatabase(stagingPath)          ← 全新文件，跑满 migrations 到当前 schema
PRAGMA foreign_keys = ON
单事务：
  BackupRepository(staging).clearAll()   ← 迁移后的种子数据清空
  流式逐行（同 §3，含 hash/counts 复验）
  → writeAll 逐行写 staging（batch 事务包裹于外层单事务）
  事务提交（better-sqlite3 同步；磁盘 WAL 承载，内存 O(batch)）
校验（任一失败 → 删 staging → error）：
  PRAGMA foreign_key_check        ← 全部 FK
  PRAGMA integrity_check
  counts 对拍（staging 实际计数 = trailer counts）
  多态引用 SQL 检查：review_items 目标存在性（problem/kp 双表）
  review_session_results ← review_items/practice_sessions 引用检查
PRAGMA wal_checkpoint(TRUNCATE); close; 清理 staging-wal/-shm
```

### 5.2 swap 阶段（主进程 RestoreCoordinator）

前置：`setMaintenanceMode(true)`（业务 IPC gate）→ 关闭正式 DB
（`closeServices()`；WAL checkpoint 由 better-sqlite3 close 完成）。

```
journal = {phase:'swap-start', bak, staging, dbPath}
rename dbPath → dbPath.bak-<ts>          （A：此刻起正式路径缺失）
rename staging → dbPath                  （B：完成即不可逆点之前）
journal = {phase:'swapped'}
reopen：openDatabase(dbPath) + initServices + 恢复后内置内容迁移
  （ensureLearningSeed，同 v1.2.1 confirmRestore 逻辑）
smoke 校验：counts 汇总>0 或 ==0 皆合法；schema_migrations == 当前版本
成功 → 删 .bak（失败仅告警）→ journal 删除 → setMaintenanceMode(false)
       → webContents.reload()（renderer 重新拉全量数据）
失败 → 回滚 rename（.bak → dbPath）→ reopen 旧库 → setMaintenanceMode(false)
       → 报可读错误（不显示 stack）
```

### 5.3 崩溃自愈（restore journal，启动时执行）

restore-state.json 状态表（启动时 `recoverRestoreJournal()`）：

| 发现的 journal phase | 磁盘状态 | 自愈动作 |
|---|---|---|
| staging / validating | staging 存在 | 删 staging（+wal/-shm），删 journal |
| swap-start（A 后 B 前） | .bak 存在、正式路径缺失 | rename .bak → 正式路径，删 staging，删 journal |
| swapped | .bak 与正式路径并存 | integrity_check 正式库：通过 → 删 .bak + staging；失败 → 正式路径删、.bak 还原 |
| 无 journal 但存在 restore-staging-* / *.bak-8601 残留 | 垃圾文件 | 静默清理（>24h 的 .bak 才清，防误删用户手动保留物） |

保证：任意崩溃时刻，`cuincodebench.db` 路径上要么是完整旧库、要么是完整新库
（rename 原子性），绝无半恢复状态。

### 5.4 v1 备份路径（P7）

- 检测：首字节 `{` 且整体 JSON.parse 成功且 format=cuincodebench.backup、version=1；
- worker 内读文件文本（≤512MB 上限保留）→ 现有 zod envelope 校验 →
  BackupRepository.writeAll 写入 **staging**（不再写正式库）→ 同 §5.2 swap；
- v1 无 hash/counts trailer → staging 校验仅 FK/integrity/多态检查 + envelope 内计数
  （expectedCounts 对拍，复用现有逻辑）。

## 6. 取消语义（P8）

- 导出取消：cancel → worker 停止 → 关闭并删除临时文件 → 正式数据不变；
- 导入取消（preview 后不确认）：无任何磁盘副作用（pending 状态内存态，直接清）；
- restore 取消（staging 阶段）：删 staging → 维护模式解除 → 正式库未动；
  **swap 开始后不可取消**（维护模式期间 UI 无取消按钮；协调器忽略迟到 cancel）。

## 7. 限制与默认值（P8）

- 单行上限 64MB；导入文件大小上限 4GB（流式，无理论必要更低）；
- 批大小 500 行；进度节流 100ms/1000 条；
- staging 与正式库同目录（同卷保证 rename 原子）；
- `.bak` 命名 `cuincodebench.db.bak-<ISO 时间戳>`；启动清理仅针对 >24h 的残留；
- 性能门槛（P13）：10k 提交/50k 明细/100k+ 记录导出+预览+恢复全链
  < 30s、worker 峰值内存 < 256MB（CI 规模 1/10，本地跑全规模）。

## 8. 兼容性

| 场景 | 行为 |
|---|---|
| v2 导出 → v2 导入 | 全链路（含 hash/counts/journal） |
| v1 JSON 导出 → 导入 | legacy importer → staging + swap |
| v2 → 旧版应用 | 旧版报「版本过新」（明确提示升级） |
| 题目导出 JSON 误导入备份 | 首行检测 → 指引使用题库导入 |
| 损坏/截断文件 | 行解析失败 / hash 不符 / 缺 trailer → 拒绝，正式数据不变 |
