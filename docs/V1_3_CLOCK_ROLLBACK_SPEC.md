# 时钟回拨语义规格（v1.3 / P10）

解决 v1.2.1 Deferred：系统时间被向后修改（回拨 1 小时 / 1 天 / 30 天）时，
复习调度、掌握度、streak/日历的行为必须**明确、单调、无负间隔、无数据破坏**。

## 1. 原则：两种时间语义分离

| 语义 | 域 | 规则 |
|---|---|---|
| **monotonic learning chronology**（学习时间线单调性） | 复习调度（nextReviewAt / interval / streak / reviewCount）、掌握度衰减判定 | 不允许回拨制造负 interval、不允许倒退已推进的调度、不允许重置计数 |
| **wall-clock display**（墙钟展示） | Dashboard 今日统计、streak 日历、趋势图、「今天」的到期判定 | 按系统当前日期如实展示；回拨后「今天」就是日历上的今天 |

**不用一条规则硬套全部时间语义**：调度看「学习时间线」，展示看「日历」。

## 2. 复习调度：effectiveNow

### 2.1 规则

```
effectiveNow(item, now) = max(now, item.lastReviewedAt ?? item.createdAt ?? 0)
```

`ReviewService.finishSession` 推进调度时（题目项与知识点项两处），
`nextSchedule(item, grade, now)` 的 `now` 一律替换为 `effectiveNow`。

### 2.2 效果（不变量）

- **I1 nextReviewAt ≥ effectiveNow + 最小步长**：`again`=+10min，`hard`=+1 天，
  good/easy=阶梯值 → nextReviewAt 永不早于 lastReviewedAt；
- **I2 interval 永不为负**：nextSchedule 是阶梯/乘法纯函数，输入无减法 → 天然成立，
  effectiveNow 进一步保证「回拨时算出的 nextReviewAt 不早于上次真实学习时间」；
- **I3 计数不回退**：reviewCount / successStreak / failureCount 是计数器，与时间无关，
  回拨不重置（本规则显式声明，防未来实现误用时间推导计数）；
- **I4 回拨不制造额外到期**：`listDue(now)` 以墙钟 now 过滤，回拨只会让到期项
  **变少**（未来的 nextReviewAt 仍然在未来），绝不出现「回拨一天 → 全部逾期」雪崩。

### 2.3 场景表

| 场景（lastReviewedAt=10/10） | 行为 |
|---|---|
| 回拨到 10/01 后评分 good（阶梯 1 天） | effectiveNow=10/10 → nextReviewAt=10/11（≥lastReviewedAt ✓） |
| 回拨后评分 again | nextReviewAt = 10/10+10min（10/10 当天稍后到期） |
| 时钟正常（now > lastReviewedAt） | effectiveNow=now，行为与 v1.2.1 完全一致（无回归） |
| 回拨后不评分只浏览 | due 判定按墙钟：原本 10/12 到期的项在 10/01 未到期（变少，不雪崩） |

## 3. 掌握度（mastery）

`effectiveMasteryStatus(status, lastActivityAt, now)`：stale 判定改为

```
elapsedDays = max(0, now - lastActivityAt)   ← 回拨时 elapsed<0 视为 0（不衰减）
stale = elapsedDays ≥ MASTERY_STALE_DAYS
```

- 回拨 30 天（< 45）：mastered 保持 mastered（本就未达阈值）；
- 回拨 60 天：elapsed 负/零 → **不衰减**（学习时间线上活动仍「新鲜」），
  符合 I2 单调原则——回拨不能凭空制造衰减；
- 写路径 `computeMastery` 与读路径共用该函数（v1.2.1 单源设计），一处修改两端生效；
- score 永不因回拨变化。

## 4. streak / 日历 / 趋势（wall-clock display）

- **不修改** LocalCalendarDay 语义：「今天」= 系统当前本地日期；
- 回拨 1 天：todaySubmissions/todayReviews 如实变少（那一天的提交属于「明天」的数据，
  展示为 0 是正确的墙钟行为）；streak 按日历日序号差计算，回拨不会崩溃，
  只会如实显示「今天没学」；
- **禁止**为 streak 引入 effectiveNow 类修正——日历展示必须与系统日期一致
  （用户对比手机日历可验证）；回拨造成的 streak 视觉损失是墙钟语义的自然结果；
- 回拨恢复后： streak / 今日统计自动恢复正确（数据未动，只有展示窗口移动）。

## 5. 其它时间消费点清单（审计结论）

| 消费点 | 语义 | 回拨影响 | 处理 |
|---|---|---|---|
| review.todayOverview | 墙钟（due） | 到期变少 | 可接受（§2.3） |
| lastFinishedSession(now-10min) | 墙钟窗口 | 完成页短暂不可见 | 可接受（展示） |
| 错题 firstFailedAt/lastFailedAt | 记录墙钟 | 时间戳乱序 | 接受：记录事件真实发生时刻，不参与区间运算 |
| 提交 createdAt / 趋势 | 记录墙钟 | 趋势图出现「未来日」点 | 接受（展示层如实呈现；日序号函数对乱序安全） |
| review_session_results.gradedAt | 记录墙钟 | 乱序 | 接受（exactly-once 主键与时间无关） |
| 备份 createdAt | 记录墙钟 | 无 | — |
| mastery 衰减 | 学习时间线 | 见 §3 | effectiveMasteryStatus 钳制 |
| 复习调度 | 学习时间线 | 见 §2 | effectiveNow |

## 6. DST / 时区

- 调度全部基于 UTC ms（无跨 DST 算术），回拨 + DST 组合不引入新分支；
- streak/trend 已由 v1.2.1 LocalCalendarDay 日历算术保证（DST 矩阵测试已有）；
- 本 spec 不新增 DST 规则；回拨测试用注入时钟在固定时区执行，另加一条
  TZ=America/New_York 下回拨跨 DST 边界的用例（CI ubuntu 生效）。

## 7. 实现落点

1. `review-scheduler.ts`：新增纯函数 `effectiveNowForScheduling(now, lastActivityAt, createdAt?)`
   （单源、可独立测试）；`ReviewService.finishSession` 两处调用替换；
2. `mastery-status.ts`：`effectiveMasteryStatus` 钳制 elapsed ≥ 0（单源）；
3. 其余消费点不改（§5 审计结论）；
4. 测试（tests/clock-rollback.test.ts，注入时钟）：
   - 回拨 1h / 1d / 30d / 60d 后 finishSession → nextReviewAt 不早于 lastReviewedAt；
   - 回拨 → 评分 → 恢复正常时钟 → 不双计、调度连续；
   - mastery 45 天边界 × 回拨组合（elapsed 负值钳制）；
   - again 10 分钟重现与回拨组合；
   - streak/趋势在回拨日的墙钟行为（纯函数级）；
   - DST 时区边界用例（CI 生效）。
