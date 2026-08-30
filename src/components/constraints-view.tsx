"use client";

import { AlertTriangle, CalendarDays, Clock3, MapPin, Save, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { PlanSectionNav } from "./plan-section-nav";
import {
  TimeBlockTimetable,
  type TimetableOccurrenceView,
  type TimetableWeekView,
} from "./time-block-timetable";
import { redactPrivateTitle } from "@/lib/display/privacy";
import editorStyles from "./schedule-editor.module.css";

type EditableKind = "course" | "exam" | "meeting" | "unavailable" | "routine" | "recovery";
type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

type Course = { id: string; name: string; color?: string };

type TimeBlock = {
  id: string;
  title: string;
  kind: EditableKind;
  startsAt: string;
  endsAt: string;
  recurrenceRule: string | null;
  recurrenceWeekdayMask: number | null;
  courseId: string | null;
  courseName: string | null;
  location?: string | null;
  movable: false;
};

type ConstraintsResponse = {
  courses: Course[];
  timeBlocks: TimeBlock[];
  summary?: { courseCount: number; timeBlockCount: number; conflictCount: number; nextStartsAt: string | null };
  conflicts?: Array<{
    id: string;
    firstTitle: string;
    secondTitle: string;
    startsAt: string;
    endsAt: string;
    firstLocation: string | null;
    secondLocation: string | null;
  }>;
};

type UpsertConstraintResponse = { timeBlock?: TimeBlock; course?: Course | null; error?: string };

type TimeBlockForm = {
  id: string | null;
  kind: EditableKind;
  title: string;
  date: string;
  start: string;
  end: string;
  courseName: string;
  location: string;
  recurrenceRule: string;
};

const kindLabels: Record<EditableKind, string> = {
  course: "课程",
  exam: "考试",
  meeting: "会议",
  routine: "个人安排",
  unavailable: "不可用",
  recovery: "休息",
};

const weekdayOrder: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayLookup: Record<string, WeekdayKey> = {
  mon: "mon", tue: "tue", wed: "wed", thu: "thu", fri: "fri", sat: "sat", sun: "sun",
};

function shanghaiDateTime(date: string, time: string) {
  return `${date}T${time}:00.000+08:00`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function weekdayKey(value: string): WeekdayKey {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(new Date(value)).toLowerCase();
  return weekdayLookup[weekday] ?? "mon";
}

function weekdaysForBlock(block: TimeBlock): WeekdayKey[] {
  const mask = block.recurrenceWeekdayMask ?? 0;
  if (mask > 0) {
    const bitOrder = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    return weekdayOrder.filter((day) => (mask & (1 << bitOrder.indexOf(day))) !== 0);
  }
  return [weekdayKey(block.startsAt)];
}

function sortedBlocks(blocks: TimeBlock[]) {
  return [...blocks].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

type ConstraintGroup = {
  key: string;
  title: string;
  kind: EditableKind;
  courseName: string | null;
  location: string | null;
  recurrenceRule: string | null;
  startTime: string;
  endTime: string;
  firstDate: string;
  lastDate: string;
  weekdays: WeekdayKey[];
  blocks: TimeBlock[];
};

type ConstraintTimelineRow = {
  key: string;
  title: string;
  kind: EditableKind;
  courseName: string | null;
  startTime: string;
  endTime: string;
  instanceCount: number;
};

export function buildConstraintGroups(blocks: TimeBlock[]): ConstraintGroup[] {
  const groups = new Map<string, ConstraintGroup>();
  for (const block of sortedBlocks(blocks)) {
    const startTime = formatTime(block.startsAt);
    const endTime = formatTime(block.endsAt);
    const key = [
      block.kind,
      block.title.trim().toLowerCase(),
      block.courseName?.trim().toLowerCase() ?? "",
      block.location?.trim().toLowerCase() ?? "",
      block.recurrenceRule?.trim().toLowerCase() ?? "",
      startTime,
      endTime,
    ].join("|");
    const days = weekdaysForBlock(block);
    const existing = groups.get(key);
    if (existing) {
      existing.blocks.push(block);
      existing.lastDate = block.startsAt;
      for (const day of days) if (!existing.weekdays.includes(day)) existing.weekdays.push(day);
      existing.weekdays.sort((a, b) => weekdayOrder.indexOf(a) - weekdayOrder.indexOf(b));
      continue;
    }
    groups.set(key, {
      key,
      title: block.title,
      kind: block.kind,
      courseName: block.courseName,
      location: block.location ?? null,
      recurrenceRule: block.recurrenceRule,
      startTime,
      endTime,
      firstDate: block.startsAt,
      lastDate: block.startsAt,
      weekdays: days,
      blocks: [block],
    });
  }
  return [...groups.values()].sort((a, b) => (
    a.startTime.localeCompare(b.startTime) ||
    a.title.localeCompare(b.title) ||
    weekdayOrder.indexOf(a.weekdays[0]) - weekdayOrder.indexOf(b.weekdays[0])
  ));
}

export function buildConstraintTimelineRows(groups: ConstraintGroup[], day: WeekdayKey): ConstraintTimelineRow[] {
  return groups
    .filter((group) => group.weekdays.includes(day))
    .map((group) => ({
      key: group.key,
      title: group.title,
      kind: group.kind,
      courseName: group.courseName,
      startTime: group.startTime,
      endTime: group.endTime,
      instanceCount: group.blocks.filter((block) => weekdaysForBlock(block).includes(day)).length,
    }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title));
}

function timeInput(minute: number) {
  const safeMinute = Math.max(0, Math.min(minute, 23 * 60 + 59));
  return `${String(Math.floor(safeMinute / 60)).padStart(2, "0")}:${String(safeMinute % 60).padStart(2, "0")}`;
}

function emptyForm(date: string, startMinute = 9 * 60): TimeBlockForm {
  const snappedStart = Math.max(0, Math.min(Math.round(startMinute / 30) * 30, 23 * 60));
  return {
    id: null,
    kind: "course",
    title: "",
    date,
    start: timeInput(snappedStart),
    end: timeInput(Math.min(snappedStart + 60, 23 * 60 + 59)),
    courseName: "",
    location: "",
    recurrenceRule: "",
  };
}

function shanghaiInputParts(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

export function ConstraintsView({ timetable }: { timetable: TimetableWeekView }) {
  const router = useRouter();
  const [timeBlocks, setTimeBlocks] = useState<TimeBlock[]>([]);
  const [conflicts, setConflicts] = useState<NonNullable<ConstraintsResponse["conflicts"]>>([]);
  const [form, setForm] = useState<TimeBlockForm>(() => emptyForm(timetable.selectedDateKey));
  const [editorOpen, setEditorOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [dataUnavailable, setDataUnavailable] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const loadConstraints = useCallback(async () => {
    try {
      const response = await fetch("/api/constraints");
      if (!response.ok) {
        setDataUnavailable(true);
        setMessage("日程读取失败。");
        return;
      }
      const data = (await response.json()) as ConstraintsResponse;
      setTimeBlocks(data.timeBlocks ?? []);
      setConflicts(data.conflicts ?? []);
      setDataUnavailable(false);
    } catch {
      setDataUnavailable(true);
      setMessage("日程读取失败。");
    }
  }, []);

  useEffect(() => { void loadConstraints(); }, [loadConstraints]);

  useEffect(() => {
    if (!editorOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => titleInputRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setEditorOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [editorOpen, pending]);

  function openCreate(date = timetable.selectedDateKey, startMinute = 9 * 60) {
    setForm(emptyForm(date, startMinute));
    setEditorMessage(null);
    setDeleteArmed(false);
    setEditorOpen(true);
  }

  function openEdit(item: TimetableOccurrenceView) {
    const block = timeBlocks.find((candidate) => candidate.id === item.seriesId || candidate.id === item.id);
    if (!block) {
      setMessage("这条日程暂时无法直接编辑，请刷新后再试。");
      return false;
    }
    if (block.recurrenceRule || block.recurrenceWeekdayMask) {
      setMessage("循环日程需要先选择修改范围，当前先保留为只读，避免误改整个系列。");
      return false;
    }
    const start = shanghaiInputParts(block.startsAt);
    const end = shanghaiInputParts(block.endsAt);
    setForm({
      id: block.id,
      kind: block.kind,
      title: block.title,
      date: start.date,
      start: start.time,
      end: end.time,
      courseName: block.courseName ?? "",
      location: block.location ?? "",
      recurrenceRule: block.recurrenceRule ?? "",
    });
    setEditorMessage(null);
    setDeleteArmed(false);
    setEditorOpen(true);
    return true;
  }

  async function saveTimeBlock(event: FormEvent) {
    event.preventDefault();
    const title = form.title.trim();
    if (!title) {
      setEditorMessage("请填写日程标题。");
      return;
    }
    const startsAt = shanghaiDateTime(form.date, form.start);
    const endsAt = shanghaiDateTime(form.date, form.end);
    if (new Date(endsAt) <= new Date(startsAt)) {
      setEditorMessage("结束时间必须晚于开始时间。");
      return;
    }

    setPending("save");
    setEditorMessage(null);
    try {
      const response = await fetch("/api/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_time_block",
          timeBlock: {
            id: form.id ?? undefined,
            title,
            kind: form.kind,
            startsAt,
            endsAt,
            courseName: form.kind === "course" ? (form.courseName.trim() || title) : null,
            location: form.location.trim() || null,
            recurrenceRule: form.recurrenceRule.trim() || null,
          },
        }),
      });
      const data = (await response.json()) as UpsertConstraintResponse;
      if (!response.ok || !data.timeBlock) {
        setEditorMessage(data.error ?? "日程保存失败。");
        return;
      }
      setEditorOpen(false);
      setMessage(form.id ? "日程已更新。" : "日程已创建。");
      await loadConstraints();
      router.refresh();
    } catch {
      setEditorMessage("日程保存失败，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  async function deleteTimeBlock() {
    if (!form.id || !deleteArmed) return;
    setPending("delete");
    setEditorMessage(null);
    try {
      const response = await fetch("/api/constraints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_time_block", id: form.id }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setEditorMessage(data?.error ?? "日程删除失败。");
        return;
      }
      setEditorOpen(false);
      setDeleteArmed(false);
      setMessage("日程已删除。");
      await loadConstraints();
      router.refresh();
    } catch {
      setEditorMessage("日程删除失败，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="paw-page">
      <PlanSectionNav />
      {message ? <p className={dataUnavailable ? "paw-schedule-feedback error" : "paw-schedule-feedback"} role="status">{message}</p> : null}
      <TimeBlockTimetable week={timetable} onCreate={openCreate} onEdit={openEdit} />

      {conflicts.length > 0 ? (
        <section className="paw-list-card mt-4">
          <div className="paw-list-header">
            <div>
              <h2 className="paw-list-title paw-conflict-title"><AlertTriangle size={18} />时间冲突</h2>
              <p className="paw-list-subtitle">重叠只会提示，不会自动移动任何日程。</p>
            </div>
          </div>
          <div className="paw-list mt-4">
            {conflicts.map((conflict) => (
              <div key={conflict.id} className="paw-list-row">
                <div className="min-w-0">
                  <p className="paw-row-title">{redactPrivateTitle(conflict.firstTitle)} 与 {redactPrivateTitle(conflict.secondTitle)} 时间冲突</p>
                  <p className="paw-row-meta">{formatDateTime(conflict.startsAt)}–{formatDateTime(conflict.endsAt)}</p>
                  <p className="paw-row-meta">地点：{conflict.firstLocation ?? "待确认"} / {conflict.secondLocation ?? "待确认"}</p>
                </div>
                <span className="paw-status-pill warn">冲突</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {editorOpen ? createPortal((
        <div className={editorStyles.backdrop} onMouseDown={(event) => event.target === event.currentTarget && !pending && setEditorOpen(false)}>
          <section className={editorStyles.panel} role="dialog" aria-modal="true" aria-labelledby="schedule-editor-title">
            <header className={editorStyles.header}>
              <div>
                <p className={editorStyles.eyebrow}>{form.id ? "编辑日程" : "新建日程"}</p>
                <h2 id="schedule-editor-title">{form.id ? redactPrivateTitle(form.title) : "安排一段确定时间"}</h2>
              </div>
              <button type="button" className={editorStyles.close} onClick={() => setEditorOpen(false)} disabled={Boolean(pending)} aria-label="关闭日程编辑器">
                <X size={20} />
              </button>
            </header>

            <form className={editorStyles.form} onSubmit={saveTimeBlock}>
              <fieldset className={editorStyles.kindFieldset}>
                <legend>类型</legend>
                <div className={editorStyles.kindGrid}>
                  {(Object.keys(kindLabels) as EditableKind[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={form.kind === kind ? editorStyles.kindActive : editorStyles.kindButton}
                      onClick={() => setForm((current) => ({ ...current, kind }))}
                      aria-pressed={form.kind === kind}
                    >
                      {kindLabels[kind]}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className={editorStyles.field}>
                <span>{form.kind === "course" ? "课程名称" : "标题"}</span>
                <input
                  ref={titleInputRef}
                  value={form.title}
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  maxLength={180}
                  placeholder={form.kind === "course" ? "例如：MATH 3700" : form.kind === "exam" ? "例如：期中考试" : "这段时间要做什么"}
                />
              </label>

              <div className={editorStyles.dateTimeGrid}>
                <label className={editorStyles.field}>
                  <span><CalendarDays size={15} />日期</span>
                  <input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} />
                </label>
                <label className={editorStyles.field}>
                  <span><Clock3 size={15} />开始</span>
                  <input type="time" value={form.start} onChange={(event) => setForm((current) => ({ ...current, start: event.target.value }))} />
                </label>
                <label className={editorStyles.field}>
                  <span><Clock3 size={15} />结束</span>
                  <input type="time" value={form.end} onChange={(event) => setForm((current) => ({ ...current, end: event.target.value }))} />
                </label>
              </div>

              <label className={editorStyles.field}>
                <span><MapPin size={15} />地点（可选）</span>
                <input
                  value={form.location}
                  onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))}
                  maxLength={240}
                  placeholder="教室、会议室或线上链接"
                />
              </label>

              {!form.id ? (
                <details className={editorStyles.moreOptions}>
                  <summary>重复设置</summary>
                  <label className={editorStyles.field}>
                    <span>重复规则</span>
                    <input
                      value={form.recurrenceRule}
                      onChange={(event) => setForm((current) => ({ ...current, recurrenceRule: event.target.value }))}
                      placeholder="例如：工作日、周一 / 周三"
                    />
                  </label>
                  <p>保存循环日程后，修改整个系列仍会经过范围确认。</p>
                </details>
              ) : null}

              {editorMessage ? <p className={editorStyles.error} role="alert">{editorMessage}</p> : null}

              {deleteArmed ? (
                <p className={editorStyles.deleteConfirmation} role="status">
                  将永久删除“{redactPrivateTitle(form.title)}”。再次点击红色按钮确认；其他日程不会改变。
                </p>
              ) : null}

              <footer className={editorStyles.footer}>
                {form.id ? (
                  <button
                    type="button"
                    className={deleteArmed ? editorStyles.deleteButtonConfirm : editorStyles.deleteButton}
                    onClick={() => deleteArmed ? void deleteTimeBlock() : setDeleteArmed(true)}
                    disabled={Boolean(pending)}
                  >
                    <Trash2 size={16} />
                    {pending === "delete" ? "删除中" : deleteArmed ? "确认永久删除" : "删除"}
                  </button>
                ) : <span />}
                <div>
                  <button type="button" className={editorStyles.cancelButton} onClick={() => setEditorOpen(false)} disabled={Boolean(pending)}>取消</button>
                  <button type="submit" className={editorStyles.saveButton} disabled={Boolean(pending)}>
                    <Save size={16} />{pending === "save" ? "保存中" : "保存日程"}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      ), document.body) : null}
    </div>
  );
}
