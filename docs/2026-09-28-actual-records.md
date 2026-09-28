# 实际记录：Today 与 MCP

用户已确认：PawPlan 保留任务看板定位，Codex/Claude 通过 MCP 分析和调整。Today 的收工反馈入口替换为实际记录，不新增 AI 调整页。历史 checkins 和接口继续保留。

## 操作与数据语义

- Today 左下角「记一段」或任务展开后的「记录用时」：填写发生过的起止时间、内容、可选关联任务和“大致估计”。允许补记、跨午夜、多段记录和无任务活动。
- 保存不会改变任务状态、排期或估时；完成任务也不会自动生成实际记录。空白表示未知。
- 关联任务使用可搜索面板，仅列出 Today 今日任务列表中的任务（含今天已完成的任务），搜索也限定在这份列表内；不展示其他日期或旧计划任务。输入内容在进入/返回选择器时保留。历史记录已有的关联保持原样。
- 支持查看过去日期、更正及软移除。每次编辑保留审计；软移除不删除任务。
- 右侧桌面时间轴、手机下方时间轴都显示实际记录。与实际重叠的旧任务计划隐藏到记录详情，明确的后续时段仍保留。只到达计划时刻时标记“当前计划”，不推断用户正在做。
- 计划快照是首次记录/重新关联该任务时读到的计划；之后改时间不覆盖快照。不能声称它恢复了功能上线前任务最早的计划。MCP 同时返回快照和当前关联任务，支持诚实比较。
- 所有用户输入按 Asia/Shanghai 展示；存储 UTC。结束不得在未来，单段正时长且不超过 48 小时。重叠实际记录允许保留，分析时不能直接把重叠时长累加成独占用时。

## 写入与读回

新增 `actual_records` 与不可变回执 `actual_record_writes`；不依赖活跃计划。当前空间内精确 ID 校验；编辑和移除须带 `expected_revision`。

所有写入需稳定 `idempotency_key`。同键同内容重试返回 duplicate，同键不同内容拒绝。事务原子保存记录及前后审计回执。提交后独立按 ID 读回；读回失败返回 `applied_with_readback_error`、`mutationApplied:true`，不能当作未写入重新创建。浏览器在不确定时锁定输入，用原键重试，或关闭后重新读取。重试返回的最新版本若已超过原操作版本，`matchesMutation:false`，需重新读取，不能覆盖他人的改动。

MCP 工具：

- `get_actual_records`：read 权限；日期范围 1–31 天（含端点），可按 task_id 筛选，读取与该范围重叠的实际记录。最多 1000 条并显式返回 truncated；超出应缩短查询范围。
- `save_actual_record`：read_write；record 包含 title、starts_at、ends_at、task_id（可空）、approximate；更新额外带 id 和 expected_revision。只录入用户明确报告的事实，不从日程/任务完成推断实际活动。
- `delete_actual_record`：read_write；id、expected_revision、idempotency_key。用户明确要求时软移除。

Web 契约见同名 OpenAPI；MCP 共享 `src/lib/actual-records/schema.ts` 的 Zod 字段与服务验证。

## 发布与回滚

先应用增量迁移 `0023_strong_jamie_braddock.sql`，再发布应用。2026-09-28 用户明确授权部署后，已在生产应用迁移并独立读回两张表；Vercel 发布 `dpl_BDb6LhitmnPKNgokNfMKvZaVBKnP` 为 READY，正式域名 `https://pawplan.charlottezmm.info` 已切换。登录会话中的 Today 记录读取与弹窗正常，桌面及 390px / 320px 手机布局通过，控制台无错误。线上验收未新增真实记录或改动用户任务；写入和读回失败路径已在隔离数据库验证。

回滚到旧应用即可恢复旧页面；新表保留，避免丢失用户记录，不使用 DROP 回滚。固定日程直改功能开关与本功能独立。

验收覆盖：真实持久化、任务不变、版本冲突、空间隔离、MCP 权限、并发重试、跨夜、软移除、读回失败恢复，以及桌面 Chromium / iPhone WebKit 的新建、编辑、刷新、完成、移除和窄屏布局。

## 关联任务选择器修正

用户澄清后：保留搜索面板和长标题换行，候选范围严格使用 Today 的今日任务列表。已移除跨日期搜索接口；补记历史记录也不会扩大候选范围，原有历史关联不会被自动清除。
