"use client";
import { useEffect, useRef, useState } from "react";
import { DialogSheet } from "./ui/dialog-sheet";
import { Notice } from "./ui/notice";
import { redactPrivateTitle } from "@/lib/display/privacy";
import { AssistantRequestError, requestAssistant, verifyContinuationSave, type AssistantPreview, type AssistantSave, type ContinuationList, type ContinuationRecord, type ProgressContent } from "@/lib/client/assistant";
import type { RecordTaskChoice } from "./actual-records";
import styles from "./assistant-tools.module.css";

export const continuationChanged = "pawplan:continuation-changed";
const energyLabel = { low: "低", medium: "中", high: "高" };
function ProgressSummary({ content }: { content: ProgressContent }) {
  return <dl><div><dt>做到哪里</dt><dd>{redactPrivateTitle(content.progress)}</dd></div>
    <div><dt>卡点</dt><dd>{content.blockers.length ? content.blockers.map(redactPrivateTitle).join("\n") : "这次没有记录卡点"}</dd></div>
    <div><dt>下一步</dt><dd>{redactPrivateTitle(content.next_step)}</dd></div>
    {content.remaining_minutes || content.energy_required ? <div><dt>接着做的参考</dt><dd>{content.remaining_minutes ? `剩余约 ${content.remaining_minutes} 分钟` : "剩余用时未填写"}{content.energy_required ? ` · ${energyLabel[content.energy_required]}能量` : ""}</dd></div> : null}
  </dl>;
}
export function ContinuationSheet({ target, tasks, onClose, onSaved }: { target: RecordTaskChoice | null; tasks: RecordTaskChoice[]; onClose: () => void; onSaved?: () => void }) {
  const [taskId, setTaskId] = useState(target?.id ?? "");
  const choices = target && !tasks.some((task) => task.id === target.id) ? [target, ...tasks] : tasks;
  const selected = choices.find((task) => task.id === taskId);
  const [progress, setProgress] = useState(""); const [blockers, setBlockers] = useState(""); const [next, setNext] = useState("");
  const [remaining, setRemaining] = useState(""); const [energy, setEnergy] = useState<"" | "low" | "medium" | "high">("");
  const [preview, setPreview] = useState<AssistantPreview | null>(null); const [saved, setSaved] = useState<ContinuationRecord | null>(null);
  const [pending, setPending] = useState(false); const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null); const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const progressRef = useRef<HTMLTextAreaElement>(null);
  const [history, setHistory] = useState<ContinuationList | null>(null); const [historyError, setHistoryError] = useState(false); const [historyLoading, setHistoryLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setHistory(null); setHistoryError(false); setHistoryLoading(true);
    requestAssistant<ContinuationList>("get_continuation", { ...(taskId ? { task_id: taskId } : {}), limit: 10 }, controller.signal)
      .then((result) => { if (!Array.isArray(result.records)) throw new Error(); if (!controller.signal.aborted) setHistory(result); })
      .catch(() => { if (!controller.signal.aborted) setHistoryError(true); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [taskId, version]);
  async function propose() {
    if (inFlight.current) return;
    const lines = blockers.split("\n").map((value) => value.trim()).filter(Boolean);
    if (!progress.trim() || !next.trim() || lines.length > 20 || (remaining && (!Number.isInteger(Number(remaining)) || Number(remaining) < 1 || Number(remaining) > 480))) {
      setError("请填写进展和下一步；卡点最多 20 条，剩余用时为 1–480 分钟。"); return;
    }
    const change: ProgressContent = { action: "save_continuation", ...(taskId ? { task_id: taskId } : {}), progress: progress.trim(), blockers: lines, next_step: next.trim(),
      ...(remaining ? { remaining_minutes: Number(remaining) } : {}), ...(energy ? { energy_required: energy } : {}), evidence: [] };
    const fingerprint = JSON.stringify(change);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
    inFlight.current = true; setPending(true); setError(null);
    try {
      const result = await requestAssistant<AssistantPreview>("preview_assistant_change", { change, idempotency_key: attempt.current.key });
      if (!result.draftId || result.draftStatus !== "preview" || !result.liveUnchanged || result.change?.action !== "save_continuation") throw new AssistantRequestError("暂未取得有效预览，请重试。", true);
      setPreview(result); setUncertain(false);
    } catch (e) { setUncertain(e instanceof AssistantRequestError && e.uncertain); setError(e instanceof Error ? e.message : "暂时无法预览，请重试。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  async function confirm() {
    if (!preview || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const result = await requestAssistant<AssistantSave>("confirm_assistant_change", { draft_id: preview.draftId, confirmation: "USER_CONFIRMED", user_instruction: "用户在 PawPlan 进展预览中点击确认保存，保存所显示的这条进展记录。" });
      const row = verifyContinuationSave(result, preview);
      setSaved(row); setPreview(null); setUncertain(false); setVersion((value) => value + 1);
      window.dispatchEvent(new Event(continuationChanged)); onSaved?.();
    } catch (e) { setUncertain(e instanceof AssistantRequestError && e.uncertain); setError(e instanceof Error ? e.message : "保存结果暂未核对，请重试。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  function edit() { setPreview(null); setUncertain(false); setError(null); attempt.current = null; }
  function again() { setSaved(null); setProgress(""); setBlockers(""); setNext(""); setRemaining(""); setEnergy(""); edit(); }
  return <DialogSheet open onClose={onClose} title={saved ? "进展已保存" : preview ? "确认这条进展" : "记录进展"} description={selected ? redactPrivateTitle(selected.title) : "把这次做到哪里、卡点和下一步留下来。"} variant="detail" className={styles.sheet} initialFocusRef={progressRef} closeDisabled={pending}>
    {saved ? <><Notice tone="success" title="已保存并核对这条进展。任务状态和排期保持原样。" /><div className={styles.card}><ProgressSummary content={saved.content} /></div><div className={`${styles.actions} ${styles.footer}`}><button className="paw-secondary-btn" type="button" onClick={again}>再记一条</button><button className="paw-primary-btn" type="button" onClick={onClose}>完成</button></div></>
      : preview ? <><p className={styles.note}>确认后只保存进展记录，不会完成任务或调整排期。</p><div className={styles.card}><ProgressSummary content={preview.change} /></div>
        {error ? <Notice tone="danger" title={error} /> : null}{uncertain ? <p className={styles.muted}>重试会核对同一条记录。也可以关闭后重新读取最近进展。</p> : null}
        <div className={`${styles.actions} ${styles.footer}`}><button className="paw-secondary-btn" type="button" onClick={edit} disabled={pending || uncertain}>返回修改</button><button className="paw-secondary-btn" type="button" onClick={onClose} disabled={pending}>取消</button><button className="paw-primary-btn" type="button" onClick={() => void confirm()} disabled={pending}>{pending ? "保存并核对中…" : uncertain ? "重试确认并核对" : "确认保存进展"}</button></div></>
      : <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void propose(); }}>
        <label><span className="paw-field-label">关联任务</span><select className="paw-input" value={taskId} disabled={pending || uncertain} onChange={(e) => setTaskId(e.target.value)}><option value="">不关联任务</option>{choices.map((task) => <option key={task.id} value={task.id}>{redactPrivateTitle(task.title)}</option>)}</select></label>
        <label><span className="paw-field-label">做到哪里</span><textarea ref={progressRef} className="paw-input" value={progress} onChange={(e) => setProgress(e.target.value)} maxLength={4000} required disabled={pending || uncertain} placeholder="例如：第一节已整理，第二节还在核对" /></label>
        <label><span className="paw-field-label">卡点（可选，一行一条）</span><textarea className="paw-input" value={blockers} onChange={(e) => setBlockers(e.target.value)} maxLength={4000} disabled={pending || uncertain} placeholder="没有卡点可以留空" /></label>
        <label><span className="paw-field-label">下一步</span><textarea className="paw-input" value={next} onChange={(e) => setNext(e.target.value)} maxLength={4000} required disabled={pending || uncertain} placeholder="留下下一次能直接开始的小动作" /></label>
        <div className={styles.fields}><label><span className="paw-field-label">剩余用时（分钟，可选）</span><input className="paw-input" type="number" min="1" max="480" step="1" value={remaining} onChange={(e) => setRemaining(e.target.value)} disabled={pending || uncertain} /></label><label><span className="paw-field-label">需要的能量（可选）</span><select className="paw-input" value={energy} onChange={(e) => setEnergy(e.target.value as typeof energy)} disabled={pending || uncertain}><option value="">暂不填写</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label></div>
        <p className={styles.muted}>这是一条进展记录，不会自动改动任务状态或日程。</p>{error ? <Notice tone="danger" title={error} /> : null}
        <div className={`${styles.actions} ${styles.footer}`}><button className="paw-secondary-btn" type="button" onClick={onClose} disabled={pending}>取消</button>{uncertain ? <button className="paw-secondary-btn" type="button" onClick={edit} disabled={pending}>返回修改</button> : null}<button className="paw-primary-btn" type="submit" disabled={pending}>{pending ? "正在准备预览…" : uncertain ? "重试预览" : "预览进展"}</button></div>
      </form>}
    {!preview && !saved ? <section className={styles.history} aria-label="最近进展"><h3>{taskId ? "这项任务的最近进展" : "最近进展"}</h3>
      {historyLoading ? <p className={styles.muted} role="status">正在读取进展…</p> : historyError ? <><Notice tone="danger" title="最近进展暂时无法读取。" /><button type="button" className="paw-secondary-btn" onClick={() => setVersion((value) => value + 1)}>重试读取进展</button></>
        : !history?.records.filter((record) => record.kind === "progress").length ? <p className={styles.muted}>最近记录中还没有进展条目，可以从这次开始。</p>
        : history.records.filter((record) => record.kind === "progress").map((record) => <div className={styles.card} key={record.id}><p className={styles.muted}>{new Date(record.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p><ProgressSummary content={record.content} /></div>)}
      {history?.truncated ? <p className={styles.muted}>这里只显示最近 10 条记录。</p> : null}
    </section> : null}
  </DialogSheet>;
}
