"use client";

import { Table } from "lucide-react";
import Link from "next/link";
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

const weekdayOrder: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayLookup: Record<string, WeekdayKey> = {
  mon: "mon",
  tue: "tue",
  wed: "wed",
  thu: "thu",
  fri: "fri",
  sat: "sat",
  sun: "sun",
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
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

export function ConstraintsView({ timetable }: { timetable: TimetableWeekView }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [timeBlocks, setTimeBlocks] = useState<TimeBlock[]>([]);
  const [summary, setSummary] = useState<ConstraintsResponse["summary"]>(undefined);
  const [conflicts, setConflicts] = useState<NonNullable<ConstraintsResponse["conflicts"]>>([]);
  const [message, setMessage] = useState<string | null>(null);
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

  return (
    <div className="paw-page">
      <PlanSectionNav />
      <section className="paw-page-header">
        <BackLink href="/plan" label="计划" />
        <h1 className="paw-page-date">固定安排</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">课程、日常事项、恢复和不可用时间都在课表中统一查看。</p>
        </div>
        <div className="paw-status-pills">
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
    </div>
  );
}
