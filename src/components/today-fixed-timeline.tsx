"use client";

import { AlertTriangle, Clock3, LockKeyhole } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { layoutTimetableIntervals, minuteLabel } from "@/lib/planning/timetable-layout";
import type { TimelineItemView } from "@/lib/planning/view-data";
import { redactPrivateTitle } from "@/lib/display/privacy";
import { DialogSheet } from "./ui/dialog-sheet";
import styles from "./today-fixed-timeline.module.css";

type TimelineStyle = CSSProperties & Record<`--${string}`, string | number>;

const kindLabels: Record<TimelineItemView["kind"], string> = {
  task: "任务",
  course: "课程",
  exam: "考试",
  meeting: "会议",
  unavailable: "不可用",
  routine: "个人安排",
  recovery: "恢复时间",
};

function shanghaiMinute(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export function TodayFixedTimeline({ items }: { items: TimelineItemView[] }) {
  const [selected, setSelected] = useState<TimelineItemView | null>(null);
  const layout = useMemo(() => {
    const intervals = items.map((item) => ({
      ...item,
      startMinute: shanghaiMinute(item.startsAt),
      endMinute: shanghaiMinute(item.endsAt),
    })).filter((item) => item.endMinute > item.startMinute);
    const earliest = intervals.length ? Math.min(...intervals.map((item) => item.startMinute)) : 8 * 60;
    const latest = intervals.length ? Math.max(...intervals.map((item) => item.endMinute)) : 22 * 60;
    const axis = {
      startMinute: Math.min(8 * 60, Math.floor(earliest / 60) * 60),
      endMinute: Math.max(22 * 60, Math.ceil(latest / 60) * 60),
    };
    return { axis, items: layoutTimetableIntervals(intervals, axis) };
  }, [items]);
  const height = layout.axis.endMinute - layout.axis.startMinute;
  const ticks: number[] = [];
  for (let minute = layout.axis.startMinute; minute <= layout.axis.endMinute; minute += 60) ticks.push(minute);

  return (
    <section className={styles.timeline} aria-labelledby="today-fixed-heading">
      <header className={styles.header}>
        <div>
          <p>时间轴</p>
          <h2 id="today-fixed-heading">今天的固定安排</h2>
        </div>
        <span><LockKeyhole size={13} /> 只读</span>
      </header>
      <p className={styles.hint}>只显示确有起止时间的课程、会议和个人安排。</p>
      <div className={styles.canvas} style={{ "--timeline-height": `${height}px` } as TimelineStyle}>
        <div className={styles.axis} aria-hidden="true">
          {ticks.map((minute) => <span key={minute} style={{ top: `${minute - layout.axis.startMinute}px` }}>{minuteLabel(minute)}</span>)}
        </div>
        <div className={styles.grid}>
          {ticks.map((minute) => <span key={minute} style={{ top: `${minute - layout.axis.startMinute}px` }} aria-hidden="true" />)}
          {layout.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.block} ${item.height < 60 ? styles.compact : ""} ${item.conflict ? styles.conflict : ""}`}
              style={{
                "--block-top": `${item.top}px`,
                "--block-height": `${item.height}px`,
                "--lane-left": `${(item.lane / item.laneCount) * 100}%`,
                "--lane-width": `${100 / item.laneCount}%`,
              } as TimelineStyle}
              onClick={() => setSelected(item)}
              aria-label={`${redactPrivateTitle(item.title)}，${minuteLabel(item.startMinute)} 至 ${minuteLabel(item.endMinute)}${item.conflict ? "，存在冲突" : ""}`}
            >
              <strong>{redactPrivateTitle(item.title)}</strong>
              <span>{minuteLabel(item.startMinute)}{item.height >= 60 ? `–${minuteLabel(item.endMinute)}` : ""}</span>
              {item.conflict ? <AlertTriangle size={13} aria-hidden="true" /> : null}
            </button>
          ))}
          {layout.items.length === 0 ? <p className={styles.empty}>今天没有固定安排，空白时间不会自动填入任务。</p> : null}
        </div>
      </div>
      <DialogSheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? redactPrivateTitle(selected.title) : "固定安排"}
        description={selected ? kindLabels[selected.kind] : undefined}
        variant="detail"
      >
        {selected ? (
          <div className={styles.detail}>
            <p><Clock3 size={16} /> {minuteLabel(shanghaiMinute(selected.startsAt))}–{minuteLabel(shanghaiMinute(selected.endsAt))}</p>
            <p><LockKeyhole size={16} /> {selected.protected ? "受保护，不会自动修改" : "固定时间安排"}</p>
            {layout.items.find((item) => item.id === selected.id)?.conflict ? <p><AlertTriangle size={16} /> 与其他固定安排时间重叠</p> : null}
          </div>
        ) : null}
      </DialogSheet>
    </section>
  );
}
