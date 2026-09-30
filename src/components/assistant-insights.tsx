"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { DialogSheet } from "./ui/dialog-sheet";
import { Notice } from "./ui/notice";
import { localRecordValue, recordClock } from "@/lib/actual-records/display";
import { redactPrivateTitle } from "@/lib/display/privacy";
import { requestAssistant, type DurationReport, type RecommendationList } from "@/lib/client/assistant";
import type { RecordTaskChoice } from "./actual-records";
import styles from "./assistant-tools.module.css";
const energyLabel = { low: "低", medium: "中", high: "高" };
export function TodayAssistantEntry({ onRecord, onRecommend, saved }: { onRecord: () => void; onRecommend: () => void; saved: boolean }) {
  return <section className={styles.entry} aria-label="接着做"><div className={styles.entryCopy}><h2><Sparkles size={16} />接着做</h2><p>{saved ? "进展已保存，下次可以从这里接上。" : "记下进展，或按现在的时间与能量选一步。"}</p></div><div className={styles.actions}><button className="paw-secondary-btn" type="button" onClick={onRecord}>记录进展</button><button className="paw-primary-btn" type="button" onClick={onRecommend}>帮我选下一步<ArrowRight size={14} /></button></div></section>;
}
export function NextStepSheet({ onClose, onContinue }: { onClose: () => void; onContinue: (task: RecordTaskChoice) => void }) {
  const [start, setStart] = useState(() => localRecordValue(new Date().toISOString()));
  const [minutes, setMinutes] = useState("30"); const [energy, setEnergy] = useState<"low" | "medium" | "high">("medium");
  const [result, setResult] = useState<RecommendationList | null>(null); const [error, setError] = useState<string | null>(null); const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null); const inFlight = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  function change() { setResult(null); setError(null); }
  async function suggest() {
    if (inFlight.current) return;
    const at = Date.parse(`${start}:00+08:00`);
    if (!Number.isFinite(at) || !Number.isInteger(Number(minutes)) || Number(minutes) < 5 || Number(minutes) > 480) { setError("请选择有效开始时间和 5–480 分钟的可用时间。"); return; }
    inFlight.current = true; setPending(true); setError(null); setResult(null); controller.current = new AbortController();
    const signal = controller.current.signal;
    try {
      const value = await requestAssistant<RecommendationList>("recommend_next_tasks", { start_at: new Date(at).toISOString(), available_minutes: Number(minutes), energy_level: energy }, signal);
      if (!Array.isArray(value.recommendations) || value.mutationApplied !== false) throw new Error("建议结果暂时无法读取，请重试。");
      if (!signal.aborted) setResult(value);
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : "建议暂时无法读取，请重试。"); }
    finally { if (!signal.aborted) { inFlight.current = false; setPending(false); } }
  }
  return <DialogSheet open onClose={onClose} title="选一个下一步" description="从已有任务里找一件现在适合做的事。" variant="detail" className={styles.sheet}>
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void suggest(); }}>
      <label><span className="paw-field-label">开始时间（北京时间）</span><input className="paw-input" type="datetime-local" value={start} required disabled={pending} onChange={(e) => { setStart(e.target.value); change(); }} /></label>
      <div className={styles.fields}><label><span className="paw-field-label">可用时间（分钟）</span><input className="paw-input" type="number" min="5" max="480" step="1" value={minutes} required disabled={pending} onChange={(e) => { setMinutes(e.target.value); change(); }} /></label><label><span className="paw-field-label">现在的能量</span><select className="paw-input" value={energy} disabled={pending} onChange={(e) => { setEnergy(e.target.value as typeof energy); change(); }}><option value="low">低 · 想做点轻的</option><option value="medium">中 · 状态还行</option><option value="high">高 · 精力充足</option></select></label></div>
      <button className="paw-primary-btn" type="submit" disabled={pending}>{pending ? "正在核对任务与时段…" : "看看适合做什么"}</button>
    </form>
    {error ? <Notice tone="danger" title={error} /> : null}
    {pending ? <p className={styles.muted} role="status">正在读取安排和最近进展…</p> : null}
    {result ? <section className={styles.results} aria-label="下一步建议">
      {!result.recommendations.length ? <p className={styles.note}>这段时间没有合适的任务，可以换一个时间或先休息。</p> : result.recommendations.map((task) => <article key={task.taskId} className={styles.card}>
        <h3>{redactPrivateTitle(task.title)}</h3><p className={styles.muted}>约 {task.minutes} 分钟 · {energyLabel[task.energyRequired]}能量</p>
        {task.nextStep ? <p className={styles.delta}>接着做：{redactPrivateTitle(task.nextStep)}</p> : <p className={styles.muted}>还没有记录下一步，可以先留下一个小动作。</p>}
        <p className={styles.muted}>参考时段 {recordClock(task.suggestedStart)}–{recordClock(task.suggestedEnd)}</p>
        <div className={`${styles.actions} ${styles.footer}`}><button className="paw-secondary-btn" type="button" onClick={() => onContinue({ id: task.taskId, title: task.title })}>记录这项进展</button></div>
      </article>)}
      <p className={styles.muted}>建议没有排入计划。需要安排时，请到计划页核对容量和具体时段；用时与能量只是参考。</p>
      {result.continuationTruncated ? <p className={styles.muted}>最近进展较多，建议使用了部分记录。</p> : null}
      <Link href="/plan" className="paw-secondary-btn" onClick={onClose}>去计划页</Link>
    </section> : <p className={styles.muted}>已有任务、状态和日程保持原样。</p>}
  </DialogSheet>;
}
function duration(value: number | null, approximate = false) { return value === null ? "未知" : `${approximate ? "约 " : ""}${Number(value.toFixed(1))} 分钟`; }
export function PlanActualSheet({ day, today, onClose }: { day: string; today: string; onClose: () => void }) {
  const [from, setFrom] = useState(day); const [to, setTo] = useState(day);
  const [result, setResult] = useState<DurationReport | null>(null); const [error, setError] = useState<string | null>(null); const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null); const inFlight = useRef(false);
  async function compare(dateFrom = from, dateTo = to) {
    if (inFlight.current) return;
    const span = Date.parse(dateTo) - Date.parse(dateFrom);
    if (!dateFrom || !dateTo || !Number.isFinite(span) || span < 0 || span > 30 * 86400000 || dateTo > today) { setError("请选择有效日期，范围不超过 31 天，结束日期不晚于今天。"); return; }
    inFlight.current = true; setPending(true); setError(null); setResult(null); controller.current = new AbortController(); const signal = controller.current.signal;
    try {
      const value = await requestAssistant<DurationReport>("compare_plan_actual", { date_from: dateFrom, date_to: dateTo }, signal);
      if (!Array.isArray(value.comparisons)) throw new Error("对照结果暂时无法读取，请重试。");
      if (!signal.aborted) setResult(value);
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : "对照暂时无法读取，请重试。"); }
    finally { if (!signal.aborted) { inFlight.current = false; setPending(false); } }
  }
  useEffect(() => { void compare(day, day); return () => { controller.current?.abort(); inFlight.current = false; }; }, [day]);
  function change() { setResult(null); setError(null); }
  return <DialogSheet open onClose={onClose} title="计划与实际" description="只比较已记录的用时，留白也会保留下来。" variant="detail" className={styles.sheet}>
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void compare(); }}><div className={styles.fields}>
      <label><span className="paw-field-label">开始日期</span><input className="paw-input" type="date" value={from} max={today} required disabled={pending} onChange={(e) => { setFrom(e.target.value); change(); }} /></label>
      <label><span className="paw-field-label">结束日期</span><input className="paw-input" type="date" value={to} min={from} max={today} required disabled={pending} onChange={(e) => { setTo(e.target.value); change(); }} /></label>
    </div><button className="paw-primary-btn" type="submit" disabled={pending}>{pending ? "正在读取对照…" : "查看对照"}</button></form>
    {error ? <Notice tone="danger" title={error} /> : null}{pending ? <p className={styles.muted} role="status">正在核对计划与实际记录…</p> : null}
    {result ? <section className={styles.results} aria-label="用时对照结果">
      <p className={styles.note}>完成任务不代表记录了实际用时。没有记录的时间是未知，不是 0；已记录用时也可能缺少部分工作。</p>
      {result.truncated ? <Notice tone="warning" title="记录较多，对照只包含部分记录，暂不显示差值。" /> : null}
      {!result.comparisons.length ? <p className={styles.muted}>这段日期还没有可对照的任务与关联记录。</p> : result.comparisons.map((row) => <article className={styles.card} key={row.taskId}>
        <h3>{redactPrivateTitle(row.title)}</h3><div className={styles.metrics}>
          <p>当前估时<strong>{duration(row.currentEstimateMinutes)}</strong></p><p>记录时估时<strong>{duration(row.capturedEstimateMinutes)}</strong></p><p>已记录用时<strong>{duration(row.recordedMinutes, row.approximate)}</strong></p>
        </div>
        {row.recordedMinutes === null ? <p className={styles.delta}>尚未记录实际用时，暂不能比较。</p> : <>
          {row.observedDeltaMinutes !== null ? <p className={styles.delta}>{row.observedDeltaMinutes === 0 ? "已记录用时与记录时估时相同。" : `已记录比记录时估时${row.observedDeltaMinutes > 0 ? "多" : "少"} ${Number(Math.abs(row.observedDeltaMinutes).toFixed(1))} 分钟。`}</p> : <p className={styles.delta}>记录时的估时缺失、不一致，或只记录了部分时段，暂不比较差值。</p>}
          <p className={styles.muted}>{row.recordCount} 段记录{row.approximate ? " · 时间为大致估计" : ""}{row.overlappingRecords ? " · 重叠时段已合并" : ""}{row.boundaryClipped ? " · 仅计入所选日期内的时段" : ""}</p>
        </>}
      </article>)}
      {result.unlinkedRecordCount ? <p className={styles.muted}>另有 {result.unlinkedRecordCount} 段未关联任务的记录，未参与任务差值比较。</p> : null}
      <p className={styles.muted}>记录时估时是记下实际经历时的计划，不一定是最初的计划。当前估时单独显示；这里只做观察，不据此评判效率。</p>
    </section> : null}
  </DialogSheet>;
}
