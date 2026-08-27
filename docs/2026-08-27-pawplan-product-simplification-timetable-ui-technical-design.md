# PawPlan 产品精简、固定课表与 UI 优化技术方案

- 状态：Charlotte 已确认，已按本方案实现并完成验证
- 日期：2026-08-27（Asia/Shanghai）
- 目标仓库：`/Users/charlotte/daily-progress`
- 产品依据：`progress-and-schedule/plans/PAWPLAN_PRODUCT_UI_REDESIGN_BRIEF.md`

## 1. 目标

本轮把 PawPlan 收敛成三个高频能力：

1. 用上午、下午、晚上三个粗粒度时段管理任务；
2. 用真实时间块显示固定课程、地点和空闲区域；
3. 只有用户主动请求或出现真实固定时间冲突时才进入 Review。

本轮必须完成：

- 删除固定频率每日自动 Review 的运行入口、工具语义、推荐文案和现行操作指南；
- 保留手动或事件触发的 Review，以及 `Review -> Apply -> Readback`；
- 给固定课程约束增加地点，支持单次 recurring occurrence 的地点覆盖；
- 实现桌面周课表和移动单日课表，按真实分钟定位和真实时长计算块高；
- 将固定课程表归入“计划”，移动导航精简为“今天 / 计划 / 收集 / 审核”；
- 删除重复的收集、Fixed、More/Settings 入口；
- Review 数量只反映真实待处理项，零待处理时不显示 badge；
- 统一高频页面的按钮、图标、卡片、状态、焦点和移动点击区。

## 2. 非目标

- 不给任务增加精确起止时间；任务继续只使用 `date + daySegment + estimatedMinutes`。
- 不把上午、下午、晚上推测成精确小时位置。
- 不在课表空白区域自动填任务；空白只表示没有固定时间块。
- 不实现拖选课表空白创建任务。
- 不实现地图依赖、地点导航或视图记忆。
- 不重构整个数据层、MCP、Review 或 Apply 契约。
- 不一次性重写所有历史页面或建立完整 UI 框架。
- 不在前端硬编码 Charlotte 的课表或地点。

## 3. 现状与问题

### 3.1 自动 Review

PawPlan 仓库没有 app-owned cron，但仍存在会恢复每日主动审核的运行时和文档入口：

- `propose_overdue_replan` 会按容量自动挑选新日期和时段；
- MCP daily guidance 鼓励周期性扫描逾期任务；
- Settings 和 README 仍推荐 scheduled automation；
- `docs/automation/pawplan-scheduled-automation.md` 和 daily loop prompts 仍是现行操作指南。

`propose_daily_rebalance` 和 `propose_week_rebalance` 接收明确目标并只创建 Review 草稿，仍属于用户主动调整能力，必须保留。

### 3.2 地点

当前 `courses` 和 `time_blocks` 均无地点字段。地点不能只放在 `courses`，因为同一课程不同上课日可能在不同教室。

### 3.3 课表

当前 Plan 周视图和 Constraints 时间线都是顺序列表，块高与真实时长无关。现有 recurrence 展开、exception 和 Asia/Shanghai 范围读取可以复用。

### 3.4 信息架构与 UI

桌面和移动共用六项英文导航；移动端 Fixed、More 与核心流程竞争空间。全局 Floating Cat、Inbox QuickCapture 和 Today 杂事输入提供重叠能力。CSS 已有颜色和圆角变量，但缺少统一控件高度、字体层级、间距、focus ring 和状态规格。

## 4. 架构设计

### 4.1 模块边界

```text
constraints/time_blocks + exceptions
            |
            v
loadEffectiveTimeBlocks(Asia/Shanghai range)
            |
            v
timetable view model + pure overlap layout
            |
       +----+----+
       |         |
desktop week  mobile day
```

