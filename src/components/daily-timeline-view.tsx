"use client";

import { useState } from "react";
import Link from "next/link";
import { dailyTimelineArgsSchema, type DailyTimelineArgs, type TimelineFeedback } from "@/lib/planning/timeline-schema";
import type { buildDailyTimeline } from "@/lib/planning/daily-timeline";

type Result = ReturnType<typeof buildDailyTimeline>;
const localDate = (date: Date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const clock = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
const field = "rounded-lg border border-slate-300 p-2 text-slate-900 min-w-0";
const button = "rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-50";
const labels = { started: "开始", stuck: "卡住", completed: "完成", partial: "部分完成", paused: "暂停", timeout: "超时" };

function warningLabel(warning: string) {
  const [code, ...detail] = warning.split(":");
  const labels: Record<string, string> = {
    fixed_conflict: "固定安排冲突，请核对", backlog_fixed_conflict: "Backlog 时段与固定安排重叠，只能使用未冲突部分",
    backlog_capacity_shortfall: "Backlog 本轮预算放不下：保留剩余范围，查下一天容量后选择具体时段",
    deadline_capacity_shortfall: "截止前容量不足", dependency_unresolved: "前置范围尚未排完",
    meal_windows_missing: "请先保护吃饭时间", buffer_window_missing: "请留出机动与收口时间",
    commute_window_missing: "固定课表前后尚未设置通勤，请核对", untimed_routine: "固定习惯缺少具体时间，请补保护时段",
    active_fixed_conflict: "正在进行的学习与保护时段冲突，请确认是否暂停",
  };
  return `${labels[code] ?? code}${["fixed_conflict", "deadline_capacity_shortfall", "dependency_unresolved", "untimed_routine"].includes(code) ? `：${detail.join(":")}` : ""}`;
}

export function DailyTimelineView() {
  const [request, setRequest] = useState<DailyTimelineArgs>(() => dailyTimelineArgsSchema.parse({
    date: localDate(new Date()), start: "08:15", end: "21:30", now: new Date().toISOString(),
    protected_windows: [
      { start: "12:00", end: "13:00", title: "午餐（按真实安排调整）", kind: "meal" },
      { start: "18:00", end: "18:45", title: "晚餐", kind: "meal" },
      { start: "21:00", end: "21:30", title: "机动与收口", kind: "buffer" },
    ],
  }));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [actualStart, setActualStart] = useState("");
  const [remaining, setRemaining] = useState(30);
  const [checkpoint, setCheckpoint] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [evidence, setEvidence] = useState("");
  const [importText, setImportText] = useState("");
  const [backlogStart, setBacklogStart] = useState("10:40");
  const [backlogEnd, setBacklogEnd] = useState("11:20");
  const [backlogIds, setBacklogIds] = useState<string[]>([]);

  async function preview(next: DailyTimelineArgs, refresh = false) {
    setBusy(true); setError("");
    try {
      const updated = { ...next, now: new Date().toISOString(), expected_snapshot: refresh ? undefined : next.expected_snapshot };
      const response = await fetch("/api/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated) });
      const payload = await response.json();
      if (!response.ok) throw new Error(`${payload.code ?? ""} ${payload.error ?? "预览失败"}`);
      setResult(payload); setRequest({ ...updated, expected_snapshot: payload.snapshot, feedback: payload.feedback });
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败；未保存修改"); }
    finally { setBusy(false); }
  }
  function exportRequest() {
    const blob = new Blob([JSON.stringify(request, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `pawplan-timeline-${request.date}.json`; a.click(); URL.revokeObjectURL(url);
  }
  async function report(state: TimelineFeedback["state"]) {
    const task = result?.outcomes.find(t => t.task_id === selected);
    if (!task || !checkpoint.trim() || !nextStep.trim()) { setError("请选择任务，写下实际断点和唯一下一步。"); return; }
    const active = request.feedback.find(f => f.task_id === selected && f.state === "started");
    if (state === "started" && request.feedback.some(f => f.state === "started")) { setError("请先结束当前学习块，再开始另一块。"); return; }
    if (state !== "started" && !active && !actualStart) { setError("请填写实际开始时间，不使用计划时间代替。"); return; }
    const now = new Date().toISOString();
    const feedback: TimelineFeedback = {
      id: active?.id ?? crypto.randomUUID(), task_id: selected, expected_updated_at: task.expected_updated_at,
      state, started_at: active?.started_at ?? (state === "started" ? now : `${request.date}T${actualStart}:00+08:00`),
      ...(state === "started" ? {} : { ended_at: now }),
      remaining_minutes: state === "completed" ? 0 : remaining,
      checkpoint, next_step: nextStep, ...(evidence ? { evidence_ref: evidence } : {}),
    };
    await preview({ ...request, feedback: [...request.feedback.filter(f => f.id !== feedback.id), feedback] });
  }
  return <main className="mx-auto max-w-5xl space-y-5 p-4 text-slate-800">
    <Link href="/today" className="underline">返回今天</Link>
    <h1 className="text-2xl font-semibold">每日时间线</h1>
    <p>按实际时间重排。到点停下、留下断点；时间用完不代表范围完成。</p>
    <p className="rounded-xl bg-amber-50 p-3">这是执行预览，未修改 PawPlan。反馈暂存于当前页面，刷新前可导出续接；正式记录仍写入原学习大纲，并经 Review、批准、Apply、读回同步。此页面没有到点通知。</p>
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap gap-3">
        <label>日期（北京时间） <input className={field} type="date" value={request.date} onChange={e => setRequest({ ...request, date: e.target.value, expected_snapshot: undefined, feedback: [] })} /></label>
        <label>开始 <input className={field} type="time" value={request.start} onChange={e => setRequest({ ...request, start: e.target.value })} /></label>
        <label>收工 <input className={field} type="time" value={request.end} onChange={e => setRequest({ ...request, end: e.target.value })} /></label>
      </div>
      <h2 className="font-semibold">保护吃饭、通勤与机动时间</h2>
      {request.protected_windows.map((w, i) => <div key={i} className="flex flex-wrap gap-2">
        <input aria-label={`保护时段 ${i + 1} 名称`} className={field} value={w.title} onChange={e => setRequest({ ...request, protected_windows: request.protected_windows.map((v, j) => i === j ? { ...v, title: e.target.value } : v) })} />
        <select aria-label={`保护时段 ${i + 1} 类型`} className={field} value={w.kind} onChange={e => setRequest({ ...request, protected_windows: request.protected_windows.map((v, j) => i === j ? { ...v, kind: e.target.value as typeof w.kind } : v) })}>
          {Object.entries({ meal: "吃饭", commute: "通勤", rest: "休息", buffer: "机动", other: "其他" }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {(["start", "end"] as const).map(key => <input key={key} aria-label={`保护时段 ${i + 1} ${key}`} className={field} type="time" value={w[key]} onChange={e => setRequest({ ...request, protected_windows: request.protected_windows.map((v, j) => i === j ? { ...v, [key]: e.target.value } : v) })} />)}
        <button className={button} onClick={() => setRequest({ ...request, protected_windows: request.protected_windows.filter((_, j) => j !== i) })}>移除此时段</button>
      </div>)}
      <button className={button} onClick={() => setRequest({ ...request, protected_windows: [...request.protected_windows, { title: "通勤", start: "11:10", end: "11:30", kind: "commute" }] })}>添加保护时段</button>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => preview(request)}>生成 / 按现在重排</button><button className={button} disabled={busy} onClick={() => preview(request, true)}>重新读取变更后的 live 数据</button><button className={button} onClick={exportRequest}>导出续接 JSON</button></div>
    </section>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3">{error}</p>}
    {result && <>
      <section className="space-y-2 rounded-xl border p-4">
        <h2 className="font-semibold">剩余时间线 · {result.status === "needs_decision" ? "有冲突或未排范围" : "预览可用"}</h2>
        {result.warnings.map(w => <p key={w} className="break-words text-amber-800">{warningLabel(w)}</p>)}
        <ol className="space-y-2">{result.timeline.map((s, i) => <li key={i} className="rounded-lg bg-slate-50 p-3"><strong>{clock(s.start)}–{clock(s.end)} · {s.title}</strong><p className="whitespace-pre-wrap break-words">{s.scope}</p><p className="text-sm">{s.stop_condition}</p></li>)}</ol>
      </section>
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-semibold">任务范围、预算与截止</h2>
        <p>未排部分保留在下方。考试、作业或导师会前准备，填入已核对的截止与来源后优先安排。</p>
        {result.outcomes.map(t => {
          const option = request.task_options.find(o => o.task_id === t.task_id);
          const update = (patch: Partial<DailyTimelineArgs["task_options"][number]>) => setRequest({ ...request, task_options: [...request.task_options.filter(o => o.task_id !== t.task_id), { task_id: t.task_id, scope: t.scope || t.title, stop_condition: "到点记录实际断点与未覆盖范围", depends_on: [], ...option, ...patch }] });
          return <details key={t.task_id} className="rounded-lg border p-3"><summary>{t.title} · 已排 {t.allocated_minutes} 分钟 / 仍未排 {t.unallocated_minutes} 分钟</summary>
            <div className="mt-3 grid gap-2"><label>本轮预算 <input className={field} type="number" min="0" max="1440" value={option?.budget_minutes ?? t.remaining_minutes} onChange={e => update({ budget_minutes: Number(e.target.value) })} /></label>
            <label>本块范围 <textarea className={`${field} w-full`} value={option?.scope ?? t.scope ?? t.title} onChange={e => update({ scope: e.target.value })} /></label>
            <label>停止条件 <input className={`${field} w-full`} value={option?.stop_condition ?? "到点记录实际断点与未覆盖范围"} onChange={e => update({ stop_condition: e.target.value })} /></label>
            <label>截止（北京时间） <input className={field} type="datetime-local" value={option?.must_finish_by ? new Date(new Date(option.must_finish_by).getTime() + 8 * 3600000).toISOString().slice(0, 16) : ""} onChange={e => update({ must_finish_by: e.target.value ? `${e.target.value}:00+08:00` : undefined })} /></label>
            <label>截止来源 / 本人确认 <input className={`${field} w-full`} value={option?.deadline_reason ?? ""} onChange={e => update({ deadline_reason: e.target.value || undefined })} /></label>
            <p>实际耗时 {t.actual_minutes} 分钟；{t.feedback_state ? labels[t.feedback_state] : "尚未反馈"}。{t.checkpoint} → {t.next_step}</p></div>
          </details>;
        })}
        <button className={button} disabled={busy} onClick={() => preview(request)}>按以上范围与优先级重排</button>
      </section>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Backlog 固定时段</h2>
        <p>先核对旧范围与当前相关性，再选择少量卡片；同名只是疑似重复。</p>
        {result.backlog_triage.map(g => <div key={g.task_ids.join()}><p>{g.title}{g.duplicate_candidate ? " · 疑似重复，待核对" : ""}{g.stale_candidate ? " · 旧卡，待核对" : ""}</p>{g.task_ids.map(id => <label className="mr-3 inline-block" key={id}><input type="checkbox" checked={backlogIds.includes(id)} onChange={e => setBacklogIds(e.target.checked ? [...backlogIds, id] : backlogIds.filter(v => v !== id))} /> {id.slice(0, 8)}</label>)}</div>)}
        <label>起 <input className={field} type="time" value={backlogStart} onChange={e => setBacklogStart(e.target.value)} /></label> <label>止 <input className={field} type="time" value={backlogEnd} onChange={e => setBacklogEnd(e.target.value)} /></label>
        <button className={button} disabled={busy} onClick={() => preview({ ...request, backlog_windows: backlogIds.length ? [{ start: backlogStart, end: backlogEnd, task_ids: backlogIds }] : [] })}>按所选 backlog 预览</button>
      </section>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">反馈与续接</h2>
        <label className="block">任务 <select aria-label="任务" className={`${field} max-w-full`} value={selected} onChange={e => { setSelected(e.target.value); setRemaining(result.outcomes.find(t => t.task_id === e.target.value)?.remaining_minutes ?? 30); }}><option value="">选择任务</option>{result.outcomes.map(t => <option key={t.task_id} value={t.task_id}>{t.title}</option>)}</select></label>
        <label className="block">实际开始（补记时填写） <input className={field} type="time" value={actualStart} onChange={e => setActualStart(e.target.value)} /></label>
        <label className="block">还需约几分钟 <input className={field} type="number" min="1" max="1440" value={remaining} onChange={e => setRemaining(Number(e.target.value))} /></label>
        <label className="block">实际断点 / 当前页码题号 <input className={`${field} w-full`} value={checkpoint} onChange={e => setCheckpoint(e.target.value)} /></label>
        <label className="block">唯一下一步 <input className={`${field} w-full`} value={nextStep} onChange={e => setNextStep(e.target.value)} /></label>
        <label className="block">原学习记录 / 完成证据链接 <input className={`${field} w-full`} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2">{(Object.keys(labels) as TimelineFeedback["state"][]).map(state => <button className={button} key={state} disabled={busy} onClick={() => report(state)}>{labels[state]}</button>)}</div>
        <p>“完成”只表示本人报告，需要证据链接；不会自动更新任务状态或独立掌握。暂停后再次“开始”即可接续。</p>
      </section>
    </>}
    <details className="rounded-xl border p-4"><summary>从 Claude / Codex 续接 JSON 导入</summary><p>导入后先核对范围；旧任务版本会拒绝重放。JSON 可能含私人学习路径，请只交给你选择的助手。</p><textarea aria-label="续接 JSON" className={`${field} mt-2 h-40 w-full`} value={importText} onChange={e => setImportText(e.target.value)} /><button className={button} onClick={() => { try { const parsed = dailyTimelineArgsSchema.parse(JSON.parse(importText)); setRequest(parsed); setResult(null); setBacklogIds(parsed.backlog_windows.flatMap(w => w.task_ids)); setError(""); } catch { setError("JSON 格式不符，未替换当前请求。"); } }}>载入并检查</button></details>
  </main>;
}
