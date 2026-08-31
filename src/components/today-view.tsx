"use client";

import { AlertTriangle, Archive, CalendarClock, Check, ChevronDown, Clock3, Copy, RotateCcw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { CatIcon } from "./cat-icon";
import { DailyCheckin } from "./daily-checkin";
import { TaskDetailContent } from "./task-detail-content";
import { TodayFixedTimeline } from "./today-fixed-timeline";
import { DialogSheet } from "./ui/dialog-sheet";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Notice } from "./ui/notice";
import { EmptyState } from "./ui/primitives";
import {
  defaultPostponeDate,
  moveOutOfScheduleUpdate,
  persistedDateMatchesDateKey,
  postponeTaskUpdate,
} from "@/lib/planning/task-actions";
import type { TodayViewData } from "@/lib/planning/view-data";

type Task = TodayViewData["tasks"][number];
type PersistedStatus = Task["status"];
type DisplayStatus = PersistedStatus | "blocked";
type TaskPatch = { status?: PersistedStatus; blocked?: boolean; date?: string };
type FetchTaskPatch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const weekdayChars = "日一二三四五六";
const priorityLabel: Record<"low" | "normal" | "high" | "urgent", string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};
const segmentLabel: Record<Task["segment"], string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};

export function formatTodayGreeting(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "01";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${month}月${day}日 星期${weekdayChars[weekday]}`;
}

function minutesLabel(minutes: number) {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function statusClass(status: DisplayStatus) {
  if (status === "done") return "done";
  if (status === "blocked") return "stuck";
  if (status === "backlog") return "deferred";
  return "";
}

export function buildTaskCopyText(task: Pick<Task, "title" | "context" | "track" | "minutes" | "energy" | "priority" | "notes" | "detail">) {
  const lines = [
    task.title,
    `${task.context} · ${task.track} · ${minutesLabel(task.minutes)} · 能量 ${task.energy} · 优先级 ${priorityLabel[task.priority]}`,
  ];
  if (task.detail.sections.length === 0 && task.notes?.trim()) lines.push("备注", task.notes.trim());
  task.detail.sections.forEach((section) => {
    lines.push(section.label);
    section.lines.forEach((line) => lines.push(`- ${line}`));
  });
  return lines.join("\n");
}

export async function persistTodayTaskUpdate(
  id: string,
  body: TaskPatch,
  request: FetchTaskPatch = fetch,
) {
  const response = await request("/api/tasks", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  if (!response.ok) throw new Error("Task update request failed");

  const payload = await response.json().catch(() => null) as { task?: unknown } | null;
  if (!payload || typeof payload.task !== "object" || payload.task === null) {
    throw new Error("Task update response was invalid");
  }

  const savedTask = payload.task as Record<string, unknown>;
  const statusMatches = body.status === undefined || savedTask.status === body.status;
  const blockedMatches = body.blocked === undefined || savedTask.blocked === body.blocked;
  const dateMatches = body.date === undefined || persistedDateMatchesDateKey(savedTask.date, body.date);
  if (savedTask.id !== id || !statusMatches || !blockedMatches || !dateMatches) {
    throw new Error("Task update response did not confirm the requested state");
  }
}

export function TodayView({ data, beforeTasks }: { data: TodayViewData; beforeTasks?: ReactNode }) {
  const [tasks, setTasks] = useState<Array<Task & { displayStatus: DisplayStatus }>>(
    () => data.tasks
      .map((task) => ({
        ...task,
        displayStatus: task.blocked && task.status === "todo" ? "blocked" as const : task.status,
      }))
      .sort((a, b) => Number(a.displayStatus === "done" || a.displayStatus === "backlog") - Number(b.displayStatus === "done" || b.displayStatus === "backlog")),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ taskId: string; message: string } | null>(null);
  const [postponeTask, setPostponeTask] = useState<Task | null>(null);
  const [moveOutTask, setMoveOutTask] = useState<Task | null>(null);
  const [postponeDate, setPostponeDate] = useState(() => defaultPostponeDate());
  const [savingActionId, setSavingActionId] = useState<string | null>(null);
  const [statusSavingIds, setStatusSavingIds] = useState<Set<string>>(() => new Set());
  const statusRequests = useRef<Set<string>>(new Set());
  const postponeDateRef = useRef<HTMLInputElement>(null);
  const [taskActionFeedback, setTaskActionFeedback] = useState<{ tone: "ok" | "error"; message: string } | null>(null);

  const doneCount = tasks.filter((task) => task.displayStatus === "done").length;
  const unresolvedTasks = tasks.filter((task) => task.displayStatus !== "done");
  const unresolvedMinutes = unresolvedTasks.reduce((sum, task) => sum + task.minutes, 0);
  // 猫的表情和台词跟随状态（小时数挂载后再取，避免 SSR 时区差异）
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    setHour(new Date().getHours());
  }, []);

  const allDone = tasks.length > 0 && doneCount === tasks.length;
  const blockedCount = tasks.filter((task) => task.displayStatus === "blocked").length;
  let catMood: "happy" | "think" | "sleep" | "celebrate" | "worried" | "cheer" = "think";
  if (allDone) catMood = "celebrate";
  else if (hour !== null && (hour >= 22 || hour < 4)) catMood = "sleep";
  else if (blockedCount > 0) catMood = "worried";
  else if (tasks.length === 0) catMood = "sleep";
  else if (doneCount > 0) catMood = "cheer";

  // 问候语随时段；挂载后才取（避免 SSR 时区差异），未挂载时用中性问候
  const greeting = hour === null ? "你好" : hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  // 进度环：挂载后再把描边补到目标值，做一次绘入动画
  const ringCircumference = 138;
  const ringOffset = hour === null || tasks.length === 0 ? ringCircumference : ringCircumference * (1 - doneCount / tasks.length);

  function openPostpone(task: Task) {
    if (savingActionId || statusRequests.current.has(task.id)) return;
    setPostponeTask(task);
    setPostponeDate(defaultPostponeDate());
    setTaskActionFeedback(null);
  }

  async function postponeSelectedTask(event: React.FormEvent) {
    event.preventDefault();
    if (!postponeTask || savingActionId) return;

    setSavingActionId(postponeTask.id);
    const update = postponeTaskUpdate(postponeTask.id, postponeDate);
    try {
      await persistTodayTaskUpdate(postponeTask.id, { date: update.date, status: update.status });
    } catch {
      setSavingActionId(null);
      setTaskActionFeedback({ tone: "error", message: "延后结果无法确认，请刷新后核对任务日期。" });
      return;
    }

    setSavingActionId(null);
    setTasks((current) => current.filter((task) => task.id !== postponeTask.id));
    setPostponeTask(null);
    setTaskActionFeedback({ tone: "ok", message: `已延后到 ${postponeDate}，任务仍保持待办。` });
  }

  async function confirmMoveOutOfSchedule() {
    const task = moveOutTask;
    if (!task || savingActionId || statusRequests.current.has(task.id)) return;

    setSavingActionId(task.id);
    const update = moveOutOfScheduleUpdate(task.id);
    try {
      await persistTodayTaskUpdate(task.id, { status: update.status });
    } catch {
      setSavingActionId(null);
      setTaskActionFeedback({ tone: "error", message: "移出排期结果无法确认，请刷新后核对任务位置。" });
      return;
    }

    setSavingActionId(null);
    setTasks((current) => current.filter((item) => item.id !== task.id));
    setMoveOutTask(null);
    setTaskActionFeedback({ tone: "ok", message: "已移出排期，可在稍后处理页面找到。" });
  }

  async function setTaskStatus(id: string, status: DisplayStatus) {
    if (savingActionId === id || statusRequests.current.has(id)) return;
    const currentTask = tasks.find((task) => task.id === id);
    if (!currentTask) return;

    statusRequests.current.add(id);
    setStatusSavingIds((current) => new Set(current).add(id));
    setTaskActionFeedback(null);

    let patch: TaskPatch;
    let optimisticTask: Task & { displayStatus: DisplayStatus };

    // 卡住：独立于 status 的持久化标记
    if (status === "blocked") {
      const nextBlocked = currentTask.displayStatus !== "blocked";
      patch = { blocked: nextBlocked };
      optimisticTask = {
        ...currentTask,
        blocked: nextBlocked,
        displayStatus: nextBlocked ? "blocked" : "todo",
      };
    } else {
      const nextStatus = currentTask.displayStatus === status ? "todo" : status;
      const wasBlocked = currentTask.displayStatus === "blocked";
      patch = wasBlocked ? { status: nextStatus, blocked: false } : { status: nextStatus };
      optimisticTask = {
        ...currentTask,
        displayStatus: nextStatus,
        status: nextStatus,
        done: nextStatus === "done",
        blocked: wasBlocked ? false : currentTask.blocked,
      };
    }

    setTasks((current) => current.map((task) => task.id === id ? optimisticTask : task));
    try {
      await persistTodayTaskUpdate(id, patch);
    } catch {
      setTasks((current) => current.map((task) => task.id === id ? currentTask : task));
      setTaskActionFeedback({ tone: "error", message: `“${currentTask.title}”状态保存失败，已恢复原状态，请重试。` });
    } finally {
      statusRequests.current.delete(id);
      setStatusSavingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function copyTaskDetails(task: Task) {
    try {
      await navigator.clipboard.writeText(buildTaskCopyText(task));
      setCopyFeedback({ taskId: task.id, message: "资料已复制。" });
    } catch {
      setCopyFeedback({ taskId: task.id, message: "复制失败，请手动选中文本。" });
    }
  }

  return (
    <div className="paw-page paw-today-page">
      <div className="paw-today-main">
      <section className="paw-today-header">
        <div className="paw-today-hero">
          <div className="paw-today-hero-text">
            <p className="paw-today-greeting">{greeting}</p>
            <h1 className="paw-today-headline">{formatTodayGreeting()}</h1>
          </div>
          <span className="paw-today-cat">
            <CatIcon size={40} mood={catMood} />
          </span>
        </div>

        {tasks.length > 0 ? (
          <div className="paw-today-progress">
            <span className="paw-ring" aria-hidden="true">
              <svg width="48" height="48" viewBox="0 0 52 52">
                <circle cx="26" cy="26" r="22" fill="none" stroke="var(--app-muted-soft)" strokeWidth="5" />
                <circle
                  cx="26"
                  cy="26"
                  r="22"
                  fill="none"
                  stroke="var(--app-positive)"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringOffset}
                  transform="rotate(-90 26 26)"
                  style={{ transition: "stroke-dashoffset 350ms ease" }}
                />
              </svg>
              <span className="paw-ring-label">{doneCount}/{tasks.length}</span>
            </span>
            <dl className="paw-today-metrics">
              <div>
                <dt>待办</dt>
                <dd>{unresolvedTasks.length}</dd>
              </div>
              <div>
                <dt>剩余任务时长</dt>
                <dd>{minutesLabel(unresolvedMinutes)}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {data.patchCount > 0 ? (
          <Link href="/review" className="paw-today-review-entry">
            <span>
              <strong>查看 {data.patchCount} 条调整建议</strong>
              <small>审核后才会修改计划</small>
            </span>
            <span aria-hidden="true">→</span>
          </Link>
        ) : null}

        {data.warnings
          .filter((warning) => warning.id !== "over_capacity" && warning.id !== "capacity_overload")
          .slice(0, 1)
          .map((warning) => (
            <p key={warning.id} className="paw-today-warn">
              <AlertTriangle size={13} /> {warning.title}
            </p>
          ))}
      </section>

      {data.dataUnavailable ? (
        <section className="paw-status-pill warn" role="status">
          当前没有 DATABASE_URL，Today 显示为空态；配置数据库后会读取真实计划。
        </section>
      ) : null}

      {beforeTasks}

      <section>
        <div className="paw-today-tasks-head">
          <h2 className="paw-today-tasks-title">今日任务</h2>
          {tasks.length > 0 ? <span className="paw-today-tasks-hint">向下越做越轻</span> : null}
        </div>

        {taskActionFeedback ? (
          <Notice
            tone={taskActionFeedback.tone === "error" ? "danger" : "success"}
            title={taskActionFeedback.message}
            dismissible
            onDismiss={() => setTaskActionFeedback(null)}
          />
        ) : null}

        {tasks.length > 0 && doneCount === tasks.length ? (
          <div className="paw-celebrate" role="status">
            <CatIcon size={44} mood="celebrate" />
            <p className="paw-celebrate-text">今天全部搞定，收工！</p>
          </div>
        ) : null}

        {tasks.length === 0 ? (
          <EmptyState
            title="今天还没有安排任务"
            description="临时想法统一放进收集箱；需要时再决定要不要安排。"
            action={<Link href="/inbox" className="paw-ui-button paw-ui-button-secondary">去收集</Link>}
          />
        ) : null}

        <div className="paw-task-list">
          {tasks.map((task) => {
            const expanded = expandedId === task.id;
            const statusSaving = statusSavingIds.has(task.id);
            return (
            <article key={task.id} data-task-id={task.id} aria-busy={statusSaving} className={`paw-task-card ${statusClass(task.displayStatus)} ${expanded ? "expanded" : ""}`}>
              <div className="paw-task-head">
                <button
                  type="button"
                  onClick={() => void setTaskStatus(task.id, "done")}
                  className={`paw-task-check ${task.displayStatus === "done" ? "selected" : ""}`}
                  aria-label={task.displayStatus === "done" ? "标记为未完成" : "标记完成"}
                  disabled={statusSaving || savingActionId === task.id}
                >
                  <Check size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : task.id)}
                  className="paw-task-summary"
                  aria-expanded={expanded}
                >
                  <span className="paw-task-title-row">
                    {task.isChore ? <span className="paw-chore-badge">杂事</span> : null}
                    <span className="paw-task-title">{task.title}</span>
                  </span>
                  <span className="paw-task-headmeta">
                    <Clock3 size={12} aria-hidden="true" />
                    {segmentLabel[task.segment]} · {minutesLabel(task.minutes)}
                    <ChevronDown size={16} className="paw-task-chevron" />
                  </span>
                </button>
              </div>
              {expanded ? (
                <div className="paw-task-detail">
                  <div className="paw-task-meta">
                    <span className="paw-task-tag">{task.context}</span>
                    <span>{task.track}</span>
                    <span>能量 {task.energy}</span>
                    <span>优先级 {priorityLabel[task.priority]}</span>
                  </div>
                  <TaskDetailContent detail={task.detail} notes={task.notes} />
                  <div className="paw-task-copy-row">
                    <button type="button" onClick={() => void copyTaskDetails(task)} className="paw-secondary-btn paw-task-copy-button">
                      <Copy size={14} />
                      复制资料
                    </button>
                    {copyFeedback?.taskId === task.id ? <span className="paw-task-copy-feedback">{copyFeedback.message}</span> : null}
                  </div>
                  <div className="paw-task-actions">
                    <button
                      type="button"
                      onClick={() => void setTaskStatus(task.id, "blocked")}
                      className={`paw-act-btn stuck ${task.displayStatus === "blocked" ? "selected" : ""}`}
                      disabled={statusSaving || savingActionId === task.id}
                    >
                      卡住
                    </button>
                    <button
                      type="button"
                      onClick={() => openPostpone(task)}
                      className="paw-act-btn defer primary-secondary"
                      disabled={savingActionId === task.id || statusSaving}
                    >
                      <CalendarClock size={13} />
                      延后
                    </button>
                    <button
                      type="button"
                      onClick={() => setMoveOutTask(task)}
                      className="paw-act-btn archive"
                      disabled={savingActionId === task.id || statusSaving}
                    >
                      <Archive size={13} />
                      移出排期
                    </button>
                  </div>
                  {task.displayStatus === "blocked" ? (
                    <p className="paw-task-blocked-note">
                      <AlertTriangle size={12} />
                      已标记为卡住；需要调整时，请到审核页查看建议。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </article>
            );
          })}
        </div>
      </section>

      {unresolvedTasks.length > 0 || data.warnings.length > 0 ? (
        <Link href="/review" className="paw-today-rebalance">
          <RotateCcw size={15} />
          <span>
            <strong>查看审核与调整</strong>
            <small>PawPlan 不会自动修改日程</small>
          </span>
          <span className="paw-today-rebalance-arrow" aria-hidden="true">→</span>
        </Link>
      ) : null}

      <DailyCheckin
        initialCompletedText={data.checkin?.completedText}
        initialBlockerText={data.checkin?.blockerText}
        initialNextText={data.checkin?.nextText}
        initialStreakDays={data.streakDays}
        dataUnavailable={data.dataUnavailable}
      />
      </div>

      <aside className="paw-today-desktop-timeline">
        <TodayFixedTimeline items={data.exactFixedItems} />
      </aside>

      <DialogSheet
        open={Boolean(postponeTask)}
        onClose={() => {
          if (!savingActionId) setPostponeTask(null);
        }}
        title="选择新日期"
        description={postponeTask ? `“${postponeTask.title}”会保持待办，只修改计划日期。` : undefined}
        initialFocusRef={postponeDateRef}
        closeDisabled={Boolean(savingActionId)}
      >
        <form onSubmit={postponeSelectedTask}>
          <label className="paw-field-label" htmlFor="postpone-date">新日期</label>
          <input
            id="postpone-date"
            ref={postponeDateRef}
            type="date"
            className="paw-input"
            min={defaultPostponeDate()}
            value={postponeDate}
            onChange={(event) => setPostponeDate(event.target.value)}
            required
          />
          <div className="paw-modal-actions">
            <button type="button" className="paw-secondary-btn" onClick={() => setPostponeTask(null)} disabled={Boolean(savingActionId)}>
              取消
            </button>
            <button type="submit" className="paw-primary-btn" disabled={Boolean(savingActionId)}>
              {savingActionId ? "保存中…" : "确认延后"}
            </button>
          </div>
        </form>
      </DialogSheet>

      <ConfirmDialog
        open={Boolean(moveOutTask)}
        onClose={() => {
          if (!savingActionId) setMoveOutTask(null);
        }}
        onConfirm={() => void confirmMoveOutOfSchedule()}
        title="移出排期？"
        description={moveOutTask ? `“${moveOutTask.title}”将不再出现在今天，也不再参与排期。` : ""}
        confirmLabel="移出排期"
        pending={Boolean(moveOutTask && savingActionId === moveOutTask.id)}
        destructive
      >
        任务会进入“稍后处理”，内容不会被删除，之后仍可找回。
      </ConfirmDialog>
    </div>
  );
}
