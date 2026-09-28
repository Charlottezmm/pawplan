"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Search, Unlink } from "lucide-react";
import type { RecordTaskChoice } from "./actual-records";
import styles from "./actual-records.module.css";

export function RecordTaskPicker({ tasks, selectedId, onSelect, onBack }: {
  tasks: RecordTaskChoice[]; selectedId: string; onSelect: (task: RecordTaskChoice | null) => void; onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const items = tasks.filter((task) => task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className={styles.picker}>
    <button type="button" className={styles.back} onClick={onBack}><ArrowLeft size={16} />返回记录</button>
    <div className={styles.search}><Search size={17} aria-hidden="true" /><input ref={input} aria-label="搜索关联任务" placeholder="搜索今日任务" value={query} maxLength={240} onChange={(e) => setQuery(e.target.value)} /></div>
    <p className={styles.meta}>仅显示今天安排的任务 · 包括今天已完成的任务</p>
    <button type="button" className={styles.taskOption} aria-pressed={!selectedId} onClick={() => onSelect(null)}><Unlink size={17} /><span><strong>不关联任务</strong><small>散步、睡觉等，也可以直接记录</small></span>{!selectedId && <Check size={17} />}</button>
    <div className={styles.taskResults} aria-label="可关联任务">
      {items.map((task) => <button type="button" key={task.id} className={styles.taskOption} aria-pressed={selectedId === task.id} onClick={() => onSelect(task)}><span><strong>{task.title}</strong><small>今天 · {task.status === "done" ? "已完成" : task.status === "blocked" ? "受阻" : "未完成"}</small></span>{selectedId === task.id && <Check size={17} />}</button>)}
      {items.length === 0 ? <p className={styles.empty} role="status">{tasks.length === 0 ? "今天还没有安排任务，可以不关联任务直接记录。" : "没有匹配的今日任务，试试其他关键词。"}</p> : null}
    </div>
  </div>;
}
