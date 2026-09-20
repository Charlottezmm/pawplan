"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, LockKeyhole } from "lucide-react";
import { DialogSheet } from "./ui/dialog-sheet";
import { TodayFixedTimeline } from "./today-fixed-timeline";
import { addDaysToDateKey, shanghaiDateKey } from "@/lib/planning/task-actions";
import {
  localClock,
  clockMinute,
  segmentFor,
  timingLabel,
  type TimingRequest,
  type TimingTask,
  type TimingBlock,
  type TimingPreview,
} from "@/lib/planning/task-timing";
import type { TimelineItemView } from "@/lib/planning/view-data";
import {
  selectedTimingTaskIds,
  timingMinutes,
  timingRequestKey,
} from "@/lib/client/task-timing-form";
import styles from "./task-timing-controls.module.css";

type TimingData = { tasks: TimingTask[]; fixed: TimingBlock[]; date: string };
async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "操作失败，请重试。");
  return data;
}
const send = (url: string, method: string, body: unknown) =>
  jsonRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const changedEvent = "pawplan:timing-changed";
function defaultStart() {
  const min =
    Math.ceil((clockMinute(localClock(new Date().toISOString())) + 5) / 5) * 5;
  return `${String(Math.min(23, Math.floor(min / 60))).padStart(2, "0")}:${String(min >= 1440 ? 55 : min % 60).padStart(2, "0")}`;
}
function weekRange(next: boolean) {
  const today = shanghaiDateKey();
  const weekday = new Date(`${today}T12:00:00+08:00`).getUTCDay();
  const monday = addDaysToDateKey(today, -((weekday + 6) % 7));
  return next
    ? [addDaysToDateKey(monday, 7), addDaysToDateKey(monday, 13)]
    : [today, addDaysToDateKey(monday, 6)];
}
export function TimingChanges({
  preview,
}: {
  preview: Pick<TimingPreview, "changes" | "warnings">;
}) {
  return (
    <div className={styles.preview}>
      {preview.changes.map((c) => (
        <article key={c.taskId}>
          <strong>{c.title}</strong>
          <p className={styles.before}>{timingLabel(c.before)}</p>
          <p>→ {timingLabel(c.after)}</p>
          {c.before.deadlineAt !== c.after.deadlineAt ? (
            <p>
              正式截止：
              {c.after.deadlineAt
                ? `${shanghaiDateKey(new Date(c.after.deadlineAt))} ${localClock(c.after.deadlineAt)}`
                : "未设置"}
            </p>
          ) : null}
          {c.before.targetDate !== c.after.targetDate ? (
            <p>希望完成：{c.after.targetDate ?? "未设置"}</p>
          ) : null}
          {c.before.checkpoint !== c.after.checkpoint ? (
            <p>进展／剩余：{c.after.checkpoint || "已清空"}</p>
          ) : null}
        </article>
      ))}
      {preview.warnings.map((s, i) => (
        <p className={styles.warning} key={i}>
          {s}
        </p>
      ))}
    </div>
  );
}
export function TaskTimingDialog({
  taskId,
  open,
  onClose,
  day,
}: {
  taskId?: string;
  open: boolean;
  onClose: () => void;
  day?: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<TimingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<
    (Omit<TimingPreview, "approvalId"> & { approvalId: string | null }) | null
  >(null);
  const [mode, setMode] = useState<
    "schedule" | "defer" | "extend" | "pause" | "complete"
  >("schedule");
  const [date, setDate] = useState(day ?? shanghaiDateKey());
  const [dateTo, setDateTo] = useState(date);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState("22:00");
  const [minutes, setMinutes] = useState("30");
  const [extension, setExtension] = useState("20");
  const [locked, setLocked] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [target, setTarget] = useState("");
  const [checkpoint, setCheckpoint] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const requestRef = useRef<{ json: string; key: string } | null>(null);
  const approvalRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const [success, setSuccess] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setData(null);
    setError(null);
    setPreview(null);
    setSuccess(null);
    approvalRef.current = null;
    requestRef.current = null;
    jsonRequest(`/api/task-timing?from=${day ?? shanghaiDateKey()}`)
      .then((d: TimingData) => {
        if (!active) return;
        setData(d);
        const task = d.tasks.find((t) => t.id === taskId);
        const dayKey = day ?? shanghaiDateKey();
        setDate(
          task && task.status !== "backlog" && task.date >= dayKey
            ? task.date
            : dayKey,
        );
        setDateTo(dayKey);
        setStart(
          task?.scheduledStart
            ? localClock(task.scheduledStart)
            : dayKey === shanghaiDateKey()
              ? defaultStart()
              : "08:00",
        );
        setEnd("22:00");
        setMode(task?.status === "backlog" ? "defer" : "schedule");
        setMinutes(
          String(
            task?.scheduledStart && task.scheduledEnd
              ? (Date.parse(task.scheduledEnd) -
                  Date.parse(task.scheduledStart)) /
                  60000
              : (task?.estimatedMinutes ?? 30),
          ),
        );
        setLocked(task ? !task.movable : false);
        setTarget(task?.targetDate ?? "");
        setCheckpoint(task?.checkpoint ?? "");
        setDeadline(
          task?.deadlineAt
            ? `${shanghaiDateKey(new Date(task.deadlineAt))}T${localClock(task.deadlineAt)}`
            : "",
        );
        setSelected(
          d.tasks
            .filter(
              (t) =>
                t.date === dayKey &&
                t.status === "todo" &&
                t.movable &&
                !t.scheduledStart,
            )
            .map((t) => t.id),
        );
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [open, taskId, day]);
  const task = data?.tasks.find((t) => t.id === taskId);
  async function propose() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      let request: TimingRequest;
      if (!taskId)
        request = {
          action: "arrange",
          date,
          dateTo: date,
          startTime: start,
          endTime: end,
          gapMinutes: 10,
          taskIds: selectedTimingTaskIds(data?.tasks ?? [], date, selected),
        };
      else if (mode === "schedule")
        request = {
          action: "schedule",
          edits: [
            {
              taskId,
              date,
              startTime: start,
              minutes: timingMinutes(minutes, 480),
              locked,
              deadlineAt: deadline
                ? new Date(`${deadline}:00+08:00`).toISOString()
                : null,
              targetDate: target || null,
              checkpoint,
            },
          ],
        };
      else if (mode === "defer")
        request = {
          action: "defer",
          taskId,
          date,
          dateTo: dateTo < date ? date : dateTo,
          startTime: start,
          endTime: end,
          gapMinutes: 10,
          minutes: timingMinutes(minutes, 480),
          checkpoint:
            checkpoint.trim() ||
            (task?.status === "backlog" ? "从现有任务内容开始。" : ""),
        };
      else if (mode === "extend")
        request = {
          action: "extend",
          taskId,
          minutes: timingMinutes(extension, 120),
          endTime: end,
        };
      else if (mode === "pause")
        request = { action: "pause", taskId, checkpoint };
      else request = { action: "complete", taskId, checkpoint };
      const json = JSON.stringify(request);
      if (requestRef.current?.json !== json)
        requestRef.current = { json, key: timingRequestKey() };
      setPreview(
        await send("/api/task-timing", "POST", {
          request,
          idempotencyKey: requestRef.current.key,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法生成预览");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview?.approvalId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (approvalRef.current !== preview.approvalId) {
        await send("/api/operation-approvals", "POST", {
          approvalId: preview.approvalId,
          decision: "approved",
        });
        approvalRef.current = preview.approvalId;
      }
      const result = await send("/api/task-timing", "PATCH", {
        approvalId: preview.approvalId,
      });
      if (!result.verified || result.status !== "applied")
        throw new Error("保存结果未确认，请刷新核对。");
      setSuccess("已保存，任务时间和进展已核对。");
      setPreview(null);
      window.dispatchEvent(new Event(changedEvent));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function dismiss(returnToEditor: boolean) {
    if (busyRef.current) return;
    // An approved Apply retry belongs in Review; never reject or replace it.
    if (returnToEditor && approvalRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (preview?.approvalId && !approvalRef.current) {
        await send("/api/operation-approvals", "POST", {
          approvalId: preview.approvalId,
          decision: "rejected",
        });
      }
      setPreview(null);
      requestRef.current = null;
      if (returnToEditor) {
        approvalRef.current = null;
      } else {
        onClose();
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法撤回预览，请重试。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const close = () => void dismiss(false);
  const options =
    data?.tasks.filter(
      (t) => t.date === date && t.status === "todo" && t.movable,
    ) ?? [];
  return (
    <DialogSheet
      open={open}
      onClose={close}
      closeDisabled={busy}
      title={task?.title ?? "安排今天的时间"}
      description="先预览，再确认保存。时间均为北京时间。"
    >
      <div className={styles.editor}>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        {success ? (
          <>
            <p role="status">{success}</p>
            <button type="button" className="paw-primary-btn" onClick={close}>
              完成
            </button>
          </>
        ) : preview ? (
          <>
            <h3>确认这次调整</h3>
            <TimingChanges preview={preview} />
            <div className={styles.actions}>
              <button
                type="button"
                className="paw-secondary-btn"
                onClick={() => void dismiss(true)}
                disabled={busy || Boolean(approvalRef.current)}
              >
                返回修改
              </button>
              {preview.approvalId ? (
                <button
                  type="button"
                  className="paw-primary-btn"
                  onClick={() => void apply()}
                  disabled={busy}
                >
                  {busy ? "保存中…" : "确认并应用"}
                </button>
              ) : null}
            </div>
          </>
        ) : data ? (
          <>
            {taskId && !task ? (
              <p>任务已不在当前计划，请刷新页面。</p>
            ) : (
              <>
                {task ? (
                  <>
                    <p className={styles.hint}>{timingLabel(task)}</p>
                    <div
                      className={styles.modes}
                      role="group"
                      aria-label="操作"
                    >
                      {(
                        [
                          ["schedule", "设置时段"],
                          [
                            "defer",
                            task.status === "backlog" ? "安排时间" : "后续再做",
                          ],
                          ["extend", "继续一段"],
                          ["pause", "先收尾"],
                          ["complete", "完成任务"],
                        ] as const
                      )
                        .filter(
                          ([m]) =>
                            task.status !== "backlog" ||
                            m === "schedule" ||
                            m === "defer",
                        )
                        .map(([m, label]) => (
                          <button
                            type="button"
                            key={m}
                            aria-pressed={mode === m}
                            disabled={busy}
                            onClick={() => setMode(m)}
                          >
                            {label}
                          </button>
                        ))}
                    </div>
                  </>
                ) : (
                  <div className={styles.selection}>
                    <p>选择要安排的任务，保留其上午／下午／晚上偏好：</p>
                    {options.map((t) => (
                      <label key={t.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(t.id)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked
                                ? [...s, t.id]
                                : s.filter((id) => id !== t.id),
                            )
                          }
                        />
                        {t.title} · {t.estimatedMinutes} 分钟
                      </label>
                    ))}
                    {!options.length ? (
                      <p>这一天没有可安排的待办任务。</p>
                    ) : null}
                  </div>
                )}
                {mode === "schedule" || mode === "defer" || !taskId ? (
                  <>
                    {task?.status === "backlog" || mode === "defer" ? (
                      <div className={styles.actions}>
                        {[false, true].map((next) => (
                          <button
                            type="button"
                            className="paw-secondary-btn"
                            key={String(next)}
                            onClick={() => {
                              const [a, b] = weekRange(next);
                              setDate(a);
                              setDateTo(b);
                              setStart("08:00");
                            }}
                          >
                            {next ? "下周安排" : "这周安排"}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className={styles.fields}>
                      <label>
                        日期
                        <input
                          type="date"
                          value={date}
                          min={shanghaiDateKey()}
                          onChange={(e) => {
                            setDate(e.target.value);
                            if (!taskId) setSelected([]);
                          }}
                        />
                      </label>
                      {mode === "defer" ? (
                        <label>
                          最晚搜索到
                          <input
                            type="date"
                            value={dateTo < date ? date : dateTo}
                            min={date}
                            onChange={(e) => setDateTo(e.target.value)}
                          />
                        </label>
                      ) : null}
                      <label>
                        {mode === "defer" || !taskId
                          ? "从几点开始"
                          : "开始时间"}
                        <input
                          type="time"
                          value={start}
                          onChange={(e) => setStart(e.target.value)}
                        />
                      </label>
                      {mode === "defer" || !taskId ? (
                        <label>
                          当天结束时间
                          <input
                            type="time"
                            value={end}
                            onChange={(e) => setEnd(e.target.value)}
                          />
                        </label>
                      ) : null}
                      {task ? (
                        <label>
                          本次安排（分钟）
                          <input
                            type="number"
                            min={5}
                            max={480}
                            value={minutes}
                            onChange={(e) => setMinutes(e.target.value)}
                          />
                        </label>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {task && mode === "schedule" ? (
                  <>
                    <label className={styles.lock}>
                      <input
                        type="checkbox"
                        checked={locked}
                        onChange={(e) => setLocked(e.target.checked)}
                      />
                      <LockKeyhole size={15} />
                      保护这个时段，调整时保留
                    </label>
                    <div className={styles.fields}>
                      <label>
                        正式截止时间（可选）
                        <input
                          type="datetime-local"
                          value={deadline}
                          onChange={(e) => setDeadline(e.target.value)}
                        />
                      </label>
                      <label>
                        希望完成日期（可选）
                        <input
                          type="date"
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                        />
                      </label>
                    </div>
                  </>
                ) : null}
                {task && mode === "extend" ? (
                  <>
                    <p className={styles.hint}>
                      预览当前任务延长后，后面的任务如何调整。固定和受保护安排保持原位。
                    </p>
                    <div className={styles.fields}>
                      <label>
                        继续多少分钟
                        <input
                          type="number"
                          min={5}
                          max={120}
                          value={extension}
                          onChange={(e) => setExtension(e.target.value)}
                        />
                      </label>
                      <label>
                        当天结束时间
                        <input
                          type="time"
                          value={end}
                          onChange={(e) => setEnd(e.target.value)}
                        />
                      </label>
                    </div>
                  </>
                ) : null}
                {task && mode !== "extend" ? (
                  <label>
                    {mode === "complete"
                      ? "完成记录（可选）"
                      : "做到哪里／剩下什么"}
                    <textarea
                      value={checkpoint}
                      maxLength={2000}
                      rows={3}
                      placeholder="例如：Note7 已读到第 4 页，下次从例题 2 开始。"
                      onChange={(e) => setCheckpoint(e.target.value)}
                    />
                  </label>
                ) : null}
                {mode === "pause" ? (
                  <p className={styles.hint}>
                    保存进展并释放本次时段，任务仍为待办；稍后可为剩余内容安排时间。
                  </p>
                ) : null}
                {mode === "complete" ? (
                  <p className={styles.hint}>
                    确认整个任务已完成。仅结束这段学习，请选择“先收尾”。
                  </p>
                ) : null}
                <button
                  type="button"
                  className="paw-primary-btn"
                  disabled={
                    busy ||
                    (!taskId &&
                      !selectedTimingTaskIds(data.tasks, date, selected).length)
                  }
                  onClick={() => void propose()}
                >
                  {busy ? "正在预览…" : "预览安排"}
                </button>
              </>
            )}
          </>
        ) : (
          <p role="status">正在读取当前安排…</p>
        )}
      </div>
    </DialogSheet>
  );
}
export function TaskTimingButton({
  taskId,
  label = "安排／收尾",
}: {
  taskId: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="paw-secondary-btn"
        onClick={() => setOpen(true)}
      >
        <CalendarClock size={14} />
        {label}
      </button>
      {open ? (
        <TaskTimingDialog
          taskId={taskId}
          open={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
export function TodayTaskTimeline({
  fixedItems,
  initialData,
}: {
  fixedItems: TimelineItemView[];
  initialData?: TimingData;
}) {
  const [data, setData] = useState<TimingData | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    if (initialData) setData(initialData);
  }, [initialData]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      jsonRequest(`/api/task-timing?from=${shanghaiDateKey()}`)
        .then((d: TimingData) => {
          if (active) {
            setData(d);
            setError(null);
          }
        })
        .catch((e) => active && setError(e.message));
    if (!initialData) void refresh();
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30000);
    const handler = () => void refresh();
    window.addEventListener(changedEvent, handler);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(changedEvent, handler);
    };
  }, [initialData]);
  const scheduled =
    data?.tasks.filter(
      (t) =>
        t.date === shanghaiDateKey() &&
        t.scheduledStart &&
        t.scheduledEnd &&
        t.status !== "backlog",
    ) ?? [];
  const taskItems: TimelineItemView[] = scheduled.map((t) => ({
    id: t.id,
    title: t.title,
    kind: "task",
    startsAt: t.scheduledStart!,
    endsAt: t.scheduledEnd!,
    minutes:
      (Date.parse(t.scheduledEnd!) - Date.parse(t.scheduledStart!)) / 60000,
    segment: t.daySegment,
    protected: !t.movable,
  }));
  const items = data
    ? [
        ...data.fixed.map((b) => ({
          ...b,
          kind:
            fixedItems.find((i) => i.id === b.id)?.kind ??
            ("unavailable" as const),
          minutes: (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60000,
          segment: segmentFor(clockMinute(localClock(b.startsAt))),
          protected: true,
        })),
        ...taskItems,
      ]
    : fixedItems;
  const pending = scheduled
    .filter((t) => t.status === "todo")
    .sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!));
  const current = now
    ? pending.find(
        (t) =>
          Date.parse(t.scheduledStart!) <= now.getTime() &&
          Date.parse(t.scheduledEnd!) > now.getTime(),
      )
    : undefined;
  const due = now
    ? pending.find((t) => Date.parse(t.scheduledEnd!) <= now.getTime())
    : undefined;
  const next = now
    ? pending.find((t) => Date.parse(t.scheduledStart!) > now.getTime())
    : undefined;
  const activate = (id?: string) => {
    setSelected(id);
    setOpen(true);
  };
  return (
    <>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {current ? (
        <button
          type="button"
          className={styles.focusCard}
          onClick={() => activate(current.id)}
        >
          <small>
            现在 · {localClock(current.scheduledStart!)}–
            {localClock(current.scheduledEnd!)}
          </small>
          <strong>{current.title}</strong>
          <span>查看／收尾 →</span>
        </button>
      ) : null}
      {due ? (
        <button
          type="button"
          className={styles.dueCard}
          onClick={() => activate(due.id)}
        >
          {due.title} 的时段已结束 · 记录进展
        </button>
      ) : null}
      {next ? (
        <p className={styles.next}>
          下一项 {localClock(next.scheduledStart!)} · {next.title}
        </p>
      ) : null}
      <TodayFixedTimeline
        items={items}
        includesTasks
        headerAction={<button type="button" className="paw-secondary-btn" onClick={() => activate()}><CalendarClock size={15} />安排任务时段</button>}
        onTaskSelect={activate}
        now={now}
        completedTaskIds={scheduled
          .filter((t) => t.status === "done")
          .map((t) => t.id)}
      />
      {open ? (
        <TaskTimingDialog
          taskId={selected}
          open={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
