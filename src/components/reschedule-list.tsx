"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Segment = "morning" | "afternoon" | "evening";

export type Task = {
  id: string;
  title: string;
  date: string | null;
  daySegment: Segment;
  status: "todo" | "done" | "skipped" | "backlog";
  estimatedMinutes?: number;
};

const segmentLabels: Record<Segment, string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};

const weekdayChars = "日一二三四五六";

function shanghaiDateKey(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function todayKey() {
  return shanghaiDateKey(new Date().toISOString());
}

// 把 YYYY-MM-DD 当作纯日历日加减，避开时区漂移
function addDaysKey(key: string, delta: number) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function weekdayLabel(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `周${weekdayChars[dt.getUTCDay()]}`;
}

export function buildRescheduleGroups(tasks: Task[], today: string) {
  const upcoming = tasks
    .filter((t) => t.date && t.status === "todo")
    .map((t) => ({ ...t, key: shanghaiDateKey(t.date as string) }))
    .filter((t) => t.key >= today)
    .sort((a, b) => (a.key === b.key ? a.daySegment.localeCompare(b.daySegment) : a.key.localeCompare(b.key)));

  const byDate = new Map<string, Array<Task & { key: string }>>();
  for (const t of upcoming) {
    const arr = byDate.get(t.key) ?? [];
    arr.push(t);
    byDate.set(t.key, arr);
  }
  return [...byDate.entries()];
}

export function RescheduleList() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/tasks");
        if (!res.ok) throw new Error("读取任务失败");
        const data = (await res.json()) as { tasks: Task[] };
        if (active) setTasks(data.tasks ?? []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "读取任务失败");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const today = todayKey();

  // 只列今天及以后、还没做的任务，按日期分组
  const groups = useMemo(() => {
    return buildRescheduleGroups(tasks, today);
  }, [tasks, today]);

  async function patchTask(id: string, body: { date?: string; daySegment?: Segment }) {
    const prev = tasks;
    setSavingId(id);
    setTasks((curr) => curr.map((t) => (t.id === id ? { ...t, ...body } as Task : t)));
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "更新失败");
      }
      setToast("已更新");
    } catch (err) {
      setTasks(prev); // 回滚
      setToast(err instanceof Error ? err.message : "更新失败");
    } finally {
      setSavingId(null);
      window.setTimeout(() => setToast(null), 1800);
    }
  }

  function move(task: Task & { key: string }, delta: number) {
    const next = addDaysKey(task.key, delta);
    if (next < today) return; // 不能挪到今天之前
    void patchTask(task.id, { date: next });
  }

  if (loading) return <p className="paw-goal-meta">读取任务中…</p>;
  if (error) return <p className="paw-status-pill warn">{error}</p>;

  return (
    <div>
      <div className="paw-section-label">未来任务 · 直接改日期/时段，无需审核</div>

      {groups.length === 0 ? (
        <div className="paw-empty">
          <p>今天及以后没有待办任务。</p>
        </div>
      ) : null}

      {groups.map(([key, items]) => (
        <section key={key} className="mt-4">
          <h3 className="paw-task-tag mb-2">
            {key} · {weekdayLabel(key)}
          </h3>
          <div className="paw-task-list">
            {items.map((task) => (
              <article key={task.id} className="paw-task-card">
                <div className="paw-task-body">
                  <h4 className="paw-task-title">{task.title}</h4>
                  <div className="paw-task-meta">
                    <span className="paw-task-tag">{segmentLabels[task.daySegment]}</span>
                    {typeof task.estimatedMinutes === "number" ? <span>{task.estimatedMinutes}m</span> : null}
                  </div>
                </div>
                <div className="paw-task-actions flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => move(task, -1)}
                    disabled={savingId === task.id || task.key <= today}
                    className="paw-act-btn"
                    title="往前挪一天"
                  >
                    <ChevronLeft size={14} /> 往前
                  </button>
                  <button
                    type="button"
                    onClick={() => move(task, 1)}
                    disabled={savingId === task.id}
                    className="paw-act-btn"
                    title="往后挪一天"
                  >
                    往后 <ChevronRight size={14} />
                  </button>
                  <input
                    type="date"
                    value={task.key}
                    min={today}
                    onChange={(e) => {
                      if (e.target.value) void patchTask(task.id, { date: e.target.value });
                    }}
                    disabled={savingId === task.id}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700"
                    aria-label="改到具体日期"
                  />
                  <select
                    value={task.daySegment}
                    onChange={(e) => void patchTask(task.id, { daySegment: e.target.value as Segment })}
                    disabled={savingId === task.id}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700"
                    aria-label="改时段"
                  >
                    <option value="morning">上午</option>
                    <option value="afternoon">下午</option>
                    <option value="evening">晚上</option>
                  </select>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {toast ? (
        <p className="paw-toast" role="status">
          {toast}
        </p>
      ) : null}
    </div>
  );
}
