"use client";

import Link from "next/link";
import { AlertTriangle, BookOpen, CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin, Pencil, Plus, Table, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  layoutTimetableIntervals,
  minuteLabel,
  type TimetableAxis,
} from "@/lib/planning/timetable-layout";
import { redactPrivateTitle } from "@/lib/display/privacy";
import styles from "./time-block-timetable.module.css";

export type TimetableOccurrenceView = {
  id: string;
  seriesId: string;
  dateKey: string;
  title: string;
  kind: "course" | "exam" | "meeting" | "unavailable" | "routine" | "recovery";
  startsAt: string;
  endsAt: string;
  startMinute: number;
  endMinute: number;
  courseName: string | null;
  location: string | null;
  color: string;
};

export type TimetableDayView = {
  dateKey: string;
  weekdayLabel: string;
  dateLabel: string;
  isToday: boolean;
  occurrences: TimetableOccurrenceView[];
};

export type TimetableWeekView = {
  weekLabel: string;
  days: TimetableDayView[];
  selectedDateKey: string;
  todayDateKey: string;
  previousDateKey: string;
  nextDateKey: string;
  previousWeekDateKey: string;
  nextWeekDateKey: string;
  axis: TimetableAxis;
  unavailable?: boolean;
};

type PositionedOccurrence = TimetableOccurrenceView & {
  lane: number;
  laneCount: number;
  top: number;
  height: number;
  conflict: boolean;
};

type ShortHitExpansion = "center" | "before" | "after";

type TimetableStyle = CSSProperties & Record<`--${string}`, string | number>;

const kindLabels: Record<TimetableOccurrenceView["kind"], string> = {
  course: "课程",
  exam: "考试",
  meeting: "会议",
  routine: "个人安排",
  unavailable: "不可用",
  recovery: "休息",
};

