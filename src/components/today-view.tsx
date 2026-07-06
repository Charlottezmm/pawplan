"use client";

import { AlertTriangle, Check, ChevronDown, Clock3, Copy, Plus, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CatIcon } from "./cat-icon";
import { DailyCheckin } from "./daily-checkin";
import type { TodayViewData } from "@/lib/planning/view-data";

type Task = TodayViewData["tasks"][number];
type PersistedStatus = Task["status"];
type DisplayStatus = PersistedStatus | "blocked";
const weekdayChars = "日一二三四五六";
const priorityLabel: Record<"low" | "normal" | "high" | "urgent", string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
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
  if (status === "skipped") return "skipped";
  if (status === "backlog") return "deferred";
  return "";
}

export function buildTaskCopyText(task: Pick<Task, "title" | "context" | "track" | "minutes" | "energy" | "priority" | "notes" | "detail">) {
  const lines = [
    task.title,
    `${task.context} · ${task.track} · ${minutesLabel(task.minutes)} · 能量 ${task.energy} · 优先级 ${priorityLabel[task.priority]}`,
  ];
  if (task.notes?.trim()) lines.push("备注", task.notes.trim());
  task.detail.sections.forEach((section) => {
    lines.push(section.label);
    section.lines.forEach((line) => lines.push(`- ${line}`));
  });
  return lines.join("\n");
}

