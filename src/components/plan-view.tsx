"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CatIcon } from "./cat-icon";
import { PlanSectionNav } from "./plan-section-nav";
import { RescheduleList } from "./reschedule-list";
import type { MonthDayView, MonthViewData, PlanTaskView, TimelineItemView, TodayViewData, WeekDayView, WeekViewData } from "@/lib/planning/view-data";
import { redactPrivateTitle } from "@/lib/display/privacy";

export type PlanTab = "day" | "week" | "month" | "reschedule";

const weekdayChars = "日一二三四五六";

function minutesLabel(minutes: number) {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function loadColor(state: string) {
  if (state === "over") return "overloaded";
  return "";
}

function clock(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function shanghaiDateKey(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function todayKey() {
  return shanghaiDateKey(new Date().toISOString());
}

function addDaysKey(key: string, delta: number) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function dateLabelFromKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${m}/${d} 周${weekdayChars[dt.getUTCDay()]}`;
}

function heroDateFromKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { date: `${m} 月 ${d} 日`, weekday: `星期${weekdayChars[dt.getUTCDay()]}` };
}

const timelineKindClass: Record<TimelineItemView["kind"], string> = {
  task: "task",
  course: "routine",
  meeting: "routine",
  unavailable: "routine",
  routine: "routine",
  recovery: "recovery",
};

const timelineKindLabel: Record<TimelineItemView["kind"], string> = {
  task: "任务",
  course: "课程",
  meeting: "日程",
  unavailable: "不可用",
  routine: "固定",
  recovery: "恢复",
};

function sortByStart(items: TimelineItemView[]) {
  return [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const segmentLabel: Record<PlanTaskView["segment"], string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};

const priorityLabel: Record<PlanTaskView["priority"], string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};

const taskStatusLabel: Record<PlanTaskView["status"], string> = {
  todo: "待办",
  done: "已完成",
  backlog: "稍后处理",
  skipped: "旧任务",
};

function TaskCard({
  task,
  onOpen,
  compact = false,
  variant,
  active = false,
}: {
  task: PlanTaskView;
  onOpen: (task: PlanTaskView) => void;
  compact?: boolean;
  variant?: "overdue";
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`paw-plan-task-card status-${task.status} ${compact ? "compact" : ""} ${variant === "overdue" ? "overdue" : ""} ${task.done ? "done" : ""} ${active ? "active" : ""}`}
      aria-pressed={active}
      onClick={() => onOpen(task)}
    >
      <span className="paw-plan-task-title">{redactPrivateTitle(task.title)}</span>
      <span className="paw-plan-task-meta">
        {taskStatusLabel[task.status]} · {segmentLabel[task.segment]} · {minutesLabel(task.minutes)} · {task.context} · {task.track}
      </span>
    </button>
  );
}

function FixedItems({ items }: { items: TimelineItemView[] }) {
  if (items.length === 0) return null;
  return (
    <details className="paw-plan-fixed">
      <summary>固定占用 · {items.length} 项</summary>
      <div className="paw-timeline compact">
        {sortByStart(items).map((item) => (
          <div key={item.id} className="paw-time-block">
            <span className="paw-time-label">
              {clock(item.startsAt)}–{clock(item.endsAt)}
            </span>
            <div className={`paw-time-bar ${timelineKindClass[item.kind]}`}>
              <span>{redactPrivateTitle(item.title)}</span>
              <span className="ml-2 text-xs opacity-70">
                {timelineKindLabel[item.kind]} · {minutesLabel(item.minutes)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function TaskList({
  label,
  tasks,
  empty,
  onOpen,
  tone,
  variant,
  selectedId,
}: {
  label: string;
  tasks: PlanTaskView[];
  empty: string;
  onOpen: (task: PlanTaskView) => void;
  tone?: "warn";
  variant?: "overdue";
  selectedId?: string | null;
}) {
  return (
    <section className={`paw-plan-task-section ${tone === "warn" ? "warn" : ""}`}>
      <div className={`paw-section-label ${tone === "warn" ? "warn" : ""}`}>{label}</div>
      {tasks.length === 0 ? <div className="paw-empty"><p>{empty}</p></div> : null}
      <div className="paw-plan-task-list">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onOpen={onOpen}
            variant={variant}
            active={selectedId === task.id}
          />
        ))}
      </div>
    </section>
  );
}

function TaskDetail({
  task,
  actions,
  savingId,
  message,
  sheetOpen = false,
  onClose,
}: {
  task: PlanTaskView | null;
  actions?: {
    moveToday: (task: PlanTaskView) => void;
    moveTomorrow: (task: PlanTaskView) => void;
    complete: (task: PlanTaskView) => void;
    backlog: (task: PlanTaskView) => void;
  };
  savingId?: string | null;
  message?: string | null;
  sheetOpen?: boolean;
  onClose?: () => void;
}) {
  if (!task) {
    return (
      <aside className="paw-plan-detail">
        <p className="paw-section-label">任务详情</p>
        <p className="paw-goal-meta">点击日、周或月里的任务查看说明、完成标准和资源。</p>
      </aside>
    );
  }

  const taskActions = actions;
  const canAct = taskActions && (task.status === "todo" || task.status === "backlog");
  const isSaving = savingId === task.id;

  return (
    <>
    <div className={`paw-plan-sheet-backdrop ${sheetOpen ? "open" : ""}`} onClick={onClose} aria-hidden="true" />
    <aside id="paw-plan-detail" className={`paw-plan-detail ${sheetOpen ? "open" : ""}`}>
      <button type="button" className="paw-plan-sheet-close" onClick={onClose} aria-label="关闭详情">
        <X size={18} />
      </button>
      <p className="paw-section-label">任务详情</p>
      <h2 className="paw-goal-title">{redactPrivateTitle(task.title)}</h2>
      <div className="paw-plan-detail-meta">
        <span>{task.dateLabel}</span>
        <span>{segmentLabel[task.segment]}</span>
        <span>{minutesLabel(task.minutes)}</span>
        <span>优先级 {priorityLabel[task.priority]}</span>
        <span>能量 {task.energy}</span>
      </div>
      <p className="paw-goal-meta">{task.context} · {task.track}</p>
      {task.detail.sections.length === 0 ? (
        task.notes
          ? <p className="paw-plan-detail-notes">{task.notes}</p>
          : <p className="paw-plan-detail-notes muted">这条任务还没有详细描述。</p>
      ) : null}
      {canAct ? (
        <div className="paw-plan-detail-actions" aria-label="任务操作">
          <button type="button" className="paw-act-btn" disabled={isSaving} onClick={() => taskActions!.moveToday(task)}>
            挪到今天
          </button>
          <button type="button" className="paw-act-btn" disabled={isSaving} onClick={() => taskActions!.moveTomorrow(task)}>
            明天
          </button>
          <button type="button" className="paw-act-btn done" disabled={isSaving} onClick={() => taskActions!.complete(task)}>
            完成
          </button>
          <button type="button" className="paw-act-btn defer" disabled={isSaving} onClick={() => taskActions!.backlog(task)}>
            移到稍后处理
          </button>
        </div>
      ) : null}
      {message ? <p className="paw-toast" role="status">{message}</p> : null}
      {task.detail.sections.length > 0 ? (
        <div className="paw-plan-detail-sections">
          {task.detail.sections.map((section) => (
            <section key={section.label}>
              <h3>{section.label}</h3>
              {section.lines.length === 0 ? null : (
                <ul>
                  {section.lines.map((line, index) => (
                    <li key={`${section.label}-${index}`}><DetailLine line={line} /></li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : null}
    </aside>
    </>
  );
}

function DetailLine({ line }: { line: string }) {
  const parts = line.split(/(https?:\/\/[^\s；;，]+)/g);

  return parts.map((part, index) => {
    if (!part.startsWith("http://") && !part.startsWith("https://")) return part;
    let label = "打开链接";
    try {
      label = new URL(part).hostname.replace(/^www\./, "");
    } catch {
      // Keep a readable fallback if old task data contains a malformed URL.
    }
    return (
      <a key={`${part}-${index}`} className="paw-plan-resource-link" href={part} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  });
}

function WeekDayCard({ day, onOpenTask }: { day: WeekDayView; onOpenTask: (task: PlanTaskView) => void }) {
  return (
    <details
      className={`paw-week-day ${day.state === "today" ? "today" : ""}`}
      open={day.state === "today" || day.taskCount > 0 || day.fixedItems.length > 0}
    >
      <summary className="paw-week-day-summary">
        <span className="paw-week-day-id">
          {day.state === "today" ? <span className="paw-week-today-tag">今天</span> : null}
          <span className={`paw-week-day-name ${day.state === "today" ? "today" : ""}`}>周{day.day}</span>
          <span className="paw-week-day-date">{day.date}</span>
        </span>
        <span className="paw-week-day-right">
          <span className={day.state === "over" ? "paw-overload-badge" : "paw-status-pill"}>
            {day.doneCount}/{day.taskCount} · {day.totalMinutes}
          </span>
          <span className="paw-week-chevron" aria-hidden="true" />
        </span>
      </summary>
      <div className="paw-capacity-bar">
        <div className={`paw-capacity-fill ${loadColor(day.state)}`} style={{ width: `${Math.min(day.load, 100)}%` }} />
      </div>
      <div className="paw-plan-task-list compact paw-week-tasklist">
        {day.tasks.length === 0 ? <p className="paw-week-empty">这一天还没有任务</p> : null}
        {day.tasks.map((task) => (
          <TaskCard key={task.id} task={task} onOpen={onOpenTask} compact />
        ))}
      </div>
      <FixedItems items={day.fixedItems} />
    </details>
  );
}

function MonthDayCell({
  day,
  selected,
  onSelect,
}: {
  day: MonthDayView;
  selected: boolean;
  onSelect: (day: MonthDayView) => void;
}) {
  return (
    <button
      type="button"
      className={`paw-month-day ${day.inMonth ? "" : "outside"} ${day.state === "today" ? "today" : ""} ${selected ? "selected" : ""}`}
      onClick={() => onSelect(day)}
    >
      <span className="paw-month-day-number">{day.dayOfMonth}</span>
      {day.taskCount > 0 ? (
        <span className="paw-month-day-count">
          {day.doneCount}/{day.taskCount} · {day.totalMinutes}
        </span>
      ) : null}
      <span className="paw-month-day-dots" aria-hidden="true">
        {day.tasks.slice(0, 4).map((task) => (
          <span key={task.id} className={`paw-month-dot status-${task.status}`} />
        ))}
      </span>
    </button>
  );
}

export function PlanView({ today, week, month, initialTab = "day" }: { today: TodayViewData; week: WeekViewData; month: MonthViewData; initialTab?: PlanTab }) {
  const [tab, setTab] = useState<PlanTab>(initialTab);
  const [overdueTasks, setOverdueTasks] = useState<PlanTaskView[]>(today.overdueTasks);
  const [todayTasks, setTodayTasks] = useState<PlanTaskView[]>(today.todayTasks);
  const [selectedTask, setSelectedTask] = useState<PlanTaskView | null>(null);
  const [selectedMonthDay, setSelectedMonthDay] = useState<MonthDayView | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 手机端把详情做成底部 sheet：点任务才打开，避免加载时自动弹出
  const [detailOpen, setDetailOpen] = useState(false);
  const openTask = (task: PlanTaskView) => {
    setSelectedTask(task);
    setDetailOpen(true);
  };
  const closeDetail = () => setDetailOpen(false);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setSelectedMonthDay(null);
    setSelectedTask(null);
    setDetailOpen(false);
  }, [month.monthKey]);

  // 手机上详情就地展开在列表下方，自动滚动过去，省得手动找
  useEffect(() => {
    if (!detailOpen || !selectedTask) return;
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 760px)").matches) return;
    requestAnimationFrame(() => {
      document.getElementById("paw-plan-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [detailOpen, selectedTask]);
  const currentDateKey = todayKey();

  function nextSelectedTask(taskId: string, nextOverdue: PlanTaskView[], nextToday: PlanTaskView[]) {
    if (selectedTask?.id !== taskId) return;
    setSelectedTask(nextOverdue[0] ?? nextToday[0] ?? null);
  }

  async function patchTask(task: PlanTaskView, body: { date?: string; status?: PlanTaskView["status"] }, successMessage: string) {
    setSavingId(task.id);
    setMessage(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, ...body }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "更新失败");
      }
      setMessage(successMessage);
      window.setTimeout(() => setMessage(null), 1800);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "更新失败");
      throw err;
    } finally {
      setSavingId(null);
    }
  }

  async function moveTaskToDate(task: PlanTaskView, dateKey: string, successMessage: string) {
    const previousOverdue = overdueTasks;
    const previousToday = todayTasks;
    const updatedTask: PlanTaskView = {
      ...task,
      dateKey,
      dateLabel: dateLabelFromKey(dateKey),
      status: "todo",
      done: false,
    };
    const nextOverdue = overdueTasks.filter((item) => item.id !== task.id);
    const nextToday = todayTasks.filter((item) => item.id !== task.id);
    setOverdueTasks(nextOverdue);
    if (dateKey === currentDateKey) {
      const nextTodayWithTask = [...nextToday, updatedTask];
      setTodayTasks(nextTodayWithTask);
      setSelectedTask(updatedTask);
    } else {
      setTodayTasks(nextToday);
      nextSelectedTask(task.id, nextOverdue, nextToday);
    }

    try {
      await patchTask(task, { date: dateKey, status: "todo" }, successMessage);
    } catch {
      setOverdueTasks(previousOverdue);
      setTodayTasks(previousToday);
      setSelectedTask(task);
    }
  }

  async function setTaskStatus(task: PlanTaskView, status: "done" | "backlog", successMessage: string) {
    const previousOverdue = overdueTasks;
    const previousToday = todayTasks;
    const nextOverdue = overdueTasks.filter((item) => item.id !== task.id);
    const nextToday = todayTasks.filter((item) => item.id !== task.id);
    setOverdueTasks(nextOverdue);
    setTodayTasks(nextToday);
    nextSelectedTask(task.id, nextOverdue, nextToday);

    try {
      await patchTask(task, { status }, successMessage);
    } catch {
      setOverdueTasks(previousOverdue);
      setTodayTasks(previousToday);
      setSelectedTask(task);
    }
  }

  const taskActions = {
    moveToday: (task: PlanTaskView) => void moveTaskToDate(task, currentDateKey, "已挪到今天"),
    moveTomorrow: (task: PlanTaskView) => void moveTaskToDate(task, addDaysKey(currentDateKey, 1), "已挪到明天"),
    complete: (task: PlanTaskView) => void setTaskStatus(task, "done", "已标记完成"),
    backlog: (task: PlanTaskView) => void setTaskStatus(task, "backlog", "已移到稍后处理"),
  };

  return (
    <div className="paw-page">
      <PlanSectionNav />
      <section className="paw-page-header">
        <h1 className="paw-page-date">计划</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">日、周、月都以任务为主。固定占用只做参考；想改任务日期，去「改期」自己调；Agent 的建议在 Review 里确认。</p>
        </div>
        <nav className="paw-sub-tabs" aria-label="日程视图">
          {([
            ["day", "日", "/plan?view=day"],
            ["week", "周", "/plan?view=week"],
            ["month", "月", `/plan?view=month&month=${month.monthKey}`],
            ["reschedule", "改期", "/plan?view=reschedule"],
          ] as const).map(([value, label, href]) => (
            <Link
              key={value}
              href={href}
              onClick={() => {
                setTab(value);
                setDetailOpen(false);
              }}
              className={`paw-sub-tab ${tab === value ? "active" : ""}`}
              aria-current={tab === value ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
      </section>

      {today.dataUnavailable || week.dataUnavailable || month.dataUnavailable ? (
        <section className="paw-status-pill warn" role="status">
          当前没有 DATABASE_URL，Plan 会显示为空态；配置数据库后会读取真实计划。
        </section>
      ) : null}

      {tab === "day" ? (
        <section className="paw-plan-view paw-plan-split">
          <div className="paw-plan-main">
            <header className="paw-plan-hero">
              <span className="paw-plan-hero-kicker">{heroDateFromKey(currentDateKey).weekday}</span>
              <h2 className="paw-plan-hero-date">{heroDateFromKey(currentDateKey).date}</h2>
              <p className="paw-plan-hero-sub">
                今日任务 {todayTasks.filter((task) => task.done).length}/{todayTasks.length}
                {overdueTasks.length > 0 ? ` · ${overdueTasks.length} 件遗留待清` : " · 没有遗留"}
              </p>
            </header>
            {overdueTasks.length > 0 ? (
              <TaskList
                label={`未完成遗留 · ${overdueTasks.length}`}
                tasks={overdueTasks}
                empty="今天以前没有遗留待办。"
                onOpen={openTask}
                tone="warn"
                variant="overdue"
                selectedId={selectedTask?.id ?? null}
              />
            ) : null}
            <TaskList
              label={`今日任务 · ${todayTasks.filter((task) => task.done).length}/${todayTasks.length}`}
              tasks={todayTasks}
              empty="今天还没有安排任务。"
              onOpen={openTask}
              selectedId={selectedTask?.id ?? null}
            />
            <FixedItems items={today.fixedItems} />
          </div>
          <TaskDetail task={selectedTask} actions={taskActions} savingId={savingId} message={message} sheetOpen={detailOpen} onClose={closeDetail} />
        </section>
      ) : null}

      {tab === "week" ? (
        <section className="paw-plan-view paw-plan-split">
          <div className="paw-plan-main">
          <div className="paw-week-grid">
            {week.days.map((day) => (
              <WeekDayCard key={day.date} day={day} onOpenTask={openTask} />
            ))}
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_0.8fr]">
            <div className="paw-goal-card">
              <h2 className="paw-goal-title">战线占比</h2>
              <div className="mt-4 grid gap-3">
                {week.tracks.length === 0 ? <p className="paw-goal-meta">本周还没有可统计的任务。</p> : null}
                {week.tracks.map((track) => (
                  <div key={track.name} className="grid grid-cols-[72px_1fr_56px] items-center gap-3 text-sm">
                    <span className="font-semibold text-[var(--app-ink)]">{track.name}</span>
                    <div className="paw-goal-progress">
                      <div className="paw-goal-progress-fill" style={{ width: `${track.share}%` }} />
                    </div>
                    <span className="text-right text-xs font-semibold text-[var(--app-ink-soft)]">{track.hours}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="paw-goal-card bg-[var(--app-positive-soft)]">
              <h2 className="paw-goal-title">Recovery</h2>
              <p className="mt-3 text-3xl font-bold text-[var(--app-ink)]">{week.recovery.scheduledHours}</p>
              <p className="paw-goal-meta">目标 {week.recovery.targetHours}。{week.recovery.note}</p>
            </div>
          </div>
          </div>
          <TaskDetail task={selectedTask} sheetOpen={detailOpen} onClose={closeDetail} />
        </section>
      ) : null}

      {tab === "month" ? (
        <section className="paw-plan-view paw-plan-split">
          <div className="paw-plan-main">
          <div className="paw-month-toolbar" aria-label="选择月份">
            <Link className="paw-secondary-btn" href={`/plan?view=month&month=${month.previousMonthKey}`} aria-label="上个月">← 上月</Link>
            <form action="/plan" method="get" className="paw-month-picker">
              <input type="hidden" name="view" value="month" />
              <label htmlFor="plan-month">月份</label>
              <input key={month.monthKey} id="plan-month" className="paw-input" type="month" name="month" defaultValue={month.monthKey} />
              <button type="submit" className="paw-secondary-btn">查看</button>
            </form>
            <Link className="paw-secondary-btn" href={`/plan?view=month&month=${month.nextMonthKey}`} aria-label="下个月">下月 →</Link>
          </div>
          <h2 className="paw-month-heading">{month.monthLabel}</h2>
          <div className="paw-month-stats">
            <div className="paw-month-stat">
              <p className="paw-month-stat-num">{month.statusCounts.todo}</p>
              <p className="paw-month-stat-label">计划中</p>
            </div>
            <div className="paw-month-stat">
              <p className="paw-month-stat-num">{month.statusCounts.done}</p>
              <p className="paw-month-stat-label">已完成</p>
            </div>
            <div className="paw-month-stat">
              <p className="paw-month-stat-num">{month.statusCounts.backlog}</p>
              <p className="paw-month-stat-label">稍后处理</p>
            </div>
            <div className="paw-month-stat">
              <p className="paw-month-stat-num">{month.completionPercent}%</p>
              <p className="paw-month-stat-label">完成率</p>
            </div>
          </div>
          {month.statusCounts.skipped > 0 ? (
            <p className="paw-month-legacy-note">
              旧任务待整理 {month.statusCounts.skipped} 条 · <Link href="/backlog">前往稍后处理</Link>
            </p>
          ) : null}
          {month.emptyText ? (
            <article className="paw-goal-card mt-3">
              <h2 className="paw-goal-title">这个月还没有计划数据</h2>
              <p className="paw-goal-meta">{month.emptyText}</p>
              <span className="paw-deadline-tag">No data</span>
            </article>
          ) : (
            <>
              {month.days.length > 0 ? (
                <article className="paw-goal-card mt-3">
                  <h2 className="paw-goal-title">月视图</h2>
                  <div className="paw-month-calendar">
                    {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                      <span key={day} className="paw-month-weekday">周{day}</span>
                    ))}
                    {month.days.map((day) => (
                      <MonthDayCell
                        key={day.key}
                        day={day}
                        selected={selectedMonthDay?.key === day.key}
                        onSelect={(next) => {
                          setSelectedMonthDay(next);
                          if (next.tasks[0]) setSelectedTask(next.tasks[0]);
                        }}
                      />
                    ))}
                  </div>
                  {selectedMonthDay ? (
                    <>
                      <div
                        className="paw-month-sheet-backdrop"
                        aria-hidden="true"
                        onClick={() => setSelectedMonthDay(null)}
                      />
                      <div className="paw-month-selected" role="group" aria-label="当天任务">
                        <div className="paw-month-selected-head">
                          <div className="paw-section-label">
                            {selectedMonthDay.dateLabel} · 计划中 {selectedMonthDay.statusCounts.todo} · 完成 {selectedMonthDay.statusCounts.done}
                          </div>
                          <button
                            type="button"
                            className="paw-month-sheet-close"
                            aria-label="关闭"
                            onClick={() => setSelectedMonthDay(null)}
                          >
                            ×
                          </button>
                        </div>
                        <div className="paw-plan-task-list compact">
                          {selectedMonthDay.tasks.length === 0 ? <p className="paw-goal-meta">这一天没有任务。</p> : null}
                          {selectedMonthDay.tasks.map((task) => (
                            <TaskCard
                              key={task.id}
                              task={task}
                              onOpen={openTask}
                              compact
                              active={selectedTask?.id === task.id}
                            />
                          ))}
                        </div>
                      </div>
                    </>
                  ) : null}
                </article>
              ) : null}

              {month.projectSummaries.length > 0 ? (
                <article className="paw-goal-card mt-3">
                  <h2 className="paw-goal-title">按 Project 汇总</h2>
                  <div className="paw-month-projects">
                    {month.projectSummaries.map((project) => (
                      <div key={project.projectId ?? "unassigned"} className="paw-month-project-row">
                        <div className="paw-month-project-name">
                          <span className="paw-project-color" style={{ background: project.color }} aria-hidden="true" />
                          <strong>{project.projectName}</strong>
                          <small>{project.taskCount} 项 · {project.totalMinutes}</small>
                        </div>
                        <div className="paw-month-project-statuses">
                          <span>计划中 {project.statusCounts.todo}</span>
                          <span>完成 {project.statusCounts.done}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ) : null}

              {month.importSummary ? (
                <article className="paw-goal-card mt-3">
                  <h2 className="paw-goal-title">
                    {month.importSummary.monthLabel ?? month.importSummary.overallTitle ?? "本月目标"}
                  </h2>
                  {month.importSummary.monthGoal ? (
                    <p className="paw-goal-meta">{month.importSummary.monthGoal}</p>
                  ) : null}
                  {month.importSummary.milestones.length > 0 ? (
                    <ul className="mt-3 space-y-1">
                      {month.importSummary.milestones.map((m, i) => (
                        <li key={i} className="flex gap-2 text-sm text-[var(--app-ink-soft)]">
                          <span className="text-[var(--app-accent-dark)]">·</span>
                          <span>{m}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ) : null}

              {month.weeks.length > 0 ? (
                <article className="paw-goal-card mt-3">
                  <h2 className="paw-goal-title">每周任务分布</h2>
                  <div className="mt-4 grid gap-3">
                    {month.weeks.map((w) => (
                      <div key={w.label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-sm">
                        <span className="font-semibold text-[var(--app-ink)]">{w.label}</span>
                        <div className="paw-goal-progress">
                          <div className="paw-goal-progress-fill" style={{ width: `${Math.min(w.share, 100)}%` }} />
                        </div>
                        <span className="text-right text-xs font-semibold text-[var(--app-ink-soft)]">
                          {w.taskCount} 项 · {w.minutes}
                        </span>
                      </div>
                    ))}
                  </div>
                </article>
              ) : null}

              {month.cards.length > 0 ? (
                <div className="paw-month-goals mt-3">
                  {month.cards.map((card) => (
                    <article key={card.title} className="paw-goal-card">
                      <h2 className="paw-goal-title">{card.title}</h2>
                      <p className="paw-goal-meta">{card.text}</p>
                      {card.progress === null ? null : (
                        <div className="paw-goal-progress">
                          <div className="paw-goal-progress-fill" style={{ width: `${Math.min(card.progress, 100)}%` }} />
                        </div>
                      )}
                      <span className="paw-deadline-tag">{card.tag}</span>
                    </article>
                  ))}
                </div>
              ) : null}
            </>
          )}
          </div>
          <TaskDetail task={selectedTask} sheetOpen={detailOpen} onClose={closeDetail} />
        </section>
      ) : null}

      {tab === "reschedule" ? (
        <section className="paw-plan-view">
          <RescheduleList />
        </section>
      ) : null}
    </div>
  );
}
