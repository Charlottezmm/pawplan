"use client";

import { AlertTriangle, Check, Clock3, LockKeyhole } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { minuteLabel } from "@/lib/planning/timetable-layout";
import type { TimelineItemView } from "@/lib/planning/view-data";
import { redactPrivateTitle } from "@/lib/display/privacy";
import { DialogSheet } from "./ui/dialog-sheet";
import type { ActualRecord } from "@/lib/actual-records/schema";
import { buildActualTimeline, recordDate, type ActualTimelineItem } from "@/lib/actual-records/display";
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

export function TodayFixedTimeline({ items, includesTasks = false, onTaskSelect, now, completedTaskIds = [], headerAction, actualRecords = [], onRecordSelect }: { items: TimelineItemView[]; includesTasks?: boolean; onTaskSelect?: (id: string) => void; now?: Date | null; completedTaskIds?: string[]; headerAction?: ReactNode; actualRecords?: ActualRecord[]; onRecordSelect?: (record: ActualRecord) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const [selected, setSelected] = useState<ActualTimelineItem | null>(null);
  const day = recordDate(now ?? new Date());
  const layout = useMemo(() => ({ axis: { startMinute: 0 }, items: buildActualTimeline(items, actualRecords, day) }), [items, actualRecords, day]);
  const currentItemId = now ? layout.items.find((item) => !item.actual && !completedTaskIds.includes(item.id) && Date.parse(item.startsAt) <= now.getTime() && Date.parse(item.endsAt) > now.getTime())?.id : undefined;
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
          <h2 id="today-fixed-heading">{includesTasks ? "今天的时间安排" : "今天的固定安排"}</h2>
          <p className={styles.hint}>{layout.items.filter((i) => !i.actual).length} 项安排 · {actualRecords.length} 段实录</p>
        </div>
        {headerAction ?? <span><LockKeyhole size={13} /> 只读</span>}
      </header>
      <div className={styles.legend} aria-label="时间轴图例">
        <span><i className={styles.dot} aria-hidden="true" />计划</span>
        <span><i className={`${styles.dot} ${styles.actualDot}`} aria-hidden="true" />实际记录</span>
        <span><i className={`${styles.dot} ${styles.currentDot}`} aria-hidden="true" />当前计划</span>
      </div>
      <div ref={viewportRef} className={styles.viewport} role="region" aria-label="全天时间轴" tabIndex={0}>
        <ol className={styles.agenda}>
          {layout.items.map((item) => {
            const done = item.actual ? item.actual.task?.status === "done" : completedTaskIds.includes(item.id);
            const active = Boolean(now && !item.actual && !done && Date.parse(item.startsAt) <= now.getTime() && Date.parse(item.endsAt) > now.getTime());
            const past = Boolean(now && Date.parse(item.endsAt) <= now.getTime());
            const needsCloseout = !item.actual && past && item.kind === "task" && !done;
            return <li key={item.id} data-current={active} className={`${styles.row} ${active ? styles.active : ""} ${needsCloseout ? styles.closeout : ""} ${done && !item.actual ? styles.done : ""} ${item.actual ? styles.actual : past && !needsCloseout ? styles.past : ""}`}>
              {item.id === currentItemId && now ? <div className={styles.nowMarker}><span>现在 {minuteLabel(shanghaiMinute(now.toISOString()))}</span><i aria-hidden="true" /></div> : null}
              <div className={styles.time}><strong>{minuteLabel(item.startMinute)}</strong><span>{minuteLabel(item.endMinute)}</span></div>
              <button type="button" className={`${styles.card} ${item.conflict ? styles.conflict : ""}`}
                onClick={() => item.actual ? onRecordSelect?.(item.actual) : item.kind === "task" && onTaskSelect && !done ? onTaskSelect(item.id) : setSelected(item)}
                aria-label={`${item.actual ? "实际记录：" : "计划："}${redactPrivateTitle(item.title)}，${minuteLabel(item.startMinute)} 至 ${minuteLabel(item.endMinute)}${item.conflict ? "，存在冲突" : ""}`}>
                <span className={styles.meta}><span className={styles.tag}><i className={styles.dot} aria-hidden="true" />{item.protected ? <LockKeyhole size={12} aria-label="时段受保护" /> : null}{item.actual ? "实际记录" : active ? "当前计划" : done ? "已完成 · 计划时段" : needsCloseout ? "待收尾" : kindLabels[item.kind]}</span><span>{item.actual && (recordDate(new Date(item.actual.startsAt)) !== day || recordDate(new Date(item.actual.endsAt)) !== day) ? "本日 " : ""}{item.actual?.approximate ? "约 " : ""}{item.minutes} 分钟</span></span>
                <strong className={styles.title}>{redactPrivateTitle(item.title)}</strong>
                {item.actual?.task ? <span className={styles.recordStatus}>{done ? "关联任务已完成" : "尚未完成"}</span> : null}
                {active && item.kind === "task" ? <span className={styles.action}>查看进展／收尾 <span aria-hidden="true">→</span></span> : null}
                {needsCloseout ? <span className={styles.action}>收尾或续一段 <span aria-hidden="true">→</span></span> : null}
                {item.conflict ? <span className={styles.warning}><AlertTriangle size={12} /> 与其他安排重叠</span> : null}
              </button>
            </li>;
          })}
        </ol>
        {layout.items.length === 0 ? <p className={styles.empty}>还没有具体时段或实际记录。</p> : <p className={styles.end}>当天未记录的时间保持留白</p>}
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