- 数据库负责保存约束和地点；
- `loadEffectiveTimeBlocks` 负责按上海时间展开 recurrence 和 exceptions；
- 新的纯布局模块只接收已经展开的 occurrence，不访问数据库；
- 新的共享课表组件根据 viewport 选择桌面周视图或移动日视图；
- 粗粒度任务不进入课表布局模块。

### 4.2 建议新增模块

- `src/lib/planning/timetable-layout.ts`
  - 上海日期和分钟转换；
  - overlap connected component 分组；
  - lane 分配；
  - top、height、left、width 的纯计算。
- `src/lib/planning/timetable-view-data.ts`
  - 读取指定上海周范围的 effective occurrences；
  - 补充课程颜色、地点和冲突状态；
  - 只返回课表需要的最小字段。
- `src/components/time-block-timetable.tsx`
  - 桌面周视图和移动日视图共享课程块与详情语义。
- `src/components/time-block-detail.tsx`
  - 课程、时间、地点、类型和冲突只读详情。
- `src/lib/planning/review-count.ts`
  - 统计当前 workspace 下 draft agent patches 与未过期 pending operation approvals；
  - App layout 服务端读取一次并传给 AppShell。

不引入 FullCalendar 或新的重量级 UI 依赖。

## 5. 数据模型

### 5.1 DDL

```sql
ALTER TABLE "time_blocks"
  ADD COLUMN "location" varchar(240);

ALTER TABLE "time_block_exceptions"
  ADD COLUMN "override_location" varchar(240),
  ADD COLUMN "override_location_set" boolean NOT NULL DEFAULT false;
```

规则：

- `NULL` 表示未知地点；展示层显示“地点待确认”。
- 空白字符串在服务端归一化为 `NULL`。
- 地点不写入 `courses` 作为唯一来源。
- occurrence 的 `override_location_set=true` 表示显式覆盖；此时 `override_location=NULL` 表示该次显示“地点待确认”。`override_location_set=false` 时继承 `time_blocks.location`。
- 迁移不从历史 `notes` 猜地点，也不写入哨兵字符串。

### 5.2 回滚

- 首选回滚应用代码并保留新增 nullable 列；旧代码会忽略它们。
- 地点已经写入后不得直接 drop columns，否则会丢数据。
- 如必须物理回滚，先导出非空地点，再执行逆向迁移。

## 6. API 与导入契约

完整 HTTP 契约见 `docs/2026-08-27-pawplan-constraints-location.openapi.yaml`。

修改范围：

- `GET /api/constraints` 的 time block 增加 nullable `location`；
- `POST /api/constraints` 的 upsert input 接收 nullable `location`；
- timetable CSV 增加显式 `location` 列；
- MCP timetable row 增加 nullable `location`；
- timetable Review patch 必须保留 location；
- series update changes 增加 nullable `location`，并遵循 occurrence/following/series 现有范围语义；
- 模板导入导出必须保留地点。

现有 `notes` 继续作为备注；不得把所有 notes 自动解释成地点。

## 7. 自动 Review 删除边界

### 删除

- `propose_overdue_replan` 的 MCP 元数据、schema、dispatch 和实现；
- `src/lib/planning/overdue-replan.ts`；
- daily cleanup guidance 中按日期/容量主动挑选移动目标的规则；
- Settings 中“推荐自动化”“无人值守每日审核”等产品文案；
- README 中 daily/weekly scheduled review 推荐；
- `docs/automation/pawplan-scheduled-automation.md` 和 daily loop prompts 作为现行指南的地位。

历史 specs、handoffs 和迁移记录保留，但在索引或文件开头标记 `Superseded`，不得继续链接为操作指南。

### 保留

- `propose_daily_rebalance`、`propose_week_rebalance`；
- `review_only` 权限；
- `agent_patches`、`agent_patch_reviews`、agent run 审计；
- Apply 的事务、stale-state 检查、plan version、change log 和 readback；
- 历史 `agent_run_kind=overdue_replan` enum 值，避免破坏性收缩 PostgreSQL enum；
- 独立的旧自动化运行记录归档。

