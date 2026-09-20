"use client";

import { AlertTriangle, Check, Clock3, LockKeyhole } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { layoutTimetableIntervals, minuteLabel } from "@/lib/planning/timetable-layout";
import type { TimelineItemView } from "@/lib/planning/view-data";
import { redactPrivateTitle } from "@/lib/display/privacy";
import { DialogSheet } from "./ui/dialog-sheet";
import styles from "./today-fixed-timeline.module.css";


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

export function TodayFixedTimeline({ items, includesTasks = false, onTaskSelect, now, completedTaskIds = [], headerAction }: { items: TimelineItemView[]; includesTasks?: boolean; onTaskSelect?: (id: string) => void; now?: Date | null; completedTaskIds?: string[]; headerAction?: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
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
  useEffect(() => {
    if (positioned.current || !now || !viewportRef.current) return;
    const active = viewportRef.current.querySelector<HTMLElement>("[data-current=true]");
    if (active) viewportRef.current.scrollTop = Math.max(0, active.offsetTop - viewportRef.current.offsetTop - 12);
    positioned.current = true;
  }, [now, layout.axis.startMinute]);

  return (
    <section className={styles.timeline} aria-labelledby="today-fixed-heading">
      <header className={styles.header}>
        <div>
          <p>时间轴</p>
          <h2 id="today-fixed-heading">{includesTasks ? "今天的时间安排" : "今天的固定安排"}</h2>
        </div>
        {headerAction ?? <span><LockKeyhole size={13} /> 只读</span>}
      </header>
      <p className={styles.hint}>{items.length} 项安排<span>{now ? `现在 ${minuteLabel(shanghaiMinute(now.toISOString()))}` : "按时间顺序"}</span></p>
      <div ref={viewportRef} className={styles.viewport} role="region" aria-label="全天时间轴" tabIndex={0}>
        <ol className={styles.agenda}>
          {layout.items.map((item) => {
            const done = completedTaskIds.includes(item.id);
            const active = Boolean(now && !done && Date.parse(item.startsAt) <= now.getTime() && Date.parse(item.endsAt) > now.getTime());
            const past = Boolean(now && Date.parse(item.endsAt) <= now.getTime());
            const needsCloseout = past && item.kind === "task" && !done;
            return <li key={item.id} data-current={active} className={`${styles.row} ${active ? styles.active : ""} ${done ? styles.done : ""} ${past && !needsCloseout ? styles.past : ""}`}>
              <div className={styles.time}><strong>{minuteLabel(item.startMinute)}</strong><span>{minuteLabel(item.endMinute)}</span></div>
              <div className={styles.rail}><span /></div>
              <button type="button" className={`${styles.card} ${item.conflict ? styles.conflict : ""}`}
                onClick={() => item.kind === "task" && onTaskSelect && !done ? onTaskSelect(item.id) : setSelected(item)}
                aria-label={`${redactPrivateTitle(item.title)}，${minuteLabel(item.startMinute)} 至 ${minuteLabel(item.endMinute)}${item.conflict ? "，存在冲突" : ""}`}>
                <span className={styles.meta}><span className={styles.tag}>{done ? <Check size={12} /> : item.protected ? <LockKeyhole size={12} /> : <Clock3 size={12} />}{active ? "进行中" : done ? "已完成" : needsCloseout ? "待收尾" : kindLabels[item.kind]}</span><span>{item.minutes} 分钟</span></span>
                <strong className={styles.title}>{redactPrivateTitle(item.title)}</strong>
                {active && item.kind === "task" ? <span className={styles.action}>查看进展／收尾 <span aria-hidden="true">→</span></span> : null}
                {item.conflict ? <span className={styles.warning}><AlertTriangle size={12} /> 与其他安排重叠</span> : null}
              </button>
            </li>;
          })}
        </ol>
        {items.length === 0 ? <p className={styles.empty}>还没有具体时段。安排后会显示在这里。</p> : <p className={styles.end}>今日安排到这里</p>}
      </div>
      <DialogSheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? redactPrivateTitle(selected.title) : "固定安排"}
        description={selected ? selected.kind === "task" && completedTaskIds.includes(selected.id) ? "已完成任务" : kindLabels[selected.kind] : undefined}
        variant="detail"
      >
        {selected ? (
          <div className={styles.detail}>
            <p><Clock3 size={16} /> {minuteLabel(shanghaiMinute(selected.startsAt))}–{minuteLabel(shanghaiMinute(selected.endsAt))}</p>
            <p>{selected.kind === "task" ? <>{completedTaskIds.includes(selected.id) ? <Check size={16} /> : <Clock3 size={16} />} {completedTaskIds.includes(selected.id) ? "已完成，此处仅查看已记录的任务时段" : "已安排的任务时段"}</> : <><LockKeyhole size={16} /> {selected.protected ? "受保护，不会自动修改" : "固定时间安排"}</>}</p>
            {layout.items.find((item) => item.id === selected.id)?.conflict ? <p><AlertTriangle size={16} /> 与其他安排时间重叠</p> : null}
          </div>
        ) : null}
      </DialogSheet>
    </section>
  );
}
