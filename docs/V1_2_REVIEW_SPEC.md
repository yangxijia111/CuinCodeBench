# V1_2_REVIEW_SPEC.md — 间隔复习规范（确定性阶梯算法）

## 1. 目标

适合编程学习的**轻量**间隔复习：不复制 Anki 的卡片模型，以「知识点」和「错题」为复习对象，
以「重做题目」为复习动作，算法简单、确定、可测试。不使用任何 AI。

## 2. 复习对象（review_items）

| target_type | 建项时机 | 初始 next_review_at |
|---|---|---|
| `problem` | 题目进入错题本（失败 ≥ 2 次，未掌握）——错题复练观察态的载体 | 建项即到期（`now`） |
| `knowledge_point` | 知识点下首次产生提交（开始学习） | `now + 1 天`（次日进入复习循环） |

- UNIQUE(target_type, target_id)，重复触发不重复建项。
- 题目被移出错题本（用户标记掌握）→ 该 `problem` 项删除；题目重新失败 → 重建（重置调度）。
- 题目删除 → 级联清理（见 LEARNING_MODEL §2.4）。

## 3. 评分等级

| 级别 | 中文 | 含义 |
|---|---|---|
| `again` | 重学 | 完全没印象/做错 |
| `hard` | 困难 | 勉强做对/想不起来 |
| `good` | 掌握 | 正常回忆起来 |
| `easy` | 简单 | 秒杀 |

**做题自动映射（默认预选，用户可改）**：本次复习做题失败 → `again`；AC → `good`。
Review Session 结果页展示每项的推荐等级，用户可一键确认或逐项改为 again/hard/good/easy。

## 4. 调度算法（阶梯表，无浮点、无衰减参数）

状态字段：`interval_days`（当前间隔，0 表示日内）、`success_streak`（连续成功次数，封顶 5）、
`failure_count`、`review_count`、`last_reviewed_at`、`next_review_at`。

评分后更新规则（`now` 为注入时钟，天数间隔按 `86400000ms` 换算）：

| 评分 | interval_days | success_streak | next_review_at |
|---|---|---|---|
| `again` | `0` | `0` | `now + 10 分钟`（当日重现） |
| `hard` | `max(1, round(interval_days × 1.2))` | 不变 | `now + interval_days × 1 天` |
| `good` | `GOOD_LADDER[min(streak+1, 5)]` | `+1`（封顶 5） | 同上 |
| `easy` | `EASY_LADDER[min(streak+1, 5)]` | `+1`（封顶 5） | 同上 |

```ts
const GOOD_LADDER = [1, 3, 7, 14, 30, 60] as const   // 索引 = min(streak_after,5)
const EASY_LADDER = [2, 5, 10, 21, 45, 60] as const
```

- 间隔上限 60 天；`hard` 在 `interval_days=0`（刚失败过）时落到 1 天。
- `review_count` 每次评分 +1；`again` 时 `failure_count` +1。
- **纯函数**：`nextSchedule(item, grade, now) → {intervalDays, successStreak, nextReviewAt, ...}`，单测直接对拍阶梯表。

**设计取舍**：放弃 SM-2 的 ease 因子与浮点乘法——阶梯表行为可枚举、可解释、跨平台零精度差异；
hard 的 ×1.2 保留「比 good 短、比 again 长」的语义且仍是整数运算。

## 5. 到期与今日复习

- 到期定义：`next_review_at <= now`。
- Dashboard「今日复习」：到期项计数，按知识点聚合展示（`指针 ×2 · 数组 ×3`）。
- 复习完成即把 `next_review_at` 推到未来，当日不再重复出现（`again` 项 10 分钟后可重现，供当日巩固）。

## 6. Review Session（复习会话）

### 6.1 选題（确定性优先级 + 会话内去重）

1. 收集到期项，排序键：`target_type`（problem 优先，错题最优先）→ `failure_count` desc → 关联知识点 mastery score asc → `next_review_at` asc；
2. 逐项展开为题目：
   - `problem` 项 → 该题本身；
   - `knowledge_point` 项 → 从该知识点题目中选 1~2 题，优先级：**最近失败且未重做成功** > 错题本内题目 > 已做但低 AC 率 > 任意已做题 > 未做题；
3. 会话内去重（同一题不重复出现，满足"避免连续给完全相同的题"）；
4. 截断至会话上限（默认 10 题，可选 5 / 10 / 20）。

### 6.2 流程

`开始今日复习 → 逐题（题目描述 → 编码 → Run/Submit）→ 每题即时反馈 → 完成页`

### 6.3 完成页统计

本次复习题数、正确率、掌握度变化（before → after，逐知识点）、各知识点下次复习日期、推荐等级确认（§3）。

### 6.4 落库

- 每题结果 → `practice_session(kind='review')` 的 items（复用练习队列表）；
- 等级确认 → 对应 `review_items` 调度更新 + `review_history` 追加；
- 受影响知识点 `mastery` 重算。

## 7. 时区与测试

- 调度只依赖 `now` 参数（UTC ms）；「天」只出现在间隔换算（86400000ms），**不做本地日历日运算** → 无时区歧义。
- 测试一律注入固定 `now`（如 `2026-09-22T00:00:00Z`），断言精确时间戳；禁止依赖 `Date.now()` 的用例进入 CI。

## 8. 测试要求（验收，`tests/review-scheduler.test.ts`）

1. 四级评分的完整阶梯表对拍（streak 0→5 全序列，含封顶）；
2. `again` 重置：interval=0、10 分钟后到期、streak 清零、failure_count+1；
3. `hard`：0→1 天；10 天 → 12 天（round(10×1.2)）；
4. 60 天上限不可突破；
5. 到期查询边界：`next_review_at == now` 即到期；
6. 错题入选即到期；标记掌握后 review_item 删除；再次失败重建；
7. 组题：错题优先、低掌握优先、会话去重、数量截断；
8. 注入时钟下的完整 session 流（做题 → 自动映射 → 确认 → 调度推进 → 当日不再出现）。
