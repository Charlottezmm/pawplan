"use client";

import type { FormEvent } from "react";
import { useState } from "react";

export function QuickCapture() {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setStatus("saving");
    try {
      const response = await fetch("/api/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!response.ok) throw new Error("Unable to save inbox item");
      const data = (await response.json()) as { item?: { id: string; title: string } };
      if (data.item) {
        window.dispatchEvent(new CustomEvent("inbox:item-created", { detail: data.item }));
      }
      setTitle("");
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 1200);
    } catch {
      setStatus("error");
    }
  }

  return (
    <form onSubmit={submit} className="quick-capture" aria-label="快速收集">
      <span className="quick-capture-icon" aria-hidden="true">
        +
      </span>
      <input
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          if (status !== "saving") setStatus("idle");
        }}
        placeholder="记一条想法…"
        className="quick-capture-input"
      />
      <span className="quick-capture-status" data-status={status} aria-live="polite">
        {status === "saving" ? "保存中" : null}
        {status === "saved" ? "已添加" : null}
        {status === "error" ? "重试" : null}
      </span>
      <button disabled={!title.trim() || status === "saving"} className="quick-capture-button">
        {status === "saving" ? "添加中" : "添加"}
      </button>
    </form>
  );
}
