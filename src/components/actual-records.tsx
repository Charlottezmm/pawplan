"use client";
import { useEffect, useRef, useState } from "react";
import { Plus, Pencil, Clock3, ChevronRight, Link2, CalendarDays, ChevronDown, ChartNoAxesColumn } from "lucide-react";
import { RecordTaskPicker } from "./record-task-picker";
import { DialogSheet } from "./ui/dialog-sheet";
import { Notice } from "./ui/notice";
import type { ActualRecord, ActualRecordList } from "@/lib/actual-records/schema";
import { localRecordValue, recordDate, recordDuration, recordTimeLabel } from "@/lib/actual-records/display";
import styles from "./actual-records.module.css";
export const actualRecordsChanged = "pawplan:actual-records-changed";
export type RecordTaskChoice = { id: string; title: string; status?: string };
export type RecordEditorTarget = { record?: ActualRecord; task?: RecordTaskChoice; day?: string };
export function useActualRecords(day: string, enabled = true) {
  const [state, setState] = useState<{ data: ActualRecordList; error: string | null; loading: boolean }>({ data: { records: [], truncated: false }, error: null, loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener(actualRecordsChanged, refresh);
    window.addEventListener("pawplan:timing-changed", refresh);
    return () => { window.removeEventListener(actualRecordsChanged, refresh); window.removeEventListener("pawplan:timing-changed", refresh); };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ data: { records: [], truncated: false }, error: null, loading: true });
    fetch(`/api/actual-records?date_from=${day}&date_to=${day}`, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => { if (!res.ok) throw new Error(); return res.json() as Promise<ActualRecordList>; })
      .then((data) => { if (!Array.isArray(data.records)) throw new Error(); if (!controller.signal.aborted) setState({ data, error: null, loading: false }); })
      .catch(() => { if (!controller.signal.aborted) setState({ data: { records: [], truncated: false }, error: "实际记录暂时无法读取，请重试。", loading: false }); });
    return () => controller.abort();
  }, [day, enabled, version]);
  return { ...state, refresh: () => setVersion((v) => v + 1) };
}
export function ActualRecordsSection({ today, todayState, onOpen, onCompare }: { today: string; todayState: ReturnType<typeof useActualRecords>; onOpen: (target: RecordEditorTarget) => void; onCompare?: (day: string) => void }) {
  const [day, setDay] = useState(today);
  const other = useActualRecords(day, day !== today);
  const state = day === today ? todayState : other;
  const dateLabel = `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
  return <section className={styles.section} aria-labelledby="actual-records-heading">
    <header className={styles.header}>
      <h2 id="actual-records-heading" className="paw-today-tasks-title">实际记录</h2>
      <div className={styles.headerActions}>
        {onCompare ? <button type="button" className="paw-secondary-btn" onClick={() => onCompare(day)}><ChartNoAxesColumn size={15} />计划与实际</button> : null}
        <label className={styles.date}><CalendarDays size={14} /><span>{dateLabel}</span><ChevronDown size={14} /><input aria-label="实际记录日期" type="date" value={day} max={today} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} /></label>
        <button type="button" className="paw-primary-btn" onClick={() => onOpen({ day })}><Plus size={16} />记一段</button>
      </div>
    </header>
    <div className={styles.card}>
    {state.loading ? <p className={styles.empty} role="status">正在读取记录…</p> : state.error ? <><Notice tone="danger" title={state.error} /><button type="button" className="paw-secondary-btn" onClick={state.refresh}>重试读取</button></> : state.data.records.length === 0 ? <p className={styles.empty}>这天还没有记录。可以补记一段，也可以留白。</p> : <ul className={styles.list}>{state.data.records.map((record) => <li key={record.id}>
      <div className={styles.row}><div><p className={styles.time}><Clock3 size={13} />{recordTimeLabel(record)}{record.approximate ? " · 约" : " · "}{recordDuration(record)} 分钟</p><h3>{record.title}</h3>{record.task ? <p className={styles.meta}>{record.task.status === "done" ? "关联任务已完成" : "关联任务尚未完成"}</p> : null}</div><button type="button" className={styles.edit} aria-label={`修改记录：${record.title}`} onClick={() => onOpen({ record })}><Pencil size={15} /><span>修改</span></button></div>
    </li>)}</ul>}
    {state.data.truncated ? <Notice tone="warning" title="记录较多，当前仅显示前 1000 段。" /> : null}
    </div>
  </section>;
}
export function ActualRecordEditor({ target, tasks, onClose }: { target: RecordEditorTarget; tasks: RecordTaskChoice[]; onClose: () => void }) {
  const previous = target.record;
  const now = new Date(); now.setSeconds(0, 0);
  const day = target.day ?? recordDate(now);
  const defaultEnd = day === recordDate(now) ? localRecordValue(now.toISOString()) : `${day}T21:00`;
  const defaultStart = day === recordDate(now) ? localRecordValue(new Date(now.getTime() - 30 * 60000).toISOString()) : `${day}T20:30`;
  const [title, setTitle] = useState(previous?.title ?? target.task?.title ?? "");
  const [start, setStart] = useState(previous ? localRecordValue(previous.startsAt) : defaultStart);
  const [end, setEnd] = useState(previous ? localRecordValue(previous.endsAt) : defaultEnd);
  const [taskId, setTaskId] = useState(previous?.taskId ?? target.task?.id ?? "");
  const [approximate, setApproximate] = useState(previous?.approximate ?? false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const [choosingTask, setChoosingTask] = useState(false);
  const [selectedTask, setSelectedTask] = useState<RecordTaskChoice | null>(
    target.task ?? tasks.find((t) => t.id === taskId) ?? (taskId ? { id: taskId, title: previous?.task?.title ?? previous?.planSnapshot.title ?? "原关联任务" } : null),
  );
  const taskButton = useRef<HTMLButtonElement>(null);
  function returnToRecord() { setChoosingTask(false); requestAnimationFrame(() => taskButton.current?.focus()); }
  async function save(remove = false) {
    if (inFlight.current) return;
    setError(null);
    let record;
    if (!remove) {
      const a = Date.parse(`${start}:00+08:00`), b = Date.parse(`${end}:00+08:00`);
      if (!title.trim() || !Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 48 * 3600000) { setError("请填写内容和有效起止时间，单段不超过 48 小时。"); return; }
      if (b > Date.now()) { setError("实际记录不能填入尚未发生的时间。"); return; }
      record = { title: title.trim(), starts_at: previous && localRecordValue(previous.startsAt) === start ? previous.startsAt : new Date(a).toISOString(), ends_at: previous && localRecordValue(previous.endsAt) === end ? previous.endsAt : new Date(b).toISOString(), task_id: taskId || null, approximate };
    }
    const body = { ...(previous ? { id: previous.id, expected_revision: previous.revision } : {}), ...(record ? { record } : {}) };
    const fingerprint = JSON.stringify({ remove, body });
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
    inFlight.current = true; setPending(true);
    let outcomeUnknown = true;
    try {
      const res = await fetch("/api/actual-records", { method: remove ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idempotency_key: attempt.current.key }) });
      const result = await res.json().catch(() => null);
      if (!res.ok) { outcomeUnknown = res.status >= 500; throw new Error(result?.error ?? "保存失败，请保持内容不变后重试。"); }
      if (!result) throw new Error("服务暂时没有返回可核对的结果，请保持内容不变后重试。");
      if (result.readback?.verification !== "succeeded") throw new Error("记录已提交，暂未核对成功。请保持内容不变再点保存，或关闭后重新读取。");
      window.dispatchEvent(new Event(actualRecordsChanged));
      if (!result.readback.matchesMutation) throw new Error("记录已保存，但随后又被修改。请关闭并重新打开查看最新内容。");
      if (!result.record?.id || (previous && result.record.id !== previous.id)) throw new Error("返回的记录无法核对，请重新读取。");
      onClose();
    } catch (e) { setUncertain(outcomeUnknown); setError(e instanceof Error && !(e instanceof TypeError) ? e.message : "网络中断，请保持内容不变后重试。"); }
    finally { setPending(false); inFlight.current = false; }
  }
  function close() {
    if (choosingTask) { returnToRecord(); return; }
    if (error) window.dispatchEvent(new Event(actualRecordsChanged));
    onClose();
  }
  return <DialogSheet open onClose={close} title={choosingTask ? "关联任务" : previous ? "修改实际记录" : "记一段实际经历"} description={choosingTask ? "选择一项做过的任务，记录内容会保留。" : "时间按北京时间记录；跨夜时选择对应日期。"} variant="detail" className={styles.editor} initialFocusRef={titleRef} closeDisabled={pending}>
    {choosingTask ? <RecordTaskPicker tasks={tasks} selectedId={taskId} onBack={returnToRecord} onSelect={(task) => { setSelectedTask(task); setTaskId(task?.id ?? ""); returnToRecord(); }} /> : <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label><span className="paw-field-label">做了什么</span><input ref={titleRef} className="paw-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={240} required disabled={pending || uncertain} placeholder="例如：概率题、散步、睡觉" /></label>
      <div className={styles.times}><label><span className="paw-field-label">开始时间</span><input className="paw-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required disabled={pending || uncertain} /></label><label><span className="paw-field-label">结束时间</span><input className="paw-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required disabled={pending || uncertain} /></label></div>
      <div><span className="paw-field-label" id="record-task-label">关联任务（可选）</span><button ref={taskButton} type="button" className={styles.taskTrigger} aria-label="选择关联任务" disabled={pending || uncertain} onClick={() => setChoosingTask(true)}><Link2 size={18} /><span><strong>{selectedTask?.title ?? "不关联任务"}</strong><small>{selectedTask ? "点击更换或取消关联" : "选择今日任务，也可以留空"}</small></span><ChevronRight size={17} /></button></div>
      <label className={styles.check}><input type="checkbox" checked={approximate} onChange={(e) => setApproximate(e.target.checked)} disabled={pending || uncertain} />时间是大致估计的</label>
      {previous?.planSnapshot.taskId ? <details className={styles.snapshot}><summary>查看记录时的计划</summary><p>{previous.planSnapshot.scheduledStart && previous.planSnapshot.scheduledEnd ? recordTimeLabel({ startsAt: previous.planSnapshot.scheduledStart, endsAt: previous.planSnapshot.scheduledEnd }) : "当时未安排具体时间"} · 预计 {previous.planSnapshot.estimatedMinutes} 分钟</p></details> : null}
      <p className={styles.meta}>保存记录不会自动完成任务，也不会改动计划。</p>
      {error ? <Notice tone="danger" title={error} /> : null}
      {uncertain ? <p className={styles.meta}>结果尚未核对，暂时锁定输入。重试会核对同一条记录；也可关闭后重新读取。</p> : null}
      {removeConfirm ? <div className={styles.remove}><p>移除这条记录？任务和计划保持原样。</p><div className={styles.actions}><button className="paw-danger-btn" type="button" disabled={pending} onClick={() => void save(true)}>确认移除记录</button><button className="paw-secondary-btn" type="button" disabled={pending} onClick={() => setRemoveConfirm(false)}>保留记录</button></div></div> : <div className={styles.actions}><button className="paw-primary-btn" disabled={pending}>{pending ? "保存中…" : "保存记录"}</button><button type="button" className="paw-secondary-btn" disabled={pending} onClick={close}>取消</button>{previous ? <button type="button" className={styles.removeLink} disabled={pending || uncertain} onClick={() => setRemoveConfirm(true)}>移除记录</button> : null}</div>}
    </form>}
  </DialogSheet>;
}