验收时还要从 Codex automation 状态读回，确认 `pawplan-07-30` 及改名替代项不存在。代码扫描只能证明应用仓库没有调度器，不能证明外部 automation 已删除。

## 8. 课表布局

### 8.1 时间范围

- 默认 06:00-23:00；
- 每小时主刻度，30 分钟弱刻度；
- 课程前后必须保留可识别的空白；
- 所有日期、周界和当前时间统一使用 `Asia/Shanghai`。

### 8.2 定位公式

以 `axisStartMinute = 360` 为例：

```text
topPx    = (startMinute - axisStartMinute) * pxPerMinute
heightPx = (endMinute - startMinute) * pxPerMinute
```

不得吸附到整点或半点。视觉高度保持真实比例；短课程的 44x44 命中区通过外层按钮或透明 hit area 实现，不能用 `min-height` 改变课程块比例。

### 8.3 重叠算法

1. 每日按 `start asc, end asc` 排序；
2. 用扫描线生成 overlap connected components；
3. 每个 component 使用最早可用 lane；
4. `start === previousEnd` 视为相邻，不视为重叠；
5. component 内统一 `laneCount`；
6. `left = lane / laneCount`，`width = 1 / laneCount`，列间保留固定 gutter；
7. 重叠状态同时用图标/文字表示，颜色不是唯一信号。

### 8.4 响应式

- 桌面：周一至周日七列，连续纵向时间轴；
- 移动：单日时间轴，上方一周日期选择条，支持上一天、下一天和“今天”；
- 页面不产生横向滚动；
- iPhone safe area 不遮挡底部导航和课程详情。

## 9. 信息架构

### 9.1 主导航

- 移动端固定四项：`今天 / 计划 / 收集 / 审核`。
- 桌面端使用相同中文术语；设置/导入/管理/退出进入右上角账户菜单。
- `/constraints` 从主导航移除，作为“计划 -> 课表”的兼容路径；不强制重写历史 URL。
- `/more` 保留兼容跳转，但不再是移动主入口。

### 9.2 收集入口

- 保留 `/inbox` 的 QuickCapture，作为唯一主要收集编辑器；
- 删除全局 Floating Cat；
- 删除 Today 的“记个杂事”直建入口；
- 保留 Inbox 中捕获、今日杂事提升、任务/日常转换等不同业务语义。

### 9.3 Review badge

- badge 数量 = draft agent patches + 未过期 pending operation approvals；
- 数量为 0 时不渲染 badge、警告点或焦虑文案；
- expired、approved、rejected、consumed 不计入数量；
- Review 页面仍可显示符合现有规则的近期过期只读记录。

## 10. UI 规格

只建立本轮需要的最小体系：

- token：控件高度、图标槽、字体层级、行高、间距、focus ring、状态对比色；
- 组件：`Button`、`IconButton`、`Card`、`StatusBadge`、`EmptyState`；
- 变体：Primary、Secondary、Ghost、Danger；
- 移动主要命中区至少 44x44px；桌面常规按钮高度 40px；
- focus-visible 必须清晰；
- disabled/loading/error 不能只靠透明度或颜色表达；
- 首轮只替换 AppShell、Plan/课表、Inbox、Review 高频交互，不做全仓机械替换。

## 11. 错误处理

- 数据库不可用：课表显示统一错误状态，不回退到硬编码课表；
- 地点缺失：显示“地点待确认”，不报错、不猜测；
- 地点超长：课程块最多两行并省略，详情显示完整文本；
- invalid location 或 datetime：API 返回 400；
- recurring edit 试图绕过 scope：保持 409，要求 occurrence/following/series Preview；
- timetable conflict：展示冲突双方、时间和地点，不自动修改；
- Review count 查询失败：隐藏 badge，Review 页面本身仍可访问；不得显示虚假数量；
- 外部 automation 无法读回：报告未验证，不宣称已经删除。

## 12. 实现阶段