export function TodayView({ data, beforeTasks }: { data: TodayViewData; beforeTasks?: ReactNode }) {
  const [tasks, setTasks] = useState<Array<Task & { displayStatus: DisplayStatus }>>(
    data.tasks.map((task) => ({
      ...task,
      displayStatus: task.blocked && task.status === "todo" ? "blocked" : task.status,
    })),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [choreText, setChoreText] = useState("");
  const [choreSaving, setChoreSaving] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ taskId: string; message: string } | null>(null);

  async function addChore(event: React.FormEvent) {
    event.preventDefault();
    const title = choreText.trim();
    if (!title || choreSaving || data.dataUnavailable) return;
    setChoreSaving(true);
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setChoreSaving(false);
    if (!response.ok) return;
    const { task } = (await response.json()) as { task: { id: string; daySegment: Task["segment"] } };
    setTasks((current) => [
      {
        id: task.id,
        segment: task.daySegment,
        title,
        context: "未分类",
        track: "未分类",
        minutes: 15,
        energy: "中",
        priority: "normal",
        notes: null,
        detail: { summary: null, sections: [] },
        status: "todo",
        blocked: false,
        done: false,
        isChore: true,
        displayStatus: "todo",
      },
      ...current,
    ]);
    setChoreText("");
  }

  const doneCount = tasks.filter((task) => task.displayStatus === "done").length;
  const unresolvedTasks = tasks.filter((task) => task.displayStatus !== "done");
  const unresolvedMinutes = unresolvedTasks.reduce((sum, task) => sum + task.minutes, 0);
  const fixedMinutes = useMemo(() => {
    return data.routines.reduce((sum, routine) => sum + routine.minutes, 0);
  }, [data.routines]);

  // 完成 / 跳过 / 延后的任务沉到列表底部，未处理的永远在最上面
  const sortedTasks = useMemo(() => {
    const sunk = new Set<DisplayStatus>(["done", "skipped", "backlog"]);
    return [...tasks].sort(
      (a, b) => Number(sunk.has(a.displayStatus)) - Number(sunk.has(b.displayStatus)),
    );
  }, [tasks]);

  // FLIP：卡片重新排序时做位置过渡动画
  const listRef = useRef<HTMLDivElement>(null);
  const cardPositions = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [];
    cards.forEach((el) => {
      const id = el.dataset.taskId;
      if (!id) return;
      const nextTop = el.getBoundingClientRect().top;
      const prevTop = cardPositions.current.get(id);
      if (prevTop !== undefined && prevTop !== nextTop) {
        el.animate(
          [{ transform: `translateY(${prevTop - nextTop}px)` }, { transform: "none" }],
          { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
      cardPositions.current.set(id, nextTop);
    });
  });

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

  async function patchTask(id: string, body: { status?: PersistedStatus; blocked?: boolean }) {
    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
  }

  function setTaskStatus(id: string, status: DisplayStatus) {
    const currentTask = tasks.find((task) => task.id === id);
    if (!currentTask) return;

    // 卡住：独立于 status 的持久化标记
    if (status === "blocked") {
      const nextBlocked = currentTask.displayStatus !== "blocked";
      setTasks((current) =>
        current.map((task) =>
          task.id === id ? { ...task, displayStatus: nextBlocked ? "blocked" : "todo" } : task,
        ),
      );
      void patchTask(id, { blocked: nextBlocked });
      return;
    }

    const nextStatus = currentTask.displayStatus === status ? "todo" : status;
    const wasBlocked = currentTask.displayStatus === "blocked";
    setTasks((current) =>
      current.map((task) =>
        task.id === id
          ? {
              ...task,
              displayStatus: nextStatus,
              status: nextStatus,
              done: nextStatus === "done" || nextStatus === "skipped",
            }
          : task,
      ),
    );
    // 设真实状态时，若此前被标卡住，一并清掉 blocked
    void patchTask(id, wasBlocked ? { status: nextStatus, blocked: false } : { status: nextStatus });
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
    <div className="paw-page">
      <section className="paw-today-header">
        <div className="paw-today-hero">
          <div className="paw-today-hero-text">
            <p className="paw-greeting">{formatTodayGreeting()}</p>
            <h1 className="paw-today-headline">{greeting}</h1>
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
                  style={{ transition: "stroke-dashoffset 800ms cubic-bezier(0.22, 1, 0.36, 1)" }}
                />
              </svg>
              <span className="paw-ring-label">{doneCount}/{tasks.length}</span>
            </span>
            <p className="paw-today-progress-line">
              今天 {tasks.length} 件
              {fixedMinutes > 0 ? ` · 固定 ${minutesLabel(fixedMinutes)}` : ""}
              {` · 剩余 ${minutesLabel(unresolvedMinutes)}`}
              {data.patchCount > 0 ? (
                <>
                  {" · "}
                  <a href="/review" className="paw-today-progress-link">{data.patchCount} 条建议待确认</a>
                </>
              ) : null}
            </p>
          </div>
        ) : null}

        {data.warnings.slice(0, 1).map((warning) => (
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

        <form className="paw-chore-add" onSubmit={addChore}>
          <input
            type="text"
            value={choreText}
            onChange={(event) => setChoreText(event.target.value)}
            placeholder="记个杂事，回车加进今天（15 分钟）"
            disabled={data.dataUnavailable}
            className="paw-chore-input"
            aria-label="记个今日杂事"
          />
          <button type="submit" disabled={!choreText.trim() || choreSaving || data.dataUnavailable} className="paw-chore-btn">
            <Plus size={15} /> 加杂事
          </button>
        </form>

        {tasks.length > 0 && doneCount === tasks.length ? (
          <div className="paw-celebrate" role="status">
            <CatIcon size={44} mood="celebrate" />
            <p className="paw-celebrate-text">今天全部搞定，收工！</p>
          </div>
        ) : null}

        {tasks.length === 0 ? (
          <div className="paw-empty">
            <p>今天还没有安排任务。</p>
            <p>点右下角的小猫记个想法，或者在「更多 → 导入」里放入你的计划。</p>
          </div>
        ) : null}

        <div className="paw-task-list" ref={listRef}>
          {sortedTasks.map((task) => {
            const expanded = expandedId === task.id;
            return (
            <article key={task.id} data-task-id={task.id} className={`paw-task-card ${statusClass(task.displayStatus)} ${expanded ? "expanded" : ""}`}>
              <div className="paw-task-head">
                <button
                  type="button"
                  onClick={() => setTaskStatus(task.id, "done")}
                  className={`paw-task-check ${task.displayStatus === "done" ? "selected" : ""}`}
                  aria-label={task.displayStatus === "done" ? "标记为未完成" : "标记完成"}
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
                    <Clock3 size={12} />
                    {minutesLabel(task.minutes)}
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
                  {task.notes ? (
                    <p className="paw-task-notes">{task.notes}</p>
                  ) : task.detail.sections.length === 0 ? (
                    <p className="paw-task-notes muted">这条任务还没有详细描述。</p>
                  ) : null}
                  {task.detail.sections.length > 0 ? (
                    <div className="paw-task-sections">
                      {task.detail.sections.map((section) => (
                        <section key={section.label}>
                          <h4>{section.label}</h4>
                          {section.lines.length > 0 ? (
                            <ul>
                              {section.lines.map((line, index) => (
                                <li key={`${section.label}-${index}`}>{line}</li>
                              ))}
                            </ul>
                          ) : null}
                        </section>
                      ))}
                    </div>
                  ) : null}
                  <div className="paw-task-copy-row">
                    <button type="button" onClick={() => void copyTaskDetails(task)} className="paw-secondary-btn !px-3 !py-1.5 !text-xs">
                      <Copy size={14} />
                      复制资料
                    </button>
                    {copyFeedback?.taskId === task.id ? <span className="paw-task-copy-feedback">{copyFeedback.message}</span> : null}
                  </div>
                  <div className="paw-task-actions">
                    <button
                      type="button"
                      onClick={() => setTaskStatus(task.id, "blocked")}
                      className={`paw-act-btn stuck ${task.displayStatus === "blocked" ? "selected" : ""}`}
                    >
                      卡住
                    </button>
                    <button
                      type="button"
                      onClick={() => setTaskStatus(task.id, "skipped")}
                      className={`paw-act-btn skip ${task.displayStatus === "skipped" ? "selected" : ""}`}
                    >
                      跳过
                    </button>
                    <button
                      type="button"
                      onClick={() => setTaskStatus(task.id, "backlog")}
                      className={`paw-act-btn defer ${task.displayStatus === "backlog" ? "selected" : ""}`}
                    >
                      延后
                    </button>
                  </div>
                  {task.displayStatus === "blocked" ? (
                    <p className="mt-2 flex items-center gap-1 text-xs text-amber-700">
                      <AlertTriangle size={12} />
                      标了卡住没关系，Agent 会帮你想办法重排。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </article>
            );
          })}
        </div>
      </section>

      {tasks.length > 0 ? (
        <a href="/review" className="paw-today-rebalance">
          <RotateCcw size={15} />
          没做完的交给我重排
          <span className="paw-today-rebalance-arrow">→</span>
        </a>
      ) : null}

      <DailyCheckin
        initialCompletedText={data.checkin?.completedText}
        initialBlockerText={data.checkin?.blockerText}
        initialNextText={data.checkin?.nextText}
        initialStreakDays={data.streakDays}
        dataUnavailable={data.dataUnavailable}
      />
    </div>
  );
}
