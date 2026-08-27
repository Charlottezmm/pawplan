"use client";

import { CalendarDays, Pencil, Plus, Save, Table, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BackLink } from "./back-link";
import { CatIcon } from "./cat-icon";
import { PlanSectionNav } from "./plan-section-nav";
import { TimeBlockTimetable, type TimetableWeekView } from "./time-block-timetable";
import { redactPrivateTitle } from "@/lib/display/privacy";

type EditableKind = "course" | "meeting" | "unavailable" | "routine" | "recovery";
type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

type Course = {
  id: string;
  name: string;
  color?: string;
};

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
  workspaceId: string;
  courses: Course[];
  timeBlocks: TimeBlock[];
  summary?: {
    courseCount: number;
    timeBlockCount: number;
    conflictCount: number;
    nextStartsAt: string | null;
  };
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

type UpsertConstraintResponse = {
  timeBlock?: TimeBlock;
  course?: Course | null;
  error?: string;
};

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

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const emptyForm: TimeBlockForm = {
  id: null,
  kind: "course",
  title: "",
  date: todayInShanghai(),
  start: "09:00",
  end: "10:00",
  courseName: "",
  location: "",
  recurrenceRule: "",
};

const kindLabels: Record<EditableKind, string> = {
  course: "课程",
  meeting: "会议",
  unavailable: "不可用",
  routine: "日常事项",
  recovery: "恢复 / 休息",
};

const weekdayOrder: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayLabels: Record<WeekdayKey, string> = {
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
  sun: "周日",
};