### 阶段 A：产品行为删除

- 删除 overdue auto-replan 工具与 daily guidance；
- 更新 Settings、README 和现行自动化文档；
- 回归手动 Review 和 Apply/Readback。

### 阶段 B：地点契约

- schema、migration、API、CSV、MCP、Review patch、series exception、template；
- null/long/different-day/occurrence override 测试。

### 阶段 C：课表

- 纯布局算法；
- desktop week / mobile day；
- 详情、当前日、当前时间线、重叠与地点。

### 阶段 D：导航和 UI

- 四项导航、账户菜单、Plan 归并；
- 删除重复捕获入口；
- pending Review badge；
- 高频组件和 token。

### 阶段 E：回归和交付

- 单元、集成、E2E、构建；
- 桌面和 375/390/430px 截图；
- 自动 Review 删除清单和外部状态 readback；
- 独立任务审查精确 diff。

## 13. 测试计划

### 单元测试

- 08:30、11:30、12:45 等非半点定位；
- 45/75/105 分钟高度比例；
- 相邻不冲突、两重/三重/链式重叠 lane；
- recurrence cancel/override 后的位置和地点；
- 同一课程不同 series 不同地点；
- 地点 null、空白归一化、240 字边界和超长拒绝；
- 粗粒度任务不进入课表；
- pending Review count 排除 expired/approved/rejected/consumed；
- MCP catalog 和 guidance 不再出现 overdue/daily automatic review；
- `propose_daily_rebalance` 仍只创建 draft，`review_only` 仍不能 Apply。

### 数据库与集成测试

- 在含现有 time blocks、exceptions、agent runs 的数据库副本上执行 migration；
- CSV/MCP/Review Apply/Template 全链路地点不丢失；
- Apply stale-state、audit 和 readback 回归。

### E2E

- desktop 1440px 周课表；
- mobile 375/390/430px 单日课表；
- 日期切换、今天返回、课程详情；
- 长地点、地点缺失、相邻和重叠课程；
- 页面 `scrollWidth <= clientWidth`；
- 底栏恰好四项且主要交互至少 44x44；
- pending Review 有数量，零 Review 无 badge；
- 键盘 focus 可见；
- safe area 不遮挡底栏和详情。

基线已知：当前单元测试和 build 通过；现有 constraints E2E 错误地期待 recurring constraint 直接编辑，与产品的 Preview/Review 安全语义冲突。实现时应更新测试，不得放宽 recurring 安全边界。

## 14. 风险与缓解

- **旧 timetable Review 不含显式地点：** 不从 notes 猜；批准前重建显式 location Review。
- **误删手动 Review：** 工具目录测试明确保留 daily/weekly rebalance，只删除 overdue auto-selection。
- **课表先画 UI 后丢数据：** 必须先完成地点契约和迁移，再接课表。
- **粗粒度任务被伪定位：** 课表 view model 类型不接受 task rows。
- **CSS 改动扩大：** 只替换高频组件，禁止全仓格式化和无关样式重写。
- **Review badge 计数漂移：** 使用服务端共享查询，不在不同页面分别计算。
- **外部 automation 被改名恢复：** 验收必须读取实际 automation 状态，不能只扫描仓库。

## 15. 完成标准

只有同时满足以下条件才算完成：

- 每日自动 Review 无调度、无运行入口、无现行恢复指南；
- 手动 Review、Apply、readback 仍通过；
- 地点从输入到数据库、Review、readback 和 UI 不丢失；
- 课表使用真实分钟、真实时长、真实上海日期和 occurrence 地点；
- 粗粒度任务仍然只是上午、下午、晚上；
- 移动底栏四项、无重复主要收集入口、零 Review 无 badge；
- 单元、数据库集成、关键 E2E 和生产 build 通过；
- 提供桌面和三个移动宽度截图；
- 如部署，完成生产 smoke 和真实数据 readback；
- 独立审查任务确认精确 diff、功能删除和 Review 安全边界。
