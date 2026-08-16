"use client";

import { CalendarPlus, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type ApiError = { error?: { message?: string } };

function operationKey(prefix: string) {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

async function postTransition(body: Record<string, unknown>) {
  const response = await fetch("/api/tasks/transitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as ApiError;
  if (!response.ok) throw new Error(result.error?.message ?? "任务更新失败，请稍后重试");
  return result;
}

export function BacklogRescheduleControl({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!date) {
      setMessage("请先选择一个明确日期");
      return;
    }
    setPending(true);
    setMessage(null);
    attemptKey.current ??= operationKey("backlog-reschedule");
    try {
      await postTransition({
        action: "reschedule_backlog",
        taskId,
        date,
        idempotencyKey: attemptKey.current,
      });
      attemptKey.current = null;
      setMessage("已重新加入计划");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重新排期失败，任务保持原状");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="paw-task-transition" onSubmit={submit}>
      <label>
        <span>新日期</span>
        <input
          className="paw-input"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          disabled={pending}
          required
          aria-label="选择重新排期日期"
        />
      </label>
      <button className="paw-primary-btn" type="submit" disabled={pending || !date}>
        <CalendarPlus size={14} /> {pending ? "保存中…" : "重新排期"}
      </button>
      {message ? <span className="paw-task-transition-message" role="status">{message}</span> : null}
    </form>
  );
}

export function ArchiveRestoreControl({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);

  async function restore() {
    setPending(true);
    setMessage(null);
    attemptKey.current ??= operationKey("archive-restore");
    try {
      await postTransition({
        action: "restore_archived_to_backlog",
        taskId,
        expectedArchived: true,
        idempotencyKey: attemptKey.current,
      });
      attemptKey.current = null;
      setMessage("已恢复到稍后处理");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复失败，归档任务保持原状");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="paw-task-transition">
      <button className="paw-secondary-btn" type="button" onClick={() => void restore()} disabled={pending}>
        <RotateCcw size={14} /> {pending ? "恢复中…" : "恢复到稍后处理"}
      </button>
      {message ? <span className="paw-task-transition-message" role="status">{message}</span> : null}
    </div>
  );
}

export function LegacySkippedRestoreControl({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attemptKey = useRef<string | null>(null);

  async function restore() {
    setPending(true);
    setMessage(null);
    attemptKey.current ??= operationKey("legacy-skipped-restore");
    try {
      await postTransition({
        action: "move_legacy_skipped_to_backlog",
        taskId,
        expectedStatus: "skipped",
        idempotencyKey: attemptKey.current,
      });
      attemptKey.current = null;
      setMessage("已加入稍后处理");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复失败，任务保持原状");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="paw-task-transition">
      <button className="paw-secondary-btn" type="button" onClick={() => void restore()} disabled={pending}>
        <RotateCcw size={14} /> {pending ? "处理中…" : "加入稍后处理"}
      </button>
      {message ? <span className="paw-task-transition-message" role="status">{message}</span> : null}
    </div>
  );
}
