"use client";

import { ArrowUpRight, ChevronDown, RefreshCcw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { BackLink } from "./back-link";
import { CatIcon } from "./cat-icon";
import { QuickCapture } from "./quick-capture";
import { Notice } from "./ui/notice";
import type { InboxItemView } from "@/lib/planning/view-data";

type DaySegment = "morning" | "afternoon" | "evening";
type RoutineTimeSegment = DaySegment | "specific_window";
type TaskPriority = "low" | "normal" | "high" | "urgent";
type InboxAction = "task" | "quick_chore_task" | "routine" | "delete";
type PromotionDestination = "task" | "routine";
type PromotionErrorField = "taskDate" | "taskEstimate" | "routinePattern" | "routineEstimate";

type PromotionErrors = Partial<Record<PromotionErrorField, string>>;
type InboxNotice = {
  message: string;
  tone: "success" | "danger" | "info";
};

type PromotionForm = {
  taskDate: string;
  taskSegment: DaySegment;
  taskEstimate: string;
  taskPriority: TaskPriority;
  routinePattern: string;
  routineSegment: RoutineTimeSegment;
  routineEstimate: string;
};

type InboxActionPayload =
  | { action: "delete" }
  | {
      action: "task";
      date: string;
      daySegment: DaySegment;
      estimatedMinutes: number;
      priority?: TaskPriority;
    }
  | {
      action: "quick_chore_task";
      daySegment?: DaySegment;
    }
  | {
      action: "routine";
      weekdayPattern: string;
      defaultTimeSegment: RoutineTimeSegment;
      estimatedMinutes: number;
    };

const actionLabels: Record<InboxAction, string> = {
  task: "已提升为任务",
  quick_chore_task: "已加入今日小杂事",
  routine: "已转成日常",
  delete: "已删除",
};

const segmentLabels: Record<DaySegment, string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};

const routineSegmentLabels: Record<RoutineTimeSegment, string> = {
  ...segmentLabels,
  specific_window: "固定时间窗",
};

const priorityLabels: Record<TaskPriority, string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};

const weekdayOptions = [
  { value: "mon", label: "一" },
  { value: "tue", label: "二" },
  { value: "wed", label: "三" },
  { value: "thu", label: "四" },
  { value: "fri", label: "五" },
  { value: "sat", label: "六" },
  { value: "sun", label: "日" },
] as const;

function localDateKey(date: Date) {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyOffset(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function defaultPromotionForm(todayKey: string): PromotionForm {
  return {
    taskDate: todayKey,
    taskSegment: "morning",
    taskEstimate: "30",
    taskPriority: "normal",
    routinePattern: "daily",
    routineSegment: "evening",
    routineEstimate: "30",
  };
}

function minutesFromInput(value: string) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes)) return null;
  if (minutes < 5 || minutes > 480) return null;
  return minutes;
}

function captureAgeLabel(age: string) {
  return age === "刚刚" ? "刚刚捕获" : `${age} 前捕获`;
}

