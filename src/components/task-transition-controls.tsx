"use client";

import { CalendarPlus, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "./ui/confirm-dialog";

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

export function TaskDeleteControl({
  taskId,
  title,
  compact = false,
  onDeleted,
}: {
  taskId: string;
  title: string;
  compact?: boolean;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempt = useRef<{ idempotencyKey: string; operationId: string } | null>(null);

  async function permanentlyDelete() {
    setPending(true);
    setMessage(null);
    attempt.current ??= {
      idempotencyKey: operationKey("task-delete"),
      operationId: crypto.randomUUID(),
    };
    try {
      const response = await fetch("/api/tasks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          confirmation: "PERMANENT_DELETE",
          ...attempt.current,
        }),
      });
      const result = await response.json().catch(() => null) as { error?: string; verified?: boolean } | null;
      if (!response.ok || !result?.verified) throw new Error(result?.error ?? "删除结果无法确认");
      attempt.current = null;
      setOpen(false);
      onDeleted?.();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败，卡片仍保持原状");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className={compact ? "paw-act-btn delete" : "paw-secondary-btn paw-delete-task-btn"}
        type="button"
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}
        disabled={pending}
      >
        <Trash2 size={14} /> 永久删除
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        onConfirm={() => void permanentlyDelete()}
        title="永久删除这张卡片？"
        description={`“${title}”会从 PawPlan 永久删除。`}
        confirmLabel="确认永久删除"
        pending={pending}
        destructive
      >
        <p>这是不可恢复操作；普通的“移出排期”仍会把任务保留在稍后处理。</p>
        {message ? <p className="paw-danger-text mt-2" role="alert">{message}</p> : null}
      </ConfirmDialog>
    </>
  );
}