function dateHref(dateKey: string) {
  return `/constraints?date=${dateKey}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function positionedDays(week: TimetableWeekView) {
  return week.days.map((day) => ({
    ...day,
    positioned: layoutTimetableIntervals(day.occurrences, week.axis),
  }));
}

function hourTicks(axis: TimetableAxis) {
  const ticks: number[] = [];
  for (let minute = Math.ceil(axis.startMinute / 60) * 60; minute <= axis.endMinute; minute += 60) {
    ticks.push(minute);
  }
  return ticks;
}

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    minute: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function occurrenceStyle(item: PositionedOccurrence): TimetableStyle {
  return {
    "--block-top": `${item.top}px`,
    "--block-height": `${item.height}px`,
    "--lane-left": `${(item.lane / item.laneCount) * 100}%`,
    "--lane-width": `${100 / item.laneCount}%`,
    "--course-color": item.color,
  };
}

function CourseBlock({
  item,
  hitExpansion,
  onOpen,
}: {
  item: PositionedOccurrence;
  hitExpansion: ShortHitExpansion;
  onOpen: (item: TimetableOccurrenceView, trigger: HTMLButtonElement) => void;
}) {
  const compact = item.height < 60;
  const displayTitle = redactPrivateTitle(item.title);
  const displayCourseName = redactPrivateTitle(item.courseName?.trim() || item.title);
  const accessibleTitle = displayCourseName === displayTitle
    ? displayCourseName
    : `${displayCourseName}，${displayTitle}`;
  const timeLabel = `${minuteLabel(item.startMinute)}–${minuteLabel(item.endMinute)}`;
  const locationLabel = item.location?.trim() || "地点待确认";
  return (
    <button
      type="button"
      className={`${styles.courseBlock} ${compact ? styles.compactBlock : ""} ${item.conflict ? styles.conflictBlock : ""} ${hitExpansion === "before" ? styles.hitExtendBefore : ""} ${hitExpansion === "after" ? styles.hitExtendAfter : ""}`}
      style={occurrenceStyle(item)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(item, event.currentTarget);
      }}
      aria-label={`${accessibleTitle}，${minuteLabel(item.startMinute)} 至 ${minuteLabel(item.endMinute)}，${locationLabel}${item.conflict ? "，存在时间冲突" : ""}`}
    >
      <span className={styles.blockContent}>
        <strong className={styles.blockTitle}>{displayTitle}</strong>
        <span className={styles.blockMeta}>
          <span className={styles.blockTime}>{timeLabel}</span>
          <span className={styles.metaSeparator} aria-hidden="true">·</span>
          <span className={styles.blockLocation}>{locationLabel}</span>
        </span>
      </span>
      {item.conflict ? <AlertTriangle className={styles.blockConflictIcon} size={14} aria-hidden="true" /> : null}
    </button>
  );
}

export function TimeBlockTimetable({
  week,
  onCreate,
  onEdit,
}: {
  week: TimetableWeekView;
  onCreate?: (dateKey: string, startMinute?: number) => void;
  onEdit?: (item: TimetableOccurrenceView) => boolean | void;
}) {
  const [selected, setSelected] = useState<TimetableOccurrenceView | null>(null);
  const [now, setNow] = useState(shanghaiNow);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const days = useMemo(() => positionedDays(week), [week]);
  const ticks = useMemo(() => hourTicks(week.axis), [week.axis]);
  const selectedDay = days.find((day) => day.dateKey === week.selectedDateKey) ?? days[0];
  const gridHeight = week.axis.endMinute - week.axis.startMinute;
  const gridStyle: TimetableStyle = { "--grid-height": `${gridHeight}px` };
  const selectedTitle = selected ? redactPrivateTitle(selected.title) : "";
  const selectedCourseName = selected
    ? redactPrivateTitle(selected.courseName?.trim() || selected.title)
    : "";
  const selectedLocationLabel = selected?.location?.trim() || "地点待确认";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(shanghaiNow()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSelected(null);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  function openDetail(item: TimetableOccurrenceView, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setSelected(item);
  }

  function closeDetail() {
    setSelected(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function renderGrid(day: typeof days[number]) {
    const currentTop = now.minute - week.axis.startMinute;
    function hitExpansion(item: PositionedOccurrence): ShortHitExpansion {
      if (item.height >= 44) return "center";
      const hasAdjacentBefore = day.positioned.some((candidate) =>
        candidate.id !== item.id && candidate.endMinute === item.startMinute);
      const hasAdjacentAfter = day.positioned.some((candidate) =>
        candidate.id !== item.id && candidate.startMinute === item.endMinute);
      if (hasAdjacentAfter && !hasAdjacentBefore) return "before";
      if (hasAdjacentBefore && !hasAdjacentAfter) return "after";
      return "center";
    }
    function createFromPointer(event: React.MouseEvent<HTMLDivElement>) {
      if (!onCreate || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const clickedMinute = week.axis.startMinute + (event.clientY - bounds.top);
      const snappedMinute = Math.round(clickedMinute / 30) * 30;
      onCreate(day.dateKey, snappedMinute);
    }
    return (
      <div
        className={`${styles.dayGrid} ${onCreate ? styles.interactiveGrid : ""}`}
        style={gridStyle}
        aria-label={`${day.dateLabel} 日程时间轴`}
        onClick={createFromPointer}
      >
        {day.dateKey === now.dateKey && currentTop >= 0 && currentTop <= gridHeight ? (
          <div className={styles.currentTimeLine} style={{ top: `${currentTop}px` }} aria-label={`当前时间 ${minuteLabel(now.minute)}`}>
            <span>{minuteLabel(now.minute)}</span>
          </div>
        ) : null}
        {day.positioned.map((item) => (
          <CourseBlock key={item.id} item={item} hitExpansion={hitExpansion(item)} onOpen={openDetail} />
        ))}
      </div>
    );
  }

  return (
    <section className={styles.timetable} aria-labelledby="timetable-heading">
      <div className={styles.toolbar}>
        <div>
          <p className={styles.eyebrow}>时间轴</p>
          <h2 id="timetable-heading">{week.weekLabel}</h2>
          <p className={styles.hint}>空白表示没有确定安排；点击空白时间可预填新日程。</p>
        </div>
        <div className={styles.toolbarActions}>
          <div className={styles.primaryActions}>
            <Link href="/import" className={styles.importLink} aria-label="导入日程">
              <Table size={16} />导入
            </Link>
            {onCreate ? (
              <button type="button" className={styles.createButton} onClick={() => onCreate(week.selectedDateKey)}>
                <Plus size={17} />新建
              </button>
            ) : null}
          </div>
          <div className={styles.weekActions} aria-label="切换周">
            <Link href={dateHref(week.previousWeekDateKey)} className={styles.iconLink} aria-label="上一周">
              <ChevronLeft size={19} />
            </Link>
            <Link href={dateHref(week.todayDateKey)} className={styles.todayLink}>今天</Link>
            <Link href={dateHref(week.nextWeekDateKey)} className={styles.iconLink} aria-label="下一周">
              <ChevronRight size={19} />
            </Link>
          </div>
        </div>
      </div>

      {week.unavailable ? (
        <div className={styles.unavailable} role="alert">
          日程暂时无法读取。请稍后刷新；这里不会用示例数据代替真实安排。
        </div>
      ) : null}

      <div className={styles.desktopWeek} hidden={week.unavailable}>
        <div className={styles.weekHeader}>
          <div aria-hidden="true" />
          {days.map((day) => (
            <div key={day.dateKey} className={`${styles.dayHeader} ${day.isToday ? styles.todayHeader : ""}`}>
              <span>{day.weekdayLabel}</span>
              <strong>{day.dateLabel}</strong>
            </div>
          ))}
        </div>
        <div className={styles.weekBody}>
          <div className={styles.timeAxis} style={gridStyle} aria-hidden="true">
            {ticks.map((minute) => (
              <span key={minute} style={{ top: `${minute - week.axis.startMinute}px` }}>{minuteLabel(minute)}</span>
            ))}
          </div>
          {days.map((day) => (
            <div key={day.dateKey} className={`${styles.desktopDayColumn} ${day.isToday ? styles.todayColumn : ""}`}>
              {renderGrid(day)}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.mobileDay} hidden={week.unavailable}>
        <nav className={styles.dateStrip} aria-label="选择日期">
          {days.map((day) => (
            <Link
              key={day.dateKey}
              href={dateHref(day.dateKey)}
              className={`${styles.dateChoice} ${day.dateKey === week.selectedDateKey ? styles.selectedDate : ""} ${day.isToday ? styles.todayDate : ""}`}
              aria-current={day.dateKey === week.selectedDateKey ? "date" : undefined}
            >
              <span>{day.weekdayLabel}</span>
              <strong>{day.dateLabel}</strong>
            </Link>
          ))}
        </nav>
        <div className={styles.dayActions}>
          <Link href={dateHref(week.previousDateKey)} className={styles.dayNavLink} aria-label="上一天">
            <ChevronLeft size={18} /> 上一天
          </Link>
          <Link href={dateHref(week.todayDateKey)} className={styles.mobileTodayLink}>今天</Link>
          <Link href={dateHref(week.nextDateKey)} className={styles.dayNavLink} aria-label="下一天">
            下一天 <ChevronRight size={18} />
          </Link>
        </div>
        <div className={styles.mobileGridShell}>
          <div className={styles.timeAxis} style={gridStyle} aria-hidden="true">
            {ticks.map((minute) => (
              <span key={minute} style={{ top: `${minute - week.axis.startMinute}px` }}>{minuteLabel(minute)}</span>
            ))}
          </div>
          <div className={styles.mobileGrid}>{renderGrid(selectedDay)}</div>
        </div>
      </div>

      {selected ? createPortal((
        <div className={styles.detailBackdrop} onMouseDown={(event) => event.target === event.currentTarget && closeDetail()}>
          <section className={styles.detailPanel} role="dialog" aria-modal="true" aria-labelledby="course-detail-title">
            <button ref={closeButtonRef} type="button" className={styles.detailClose} onClick={closeDetail} aria-label="关闭日程详情">
              <X size={20} />
            </button>
            <p className={styles.eyebrow}>日程详情</p>
            <h3 id="course-detail-title">{selectedTitle}</h3>
            <dl className={styles.detailList}>
              {selected.courseName?.trim() && selectedCourseName !== selectedTitle ? (
                <div>
                  <dt><BookOpen size={17} />课程</dt>
                  <dd>{selectedCourseName}</dd>
                </div>
              ) : null}
              <div>
                <dt><CalendarDays size={17} />日期与时间</dt>
                <dd>{formatDateTime(selected.startsAt)}–{minuteLabel(selected.endMinute)}</dd>
              </div>
              <div>
                <dt><MapPin size={17} />地点</dt>
                <dd>{selectedLocationLabel}</dd>
              </div>
              <div>
                <dt><Clock3 size={17} />类型</dt>
                <dd>{kindLabels[selected.kind]}</dd>
              </div>
            </dl>
            {onEdit ? (
              <button
                type="button"
                className={styles.detailEdit}
                onClick={() => {
                  if (onEdit(selected) !== false) closeDetail();
                }}
              >
                <Pencil size={16} />编辑日程
              </button>
            ) : null}
          </section>
        </div>
      ), document.body) : null}
    </section>
  );
}
