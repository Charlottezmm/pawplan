"use client";

import Link from "next/link";
import { AlertTriangle, BookOpen, CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  kind: "course" | "meeting" | "unavailable" | "routine" | "recovery";
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

type TimetableStyle = CSSProperties & Record<`--${string}`, string | number>;

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
  onOpen,
}: {
  item: PositionedOccurrence;
  onOpen: (item: TimetableOccurrenceView, trigger: HTMLButtonElement) => void;
}) {
  const compact = item.height < 60;
  const displayTitle = redactPrivateTitle(item.title);
  return (
    <button
      type="button"
      className={`${styles.courseBlock} ${compact ? styles.compactBlock : ""} ${item.conflict ? styles.conflictBlock : ""}`}
      style={occurrenceStyle(item)}
      onClick={(event) => onOpen(item, event.currentTarget)}
      aria-label={`${displayTitle}，${minuteLabel(item.startMinute)} 至 ${minuteLabel(item.endMinute)}，${item.location ?? "地点待确认"}${item.conflict ? "，存在时间冲突" : ""}`}
    >
      <span className={styles.blockContent}>
        <strong className={styles.blockTitle}>{displayTitle}</strong>
        <span className={styles.blockTime}>{minuteLabel(item.startMinute)}–{minuteLabel(item.endMinute)}</span>
        <span className={styles.blockLocation}>{item.location ?? "地点待确认"}</span>
      </span>
      {item.conflict ? <AlertTriangle className={styles.blockConflictIcon} size={14} aria-hidden="true" /> : null}
    </button>
  );
}

export function TimeBlockTimetable({ week }: { week: TimetableWeekView }) {
  const [selected, setSelected] = useState<TimetableOccurrenceView | null>(null);
  const [now, setNow] = useState(shanghaiNow);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const days = useMemo(() => positionedDays(week), [week]);
  const ticks = useMemo(() => hourTicks(week.axis), [week.axis]);
  const selectedDay = days.find((day) => day.dateKey === week.selectedDateKey) ?? days[0];
  const gridHeight = week.axis.endMinute - week.axis.startMinute;
  const gridStyle: TimetableStyle = { "--grid-height": `${gridHeight}px` };

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
    return (
      <div className={styles.dayGrid} style={gridStyle} aria-label={`${day.dateLabel} 固定课程时间轴`}>
        {day.dateKey === now.dateKey && currentTop >= 0 && currentTop <= gridHeight ? (
          <div className={styles.currentTimeLine} style={{ top: `${currentTop}px` }} aria-label={`当前时间 ${minuteLabel(now.minute)}`}>
            <span>{minuteLabel(now.minute)}</span>
          </div>
        ) : null}
        {day.positioned.map((item) => (
          <CourseBlock key={item.id} item={item} onOpen={openDetail} />
        ))}
      </div>
    );
  }

  return (
    <section className={styles.timetable} aria-labelledby="timetable-heading">
      <div className={styles.toolbar}>
        <div>
          <p className={styles.eyebrow}>固定课程表</p>
          <h2 id="timetable-heading">{week.weekLabel}</h2>
          <p className={styles.hint}>空白表示当前没有固定课程占用，不代表必须安排任务。</p>
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

      {week.unavailable ? (
        <div className={styles.unavailable} role="alert">
          课表暂时无法读取。请稍后刷新；这里不会用示例课程代替真实数据。
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

      {selected ? (
        <div className={styles.detailBackdrop} onMouseDown={(event) => event.target === event.currentTarget && closeDetail()}>
          <section className={styles.detailPanel} role="dialog" aria-modal="true" aria-labelledby="course-detail-title">
            <button ref={closeButtonRef} type="button" className={styles.detailClose} onClick={closeDetail} aria-label="关闭课程详情">
              <X size={20} />
            </button>
            <p className={styles.eyebrow}>固定安排详情</p>
            <h3 id="course-detail-title">{redactPrivateTitle(selected.title)}</h3>
            <dl className={styles.detailList}>
              {selected.courseName && selected.courseName !== selected.title ? (
                <div>
                  <dt><BookOpen size={17} />课程</dt>
                  <dd>{selected.courseName}</dd>
                </div>
              ) : null}
              <div>
                <dt><CalendarDays size={17} />日期与时间</dt>
                <dd>{formatDateTime(selected.startsAt)}–{minuteLabel(selected.endMinute)}</dd>
              </div>
              <div>
                <dt><MapPin size={17} />地点</dt>
                <dd>{selected.location ?? "地点待确认"}</dd>
              </div>
              <div>
                <dt><Clock3 size={17} />类型</dt>
                <dd>{selected.kind === "course" ? "固定课程" : "固定时间占用"}</dd>
              </div>
            </dl>
          </section>
        </div>
      ) : null}
    </section>
  );
}
