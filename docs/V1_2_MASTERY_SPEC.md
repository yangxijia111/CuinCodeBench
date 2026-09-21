# V1_2_MASTERY_SPEC.md — 知识点掌握度规范（可解释规则，无 AI）

## 1. 原则

1. **可解释**：分数由四个命名因子按固定权重合成，任何分数都能还原为因子明细。
2. **可重算**：掌握度是 `submissions + review_history` 的纯函数（物化缓存），随时可全量重建，无增量漂移。
3. **防刷分**：单题重复提交的边际收益快速衰减；小样本知识点受「信心折扣」封顶；掌握（mastered）有硬性覆盖门槛。
4. **确定性**：无随机、无浮点累计误差敏感逻辑；同输入必同输出。

## 2. 输入

对知识点 `K`：
- `P(K)`：关联 `K` 的题目集合，题目数 `N = |P(K)|`。
- `S(K)`：`P(K)` 中全部提交，按 `created_at` 升序。
- `R(K)`：`K` 的 review_item 的复习历史（仅知识点项，题目复习不重复计入）。

## 3. 因子定义

### 3.1 表现 performance（0~100）

取 `S(K)` **最近 10 次提交**为候选样本：
- **同一题最多计入 2 次**（取该题最近的 2 次提交，其余丢弃）→ 有效样本序列 `v_0..v_m`（时间倒序，`m < 10`）；
- 样本值：`accepted = 1`，否则 `0`；
- 指数衰减权重 `w_i = 0.85^i`（最近一次权重 1.0）；
- `performance = Σ(v_i·w_i) / Σ(w_i) × 100`（四舍五入取整；无样本 → 因子缺失）。

> 防刷分：同一题刷 100 次 AC，有效样本只有 2 个，无法挤占其他题的表现权重。

### 3.2 覆盖 coverage（0~100）

```
covered = |{p ∈ P(K) : p 至少 1 次 accepted}|
confidence = min(1, N / 3)          —— 信心折扣：知识点下题目数 < 3 时打折
coverage = covered / N × confidence × 100     （N = 0 → 知识点未启用）
```

> 单题知识点（N=1）即使 AC，coverage 最高只有 33.3，配合 §3.4 状态门槛，刷一题永远到不了 mastered。

### 3.3 复习 reviewScore（0~100）

`R(K)` 最近 5 次：`good/easy = 1`，`hard = 0.5`，`again = 0`；权重 `0.85^i` 归一化（同 §3.1）。
**无复习历史 → 中性值 50**（复习不是掌握的先决条件，但会影响分数与门槛）。

### 3.4 连续 streakBonus（0~100）

`S(K)` 末尾连续 accepted 的提交数 `c`（跨题）：`streakBonus = min(c, 5) / 5 × 100`。

### 3.5 合成

```
score = round( 0.45×performance + 0.30×coverage + 0.15×reviewScore + 0.10×streakBonus )
```

| 权重 | 因子 | 直觉 |
|---|---|---|
| 0.45 | performance | 最近做这类题的真实表现 |
| 0.30 | coverage | 覆盖面（有多少题真的做出来了） |
| 0.15 | reviewScore | 间隔复习的反馈 |
| 0.10 | streakBonus | 当前状态热身程度 |

## 4. 状态判定（优先级从上到下，首条命中即止）

| 优先级 | 条件 | 状态 |
|---|---|---|
| 1 | `S(K)` 为空（从未提交） | `not_started`（score=0） |
| 2 | 最近 5 次提交中失败 ≥ 3 | `weak` |
| 3 | score ≥ 80 且 折后 coverage ≥ 70 且 R(K) 末尾无连续 2 次 again | `mastered` |
| 4 | score ≥ 60 | `familiar` |
| 5 | 其余 | `learning` |

**时间惰性衰减**（重算时执行）：`now − 该知识点最近活动时间（最后提交或最后复习）> 45 天` 且当前状态为 `mastered` → 降为 `familiar`（score 不变；继续练习或复习即恢复）。

## 5. 重算时机

- 判题落库后（`judge-service.persist` → `recalcForProblem(problemId)`：该题关联的全部知识点）；
- 复习评分后（该知识点）；
- 题目删除 / 知识点绑定变更后（受影响知识点）；
- 恢复备份后不立即重算（备份内含 mastery 快照，恢复即一致）；用户可经 `mastery.recalc` 手动全量重算。

重算是幂等覆盖写（`INSERT OR REPLACE`），并发安全由主进程单线程 + 串行判题队列保证。

## 6. Learning Error Category（学习错误分类，明确规则，非 AI）

**与判题状态（compile_error 等）分离**：判题状态回答"怎么失败的"，学习分类回答"是什么类型的错误"。

自动规则（仅在可靠可判时落库，`category_source='auto'`）：

| 判题状态 | 自动分类 | 依据 |
|---|---|---|
| `compile_error` | `syntax` | 编译失败几乎必然是语法/类型/声明问题 |
| `time_limit_exceeded` | `algorithm` | 超时几乎必然是算法复杂度不足 |

其余状态（wrong_answer / runtime_error / output_limit_exceeded）**自动留空 `unknown`**——无法可靠判断不伪装判断，由用户在错题详情手动归类（`category_source='manual'`）。

手动可选项全集：`syntax / condition / loop / array_boundary / pointer / input_output / algorithm / off_by_one / memory / other`。

冗余派生：`error_records` 保留全部原始行（含 NULL 分类）；「最近错误分类」查询时按 `problem_id` 取最近一条非 NULL 分类。历史错误不回填（诚实原则），用户可在错题详情补分类。

## 7. 测试要求（验收）

以下场景分数与状态必须可预测（`tests/mastery.test.ts`）：

1. 未做题 → `not_started`，score=0；
2. 首次失败 → `learning`（或满足弱判 → `weak`）；首次 AC 单题 → 状态 < mastered（信心折扣封顶）；
3. 单题刷 100 次 AC → 永远到不了 `mastered`（≤ familiar）；
4. 3 题全 AC + 稳定表现 → score ≥ 80 → `mastered`；
5. 连续失败（5 次中 ≥3 失败）→ `weak`；恢复后回到正常轨道；
6. 复习 again ×2 → 压制 mastered；复习 good → 分数上升；
7. 时间推移 45 天（注入时钟）→ mastered → familiar；
8. 重算幂等：任意操作序列后 `recalc()` 两次结果完全一致；
9. 权重/折扣常数表驱动验证（黑盒公式对拍）。
