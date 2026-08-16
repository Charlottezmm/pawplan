"use client";

import { Archive, Check, ChevronDown, Clock3, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { LegacySkippedViewData } from "@/lib/planning/legacy-skipped";

type Decision = "backlog" | "archive";
type Task = LegacySkippedViewData["tasks"][number];
type ApiResult = {
  error?: { message?: string };
  movedToBacklog?: { count: number };
  archived?: { count: number };
};

function operationKey() {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `legacy-triage-${id}`;
}

function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function groupTasks(tasks: Task[]) {
  const groups = new Map<string, { projectId: string | null; name: string; color: string; tasks: Task[] }>();
  tasks.forEach((task) => {
    const key = task.projectId ?? "unassigned";
    const group = groups.get(key) ?? {
      projectId: task.projectId,
      name: task.projectName,
      color: task.projectColor,
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(key, group);
  });
  return [...groups.values()].sort((left, right) => {
    if (left.projectId === null) return 1;
    if (right.projectId === null) return -1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

export function LegacyTaskTriage({ tasks }: { tasks: Task[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleGroups = useMemo(() => groupTasks(tasks.filter((task) => {
    if (!normalizedQuery) return true;
    return `${task.title} ${task.projectName}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  })), [normalizedQuery, tasks]);
  const selectedTasks = tasks.filter((task) => decisions[task.id]);
  const backlogTasks = selectedTasks.filter((task) => decisions[task.id] === "backlog");
  const archivedTasks = selectedTasks.filter((task) => decisions[task.id] === "archive");

  function choose(taskId: string, decision: Decision) {
    setReviewing(false);
    setMessage(null);
    attemptKey.current = null;
    setDecisions((current) => {
      if (current[taskId] === decision) {
        const next = { ...current };
        delete next[taskId];
        return next;
      }
      return { ...current, [taskId]: decision };
    });
  }

  async function applyDecisions() {
    if (selectedTasks.length === 0) return;
    setPending(true);
    setMessage(null);
    attemptKey.current ??= operationKey();
    try {
      const response = await fetch("/api/tasks/transitions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "triage_legacy_skipped_tasks",
          decisions: selectedTasks.map((task) => ({ taskId: task.id, decision: decisions[task.id] })),
          confirmCount: selectedTasks.length,
          idempotencyKey: attemptKey.current,
        }),
      });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok) throw new Error(result.error?.message ?? "整理失败，任务保持原样");
      setMessage(`已整理 ${selectedTasks.length} 条：${result.movedToBacklog?.count ?? 0} 条进入稍后处理，${result.archived?.count ?? 0} 条归档`);
      setDecisions({});
      setReviewing(false);
      attemptKey.current = null;
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "整理失败，任务保持原样");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="paw-legacy-triage">
      <header className="paw-legacy-triage-header">
        <div>
          <p className="paw-project-kicker">待整理 · {tasks.length}</p>
          <h2>以前清理的任务</h2>
          <p>逐条选择“还要做”或“不做了”。没有选择的任务会继续留在这里，不会被改动。</p>
        </div>
        <label className="paw-legacy-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务或项目"
            aria-label="搜索以前清理的任务"
          />
        </label>
      </header>

      {visibleGroups.length === 0 ? (
        <p className="paw-legacy-no-results">没有匹配的旧任务。</p>
      ) : (
        <div className="paw-legacy-groups">
          {visibleGroups.map((group) => {
            const decidedCount = group.tasks.filter((task) => decisions[task.id]).length;
            return (
              <details key={group.projectId ?? "unassigned"} className="paw-legacy-group" open={normalizedQuery ? true : undefined}>
                <summary>
                  <span className="paw-project-color" style={{ background: group.color }} aria-hidden="true" />
                  <span className="paw-legacy-group-name">{group.name}</span>
                  <span>{decidedCount > 0 ? `已判断 ${decidedCount} / ` : ""}{group.tasks.length} 条</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </summary>
                <div className="paw-legacy-task-list">
                  {group.tasks.map((task) => {
                    const decision = decisions[task.id];
                    return (
                      <article key={task.id} className={`paw-legacy-task${decision ? ` is-${decision}` : ""}`}>
                        <div className="paw-legacy-task-copy">
                          <h3>{task.title}</h3>
                          <p>原日期 {task.date} <span>·</span> <Clock3 size={12} /> {minutesLabel(task.estimatedMinutes)}</p>
                        </div>
                        <div className="paw-legacy-task-actions" aria-label={`整理 ${task.title}`}>
                          <button
                            type="button"
                            className="paw-legacy-decision keep"
                            aria-pressed={decision === "backlog"}
                            onClick={() => choose(task.id, "backlog")}
                          >
                            <Check size={14} /> 还要做
                          </button>
                          <button
                            type="button"
                            className="paw-legacy-decision archive"
                            aria-pressed={decision === "archive"}
                            onClick={() => choose(task.id, "archive")}
                          >
                            <Archive size={14} /> 不做了
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {selectedTasks.length > 0 && !reviewing ? (
        <div className="paw-legacy-triage-bar">
          <div>
            <strong>已判断 {selectedTasks.length} 条</strong>
            <span>还要做 {backlogTasks.length} · 归档 {archivedTasks.length}</span>
          </div>
          <button className="paw-primary-btn" type="button" onClick={() => setReviewing(true)} disabled={pending}>
            检查并确认
          </button>
        </div>
      ) : null}

      {reviewing ? (
        <div className="paw-legacy-confirm-backdrop">
          <section className="paw-legacy-confirm" role="dialog" aria-modal="true" aria-label="确认整理旧任务">
            <div>
              <p className="paw-project-kicker">应用前确认</p>
              <h3>整理这 {selectedTasks.length} 条任务？</h3>
              <p>{backlogTasks.length} 条会进入“稍后处理”，{archivedTasks.length} 条会进入“归档”。其余 {tasks.length - selectedTasks.length} 条保持原样。</p>
            </div>
            <details>
              <summary>查看本次任务标题</summary>
              <ul>
                {selectedTasks.map((task) => (
                  <li key={task.id}><strong>{decisions[task.id] === "backlog" ? "还要做" : "归档"}</strong>{task.title}</li>
                ))}
              </ul>
            </details>
            <div className="paw-legacy-confirm-actions">
              <button className="paw-secondary-btn" type="button" onClick={() => setReviewing(false)} disabled={pending}>返回修改</button>
              <button className="paw-primary-btn" type="button" onClick={() => void applyDecisions()} disabled={pending}>
                {pending ? "正在整理…" : `确认整理 ${selectedTasks.length} 条`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {message ? <p className="paw-legacy-triage-message" role="status">{message}</p> : null}
    </section>
  );
}