const weekdayLookup: Record<string, WeekdayKey> = {
  mon: "mon",
  tue: "tue",
  wed: "wed",
  thu: "thu",
  fri: "fri",
  sat: "sat",
  sun: "sun",
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
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
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
  if (mask > 0) return weekdayOrder.filter((day) => (mask & (1 << ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(day))) !== 0);
  return [weekdayKey(block.startsAt)];
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
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
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

function weekdaySummary(days: WeekdayKey[]) {
  if (days.length === 7) return "每天";
  if (days.length === 6 && days.every((day) => day !== "sun")) return "周一到周六";
  if (days.length === 5 && days.every((day) => day !== "sat" && day !== "sun")) return "工作日";
  return days.map((day) => weekdayLabels[day]).join(" / ");
}

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
      for (const day of days) {
        if (!existing.weekdays.includes(day)) existing.weekdays.push(day);
      }
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

// routine 在数据上不分轨道，这里按标题关键词给个视觉细分；其它 kind 用自己的配色
function timeBarClass(row: { kind: EditableKind; title: string }) {
  if (row.kind !== "routine") return row.kind;
  const t = row.title;
  if (t.includes("学习") || t.includes("FlowGuard") || t.includes("论文") || t.includes("视频")) return "routine-study";
  if (t.includes("工作") || t.includes("硬件") || t.includes("SolidWorks")) return "routine-work";
  if (t.includes("家务") || t.includes("通勤")) return "routine-chore";
  if (t.includes("运动") || t.includes("健身") || t.includes("锻炼")) return "routine-sport";
  return "routine";
}

export function ConstraintsView({ timetable }: { timetable: TimetableWeekView }) {
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [timeBlocks, setTimeBlocks] = useState<TimeBlock[]>([]);
  const [summary, setSummary] = useState<ConstraintsResponse["summary"]>(undefined);
  const [conflicts, setConflicts] = useState<NonNullable<ConstraintsResponse["conflicts"]>>([]);
  const [form, setForm] = useState<TimeBlockForm>(emptyForm);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dataUnavailable, setDataUnavailable] = useState(false);

  const visibleBlocks = useMemo(() => sortedBlocks(timeBlocks), [timeBlocks]);
  const constraintGroups = useMemo(() => buildConstraintGroups(visibleBlocks), [visibleBlocks]);

  useEffect(() => {
    let active = true;

    async function loadConstraints() {
      try {
        const response = await fetch("/api/constraints");
        if (!response.ok) {
          if (active) {
            setDataUnavailable(true);
            setMessage("固定安排读取失败。");
          }
          return;
        }

        const data = (await response.json()) as ConstraintsResponse;
        if (!active) return;
        setWorkspaceId(data.workspaceId);
        setCourses(data.courses ?? []);
        setTimeBlocks(data.timeBlocks ?? []);
        setSummary(data.summary);
        setConflicts(data.conflicts ?? []);
        setDataUnavailable(false);
      } catch {
        if (!active) return;
        setDataUnavailable(true);
        setMessage("固定安排读取失败。");
      }
    }

    void loadConstraints();
    return () => {
      active = false;
    };
  }, []);

  async function saveTimeBlock(event: React.FormEvent) {
    event.preventDefault();
    if (!form.title.trim()) {
      setMessage("标题不能为空。");
      return;
    }
    if (form.kind === "course" && !form.courseName.trim()) {
      setMessage("课程约束需要课程名。");
      return;
    }

    setPending("save");
    const response = await fetch("/api/constraints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upsert_time_block",
        timeBlock: {
          id: form.id ?? undefined,
          title: form.title.trim(),
          kind: form.kind,
          startsAt: shanghaiDateTime(form.date, form.start),
          endsAt: shanghaiDateTime(form.date, form.end),
          courseName: form.kind === "course" ? form.courseName.trim() : null,
          location: form.location.trim() || null,
          recurrenceRule: form.recurrenceRule.trim() || null,
        },
      }),
    });
    const data = (await response.json()) as UpsertConstraintResponse;
    setPending(null);

    if (!response.ok || !data.timeBlock) {
      setMessage(data.error ?? "约束保存失败。");
      return;
    }
    const savedBlock = data.timeBlock;

    setTimeBlocks((current) => {
      const existing = current.some((block) => block.id === savedBlock.id);
      if (!existing) return [...current, savedBlock];
      return current.map((block) => (block.id === savedBlock.id ? savedBlock : block));
    });
    if (data.course) {
      setCourses((current) =>
        current.some((course) => course.id === data.course?.id)
          ? current
          : [...current, data.course as Course],
      );
    } else if (savedBlock.courseId && savedBlock.courseName) {
      const courseId = savedBlock.courseId;
      const courseName = savedBlock.courseName;
      setCourses((current) =>
        current.some((course) => course.id === courseId)
          ? current
          : [...current, { id: courseId, name: courseName }],
      );
    }
    setForm(emptyForm);
    setMessage("约束已保存。");
    router.refresh();
  }

  function editExistingTimeBlock(block: TimeBlock) {
    if (block.recurrenceRule || block.recurrenceWeekdayMask) {
      setMessage("循环安排不能直接覆盖；请先生成 Preview，选择“仅本次 / 本次及以后 / 整个系列”，再到 Review 批准。");
      return;
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
    setMessage("正在编辑现有约束。");
  }

  async function deleteExistingTimeBlock(block: TimeBlock) {
    if (block.recurrenceRule || block.recurrenceWeekdayMask) {
      setMessage("循环安排不能直接删除；请先生成 Preview，选择“仅本次 / 本次及以后 / 整个系列”，再到 Review 批准。");
      return;
    }
    setPending(block.id);
    const response = await fetch("/api/constraints", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_time_block", id: block.id }),
    });
    setPending(null);

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setMessage(data?.error ?? "约束删除失败。");
      return;
    }

    setTimeBlocks((current) => current.filter((item) => item.id !== block.id));
    setMessage("约束已删除。");
    router.refresh();
  }

  return (
    <div className="paw-page">
      <PlanSectionNav />
      <section className="paw-page-header">
        <BackLink href="/plan" label="计划" />
        <h1 className="paw-page-date">固定安排</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">课程、日常事项、恢复和不可用时间都放在这一处；先看一天时间线，再看周循环摘要。</p>
        </div>
        <div className="paw-status-pills">
          <span className="paw-status-pill">{workspaceId ? `Workspace: ${workspaceId}` : "Workspace 读取中"}</span>
          <span className="paw-status-pill">课程: {summary?.courseCount ?? courses.length}</span>
          <span className="paw-status-pill">循环: {constraintGroups.length}</span>
          <span className="paw-status-pill">实例: {summary?.timeBlockCount ?? timeBlocks.length}</span>
          <span className={conflicts.length > 0 ? "paw-status-pill warn" : "paw-status-pill"}>冲突: {summary?.conflictCount ?? conflicts.length}</span>
          {dataUnavailable ? <span className="paw-status-pill warn">数据源不可用</span> : null}
          {message ? <span className="paw-status-pill link">{message}</span> : null}
        </div>
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">固定课程与时间占用</h2>
            <p className="paw-list-subtitle">课表按真实分钟与时长绘制；空白只表示没有固定占用，不会自动塞入任务。</p>
          </div>
          <Link href="/import" className="paw-secondary-btn !px-4 !py-2 !text-sm" aria-label="导入 timetable.csv">
            <Table size={15} />
            导入 timetable.csv
          </Link>
        </div>

        <div className="mt-4">
          <TimeBlockTimetable week={timetable} />
        </div>

        <div className="paw-mcp-grid mt-4">
          <div className="paw-mcp-info">
            <p className="paw-field-label">下一个固定块</p>
            <p className="paw-mcp-value">{summary?.nextStartsAt ? formatDateTime(summary.nextStartsAt) : "暂无"}</p>
          </div>
          <div className="paw-mcp-info">
            <p className="paw-field-label">冲突检查</p>
            <p className="paw-mcp-value">{conflicts.length > 0 ? `${conflicts.length} 个冲突需处理` : "未发现冲突"}</p>
          </div>
        </div>
        {conflicts.length > 0 ? (
          <div className="paw-list mt-4">
            {conflicts.map((conflict) => (
              <div key={conflict.id} className="paw-list-row">
                <div className="min-w-0">
                  <p className="paw-row-title">{redactPrivateTitle(conflict.firstTitle)} 与 {redactPrivateTitle(conflict.secondTitle)} 时间冲突</p>
                  <p className="paw-row-meta">{formatDateTime(conflict.startsAt)} - {formatDateTime(conflict.endsAt)}</p>
                  {(conflict.firstLocation || conflict.secondLocation) ? (
                    <p className="paw-row-meta">地点：{conflict.firstLocation ?? "待确认"} / {conflict.secondLocation ?? "待确认"}</p>
                  ) : null}
                </div>
                <span className="paw-status-pill warn">conflict</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">{form.id ? "编辑固定安排" : "新增固定安排"}</h2>
            <p className="paw-list-subtitle">课程、日常事项、恢复和不可用时间都可以从这里新增。</p>
          </div>
          <span className="paw-more-icon">
            <CalendarDays size={18} />
          </span>
        </div>

        <form onSubmit={saveTimeBlock} className="paw-constraint-form border-t border-[var(--app-line)] pt-4">
          <div className="paw-constraint-form-grid first">
            <label>
              <span className="paw-field-label">类型</span>
              <select
                value={form.kind}
                onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as EditableKind }))}
                className="paw-input"
              >
                {(Object.keys(kindLabels) as EditableKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabels[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="paw-field-label">标题</span>
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                className="paw-input"
                maxLength={180}
                placeholder="课程 / 会议 / 不可用时间"
              />
            </label>
          </div>

          <div className="paw-constraint-form-grid time">
            <label>
              <span className="paw-field-label">日期</span>
              <input
                type="date"
                value={form.date}
                onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">开始</span>
              <input
                type="time"
                value={form.start}
                onChange={(event) => setForm((current) => ({ ...current, start: event.target.value }))}
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">结束</span>
              <input
                type="time"
                value={form.end}
                onChange={(event) => setForm((current) => ({ ...current, end: event.target.value }))}
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">重复规则</span>
              <input
                value={form.recurrenceRule}
                onChange={(event) => setForm((current) => ({ ...current, recurrenceRule: event.target.value }))}
                className="paw-input"
                placeholder="每天 / 工作日 / 周一到周六 / weekly"
              />
            </label>
          </div>

          <div className="paw-constraint-form-grid last">
            {form.kind === "course" ? (
              <label>
                <span className="paw-field-label">课程名</span>
                <input
                  value={form.courseName}
                  onChange={(event) => setForm((current) => ({ ...current, courseName: event.target.value }))}
                  className="paw-input"
                  list="constraint-courses"
                  placeholder="课程名"
                />
                <datalist id="constraint-courses">
                  {courses.map((course) => (
                    <option key={course.id} value={course.name} />
                  ))}
                </datalist>
              </label>
            ) : null}
            <label>
              <span className="paw-field-label">地点（可选）</span>
              <input
                value={form.location}
                onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))}
                className="paw-input"
                maxLength={240}
                placeholder="教学楼 / 教室 / 线上会议"
              />
            </label>
            <div className="paw-save-row !mt-6">
              <button type="submit" disabled={pending === "save"} className="paw-primary-btn !px-4 !py-2 !text-sm">
                {pending === "save" ? <Save size={15} /> : <Plus size={15} />}
                {pending === "save" ? "保存中" : form.id ? "更新约束" : "保存约束"}
              </button>
              {form.id ? (
                <button type="button" onClick={() => setForm(emptyForm)} className="paw-secondary-btn !px-4 !py-2 !text-sm">
                  取消编辑
                </button>
              ) : null}
            </div>
          </div>
        </form>
      </section>

      <section className="paw-list-card">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">周循环摘要</h2>
            <p className="paw-list-subtitle">同名同时间的实例已折叠；展开后可以编辑或删除具体日期。</p>
          </div>
          <span className="paw-status-pill">{constraintGroups.length} 组 / {visibleBlocks.length} 个实例</span>
        </div>

        {visibleBlocks.length === 0 ? (
          <div className="paw-empty mt-4">
            <h3>还没有固定安排</h3>
            <p>新增课程、日常事项、恢复或不可用时间后，会显示在这里。</p>
          </div>
        ) : (
          <div className="paw-list mt-4">
            {constraintGroups.map((group) => (
              <div key={group.key} className={`paw-constraint-group ${timeBarClass(group)}`}>
                <div className="min-w-0">
                  <p className="paw-row-title">{redactPrivateTitle(group.title)}</p>
                  <p className="paw-row-meta">
                    {kindLabels[group.kind]} · {group.startTime}–{group.endTime} · {weekdaySummary(group.weekdays)}
                    {group.courseName ? ` · ${group.courseName}` : ""}
                    {group.location ? ` · ${group.location}` : " · 地点待确认"}
                    {group.recurrenceRule ? ` · ${group.recurrenceRule}` : ""}
                  </p>
                  <p className="paw-row-meta">
                    {formatDate(group.firstDate)} - {formatDate(group.lastDate)} · {group.blocks.length} 个实例
                  </p>
                </div>
                <details className="paw-constraint-instances">
                  <summary>查看 / 编辑 {group.blocks.length} 个实例</summary>
                  <div className="paw-list">
                    {group.blocks.map((block) => (
                      <div key={block.id} className="paw-list-row compact">
                        <div className="min-w-0">
                          <p className="paw-row-title">{formatDateTime(block.startsAt)} - {formatDateTime(block.endsAt)}</p>
                          <p className="paw-row-meta">
                            {kindLabels[block.kind]} · movable: false
                            {block.location ? ` · ${block.location}` : " · 地点待确认"}
                          </p>
                        </div>
                        <div className="paw-row-actions">
                          <button
                            type="button"
                            disabled={pending === block.id}
                            onClick={() => editExistingTimeBlock(block)}
                            aria-label={`编辑 ${redactPrivateTitle(block.title)}`}
                            className="paw-secondary-btn !px-3 !py-2 !text-xs"
                          >
                            <Pencil size={13} />
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={pending === block.id}
                            onClick={() => void deleteExistingTimeBlock(block)}
                            aria-label={`删除 ${redactPrivateTitle(block.title)}`}
                            className="paw-secondary-btn !px-3 !py-2 !text-xs text-[var(--app-danger)]"
                          >
                            <Trash2 size={13} />
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