export function InboxView({
  initialItems,
  dataUnavailable = false,
}: {
  initialItems: InboxItemView[];
  dataUnavailable?: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [notice, setNotice] = useState<InboxNotice | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [todayKey] = useState(() => localDateKey(new Date()));
  const [forms, setForms] = useState<Record<string, PromotionForm>>({});
  const [destinations, setDestinations] = useState<Record<string, PromotionDestination>>({});
  const [errors, setErrors] = useState<Record<string, PromotionErrors>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const overLimit = items.length > 10;

  function formFor(id: string) {
    return forms[id] ?? defaultPromotionForm(todayKey);
  }

  function updateForm(id: string, patch: Partial<PromotionForm>) {
    setForms((current) => ({
      ...current,
      [id]: { ...defaultPromotionForm(todayKey), ...current[id], ...patch },
    }));
  }

  function clearError(id: string, field: PromotionErrorField) {
    setErrors((current) => ({
      ...current,
      [id]: { ...current[id], [field]: undefined },
    }));
  }

  function updateField(id: string, patch: Partial<PromotionForm>, field: PromotionErrorField) {
    updateForm(id, patch);
    clearError(id, field);
  }

  function selectedWeekdays(pattern: string) {
    if (pattern === "daily") return [];
    return pattern.split(",").filter(Boolean);
  }

  function setRoutineDaily(id: string) {
    updateField(id, { routinePattern: "daily" }, "routinePattern");
  }

  function toggleRoutineWeekday(id: string, weekday: string) {
    const current = selectedWeekdays(formFor(id).routinePattern);
    const selected = new Set(current);
    if (selected.has(weekday)) selected.delete(weekday);
    else selected.add(weekday);
    const ordered = weekdayOptions.map((option) => option.value).filter((value) => selected.has(value));
    updateField(id, { routinePattern: ordered.join(",") }, "routinePattern");
  }

  useEffect(() => {
    function handleCreated(event: Event) {
      const item = (event as CustomEvent<{ id: string; title: string }>).detail;
      if (!item?.id || !item.title) return;
      setItems((current) => [{ id: item.id, title: item.title, age: "刚刚" }, ...current]);
      setNotice({ message: "已加入收集。", tone: "success" });
    }

    window.addEventListener("inbox:item-created", handleCreated);
    return () => window.removeEventListener("inbox:item-created", handleCreated);
  }, []);

  async function act(id: string, payload: InboxActionPayload) {
    if (dataUnavailable) {
      setNotice({ message: "本地数据源未配置，暂时无法处理。", tone: "danger" });
      return;
    }

    setPendingId(id);
    try {
      const response = await fetch("/api/inbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...payload }),
      });

      if (!response.ok) {
        setNotice({ message: "处理失败，请重试。", tone: "danger" });
        return;
      }

      setItems((current) => current.filter((item) => item.id !== id));
      setForms((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setDestinations((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (expandedId === id) setExpandedId(null);
      setNotice({ message: `${actionLabels[payload.action]}。`, tone: "success" });
    } catch {
      setNotice({ message: "网络连接失败，条目没有改变，请重试。", tone: "danger" });
    } finally {
      setPendingId(null);
    }
  }

  function promoteTask(id: string) {
    const form = formFor(id);
    const estimatedMinutes = minutesFromInput(form.taskEstimate);
    const nextErrors: PromotionErrors = {
      taskDate: form.taskDate ? undefined : "请选择任务日期。",
      taskEstimate: estimatedMinutes ? undefined : "请输入 5–480 之间的整数分钟。",
    };
    setErrors((current) => ({ ...current, [id]: { ...current[id], ...nextErrors } }));
    if (!form.taskDate || !estimatedMinutes) {
      setNotice({ message: "请检查任务信息后再保存。", tone: "danger" });
      return;
    }

    void act(id, {
      action: "task",
      date: form.taskDate,
      daySegment: form.taskSegment,
      estimatedMinutes,
      priority: form.taskPriority,
    });
  }

  function quickPromoteTask(id: string, dayOffset: number) {
    const form = formFor(id);
    const estimatedMinutes = minutesFromInput(form.taskEstimate);
    setErrors((current) => ({
      ...current,
      [id]: {
        ...current[id],
        taskEstimate: estimatedMinutes ? undefined : "请输入 5–480 之间的整数分钟。",
      },
    }));
    if (!estimatedMinutes) {
      setNotice({ message: "请先填写有效估时；快捷保存不会使用隐藏默认值。", tone: "danger" });
      return;
    }
    void act(id, {
      action: "task",
      date: dateKeyOffset(dayOffset),
      daySegment: form.taskSegment,
      estimatedMinutes,
      priority: form.taskPriority,
    });
  }

  function promoteRoutine(id: string) {
    const form = formFor(id);
    const estimatedMinutes = minutesFromInput(form.routineEstimate);
    const nextErrors: PromotionErrors = {
      routinePattern: form.routinePattern ? undefined : "请选择每天或至少一个星期。",
      routineEstimate: estimatedMinutes ? undefined : "请输入 5–480 之间的整数分钟。",
    };
    setErrors((current) => ({ ...current, [id]: { ...current[id], ...nextErrors } }));
    if (!form.routinePattern || !estimatedMinutes) {
      setNotice({ message: "请检查日常信息后再保存。", tone: "danger" });
      return;
    }

    void act(id, {
      action: "routine",
      weekdayPattern: form.routinePattern.trim(),
      defaultTimeSegment: form.routineSegment,
      estimatedMinutes,
    });
  }

  function deleteItem(id: string, title: string) {
    const confirmed = window.confirm(`确定删除“${title}”吗？删除后无法恢复。`);
    if (!confirmed) return;
    void act(id, { action: "delete" });
  }

  return (
    <div className="paw-page">
      <section className="paw-page-header">
        <BackLink />
        <h1 className="paw-page-date">收集</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">想到什么先记进暂存区；不会自动排进计划。攒着的 {items.length} 条想处理时再处理。</p>
        </div>
        <div className="paw-status-pills">
          <span className="paw-status-pill">未处理 {items.length}</span>
          <span className="paw-status-pill">不占今日容量</span>
        </div>
      </section>

      {notice ? (
        <Notice
          tone={notice.tone}
          title={notice.message}
          dismissible={notice.tone === "danger"}
          autoDismissMs={notice.tone === "success" ? 2400 : undefined}
          onDismiss={() => setNotice(null)}
          className="paw-inbox-notice"
        />
      ) : null}

      {dataUnavailable ? (
        <section className="paw-trust-banner">
          <TriangleAlert size={18} className="mt-0.5 flex-none text-amber-700" />
          当前没有 DATABASE_URL，收集页会显示为空态；配置数据库后会读取真实数据。
        </section>
      ) : null}

      {overLimit ? (
        <section className="paw-trust-banner">
          <CatIcon size={28} mood="worried" />
          攒了 10 多条啦，挑几条处理一下吧，不用一次清空。
        </section>
      ) : null}

      <QuickCapture />

      <section className="paw-list-card">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">未处理条目</h2>
            <p className="paw-list-subtitle">捕获只保存标题；提升时再明确日期、时段、估时或重复规则。</p>
          </div>
          <span className="paw-status-pill">不打扰计划</span>
        </div>

        {items.length === 0 ? (
          <div className="paw-empty mt-4">
            <h3>暂存区是空的</h3>
            <p>随手记下的想法会先到这里，想处理的时候再处理。</p>
          </div>
        ) : (
          <div className="paw-list">
            {items.map((item) => {
              const form = formFor(item.id);
              const destination = destinations[item.id];
              const itemErrors = errors[item.id] ?? {};
              const taskEstimateLabel = form.taskEstimate ? `${form.taskEstimate} 分` : "未填写估时";
              const chosenWeekdays = selectedWeekdays(form.routinePattern);
              return (
              <div key={item.id} className="paw-inbox-item">
                <div className="paw-inbox-head">
                  <div className="min-w-0">
                    <p className="paw-row-title">{item.title}</p>
                    <p className="paw-row-meta">{captureAgeLabel(item.age)} · 未安排，不占今日容量</p>
                  </div>
                  <div className="paw-inbox-head-actions">
                    <button
                      type="button"
                      disabled={pendingId === item.id}
                      onClick={() => void act(item.id, { action: "quick_chore_task" })}
                      className="paw-secondary-btn paw-inbox-control"
                    >
                      <ArrowUpRight size={13} />
                      今日杂事
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                      className="paw-secondary-btn paw-inbox-control"
                      aria-expanded={expandedId === item.id}
                    >
                      提升…
                      <ChevronDown size={13} className={`paw-inbox-chevron ${expandedId === item.id ? "open" : ""}`} />
                    </button>
                    <button
                      type="button"
                      disabled={pendingId === item.id}
                      onClick={() => deleteItem(item.id, item.title)}
                      className="paw-secondary-btn paw-inbox-control paw-inbox-delete"
                      aria-label="删除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {expandedId === item.id ? (
                  <div className="paw-inbox-detail">
                    <div className="paw-inbox-destination">
                      <span className="paw-field-label">要放到哪里？</span>
                      <div className="paw-inbox-destination-options" role="group" aria-label="选择条目去向">
                        <button
                          type="button"
                          aria-pressed={destination === "task"}
                          onClick={() => setDestinations((current) => ({ ...current, [item.id]: "task" }))}
                          className="paw-secondary-btn paw-inbox-control"
                        >
                          任务
                        </button>
                        <button
                          type="button"
                          aria-pressed={destination === "routine"}
                          onClick={() => setDestinations((current) => ({ ...current, [item.id]: "routine" }))}
                          className="paw-secondary-btn paw-inbox-control"
                        >
                          日常
                        </button>
                      </div>
                    </div>

                    {destination === "task" ? (
                    <div className="paw-inbox-form paw-inbox-task-form">
                      <div className="paw-inbox-quickdates">
                        <span className="paw-field-label">快捷保存</span>
                        <button type="button" disabled={pendingId === item.id} onClick={() => quickPromoteTask(item.id, 0)} className="paw-secondary-btn paw-inbox-control">
                          今天 · {segmentLabels[form.taskSegment]} · {taskEstimateLabel}
                        </button>
                        <button type="button" disabled={pendingId === item.id} onClick={() => quickPromoteTask(item.id, 1)} className="paw-secondary-btn paw-inbox-control">
                          明天 · {segmentLabels[form.taskSegment]} · {taskEstimateLabel}
                        </button>
                      </div>
                      <div className="paw-inbox-fields paw-inbox-task-fields">
                      <label className="min-w-0">
                        <span className="paw-field-label">任务日期</span>
                        <input
                          type="date"
                          value={form.taskDate}
                          onChange={(event) => updateField(item.id, { taskDate: event.target.value }, "taskDate")}
                          disabled={pendingId === item.id}
                          className="paw-input paw-inbox-input"
                          aria-invalid={Boolean(itemErrors.taskDate)}
                          aria-describedby={itemErrors.taskDate ? `${item.id}-task-date-error` : undefined}
                        />
                        {itemErrors.taskDate ? <span id={`${item.id}-task-date-error`} className="paw-field-error">{itemErrors.taskDate}</span> : null}
                      </label>
                      <label className="min-w-0">
                        <span className="paw-field-label">时段</span>
                        <select
                          value={form.taskSegment}
                          onChange={(event) => updateForm(item.id, { taskSegment: event.target.value as DaySegment })}
                          disabled={pendingId === item.id}
                          className="paw-input paw-inbox-input"
                        >
                          {Object.entries(segmentLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="min-w-0">
                        <span className="paw-field-label">估时（分钟）</span>
                        <input
                          type="number"
                          min={5}
                          max={480}
                          step={5}
                          value={form.taskEstimate}
                          onChange={(event) => updateField(item.id, { taskEstimate: event.target.value }, "taskEstimate")}
                          disabled={pendingId === item.id}
                          className="paw-input paw-inbox-input"
                          aria-invalid={Boolean(itemErrors.taskEstimate)}
                          aria-describedby={itemErrors.taskEstimate ? `${item.id}-task-estimate-error` : undefined}
                        />
                        {itemErrors.taskEstimate ? <span id={`${item.id}-task-estimate-error`} className="paw-field-error">{itemErrors.taskEstimate}</span> : null}
                      </label>
                      <label className="min-w-0">
                        <span className="paw-field-label">优先级</span>
                        <select
                          value={form.taskPriority}
                          onChange={(event) => updateForm(item.id, { taskPriority: event.target.value as TaskPriority })}
                          disabled={pendingId === item.id}
                          className="paw-input paw-inbox-input"
                        >
                          {Object.entries(priorityLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={pendingId === item.id}
                        onClick={() => promoteTask(item.id)}
                        className="paw-secondary-btn paw-inbox-control paw-inbox-submit"
                      >
                        <ArrowUpRight size={13} />
                        提升任务
                      </button>
                      </div>
                    </div>
                    ) : null}

                    {destination === "routine" ? (
                    <div className="paw-inbox-form paw-inbox-routine-form">
                      <fieldset className="paw-inbox-repeat" aria-invalid={Boolean(itemErrors.routinePattern)} aria-describedby={itemErrors.routinePattern ? `${item.id}-routine-pattern-error` : undefined}>
                        <legend className="paw-field-label">重复规则</legend>
                        <div className="paw-inbox-repeat-options">
                          <button type="button" disabled={pendingId === item.id} aria-pressed={form.routinePattern === "daily"} onClick={() => setRoutineDaily(item.id)} className="paw-secondary-btn paw-inbox-control">
                            每天
                          </button>
                          {weekdayOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              disabled={pendingId === item.id}
                              aria-label={`星期${option.label}`}
                              aria-pressed={chosenWeekdays.includes(option.value)}
                              onClick={() => toggleRoutineWeekday(item.id, option.value)}
                              className="paw-secondary-btn paw-inbox-weekday"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        {itemErrors.routinePattern ? <span id={`${item.id}-routine-pattern-error`} className="paw-field-error">{itemErrors.routinePattern}</span> : null}
                      </fieldset>
                      <div className="paw-inbox-fields paw-inbox-routine-fields">
                      <label className="min-w-0">
                        <span className="paw-field-label">默认时段</span>
                        <select
                          value={form.routineSegment}
                          onChange={(event) => updateForm(item.id, { routineSegment: event.target.value as RoutineTimeSegment })}
                          disabled={pendingId === item.id}
                          className="paw-input paw-inbox-input"
                        >
                          {Object.entries(routineSegmentLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="min-w-0">
                        <span className="paw-field-label">估时（分钟）</span>
                        <input
                          type="number"
                          min={5}
                          max={480}
                          step={5}
                          value={form.routineEstimate}
                          onChange={(event) => updateField(item.id, { routineEstimate: event.target.value }, "routineEstimate")}
                          disabled={pendingId === item.id}
                          className="paw-input paw-inbox-input"
                          aria-invalid={Boolean(itemErrors.routineEstimate)}
                          aria-describedby={itemErrors.routineEstimate ? `${item.id}-routine-estimate-error` : undefined}
                        />
                        {itemErrors.routineEstimate ? <span id={`${item.id}-routine-estimate-error`} className="paw-field-error">{itemErrors.routineEstimate}</span> : null}
                      </label>
                      <button
                        type="button"
                        disabled={pendingId === item.id}
                        onClick={() => promoteRoutine(item.id)}
                        className="paw-secondary-btn paw-inbox-control paw-inbox-submit"
                      >
                        <RefreshCcw size={13} />
                        转日常
                      </button>
                      </div>
                    </div>
                    ) : null}

                  </div>
                ) : null}
              </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
