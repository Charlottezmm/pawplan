"use client";

import { CalendarDays, CheckCircle2, Clock3, Pencil, Plus, Target } from "lucide-react";
import { useState } from "react";
import type { ProjectPortfolioItemView, ProjectPortfolioViewData } from "@/lib/planning/project-view-data";

const statusLabels: Record<ProjectPortfolioItemView["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
};

const milestoneStatusLabels: Record<ProjectPortfolioItemView["milestones"][number]["status"], string> = {
  planned: "计划中",
  in_progress: "推进中",
  completed: "已完成",
  skipped: "已跳过",
};

const priorityLabels: Record<ProjectPortfolioItemView["priority"], string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};
const taskStatusLabels = { todo: "待办", done: "已完成", skipped: "已跳过", backlog: "已移出排期" } as const;
const temporaryProjectId = "__new_project__";

type ProjectDraft = {
  name: string;
  category: string;
  objective: string;
  successCriteria: string;
  status: ProjectPortfolioItemView["status"];
  priority: ProjectPortfolioItemView["priority"];
  startDate: string;
  targetDate: string;
  weeklyTargetMinutes: string;
};

function draftFromProject(project: ProjectPortfolioItemView): ProjectDraft {
  return {
    name: project.name,
    category: project.category ?? "",
    objective: project.objective ?? "",
    successCriteria: project.successCriteria ?? "",
    status: project.status,
    priority: project.priority,
    startDate: project.startDate ?? "",
    targetDate: project.targetDate ?? "",
    weeklyTargetMinutes: project.weeklyTargetMinutes?.toString() ?? "",
  };
}

function minutesLabel(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}

export function ProjectPortfolio({ data }: { data: ProjectPortfolioViewData }) {
  const [projectItems, setProjectItems] = useState(data.projects);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function startEditing(project: ProjectPortfolioItemView) {
    setProjectItems((items) => items.filter((item) => item.id !== temporaryProjectId));
    setEditingId(project.id);
    setDraft(draftFromProject(project));
    setMessage(null);
  }

  function startCreating() {
    if (saving) return;
    const placeholder: ProjectPortfolioItemView = {
      id: temporaryProjectId,
      name: "新 Project",
      color: "#71717a",
      category: null,
      objective: null,
      successCriteria: null,
      status: "active",
      priority: "normal",
      startDate: null,
      targetDate: null,
      weeklyTargetMinutes: null,
      needsDefinition: true,
      taskCounts: { todo: 0, done: 0, skipped: 0, backlog: 0 },
      tasks: [],
      milestones: [],
    };
    setProjectItems((items) => [placeholder, ...items.filter((item) => item.id !== temporaryProjectId)]);
    setEditingId(temporaryProjectId);
    setDraft(draftFromProject(placeholder));
    setMessage(null);
  }

  function cancelEditing() {
    if (editingId === temporaryProjectId) {
      setProjectItems((items) => items.filter((item) => item.id !== temporaryProjectId));
    }
    setEditingId(null);
    setDraft(null);
  }

  async function saveProject(event: React.FormEvent) {
    event.preventDefault();
    if (!editingId || !draft || saving) return;
    if (draft.status === "active" && (!draft.category.trim() || !draft.objective.trim() || !draft.successCriteria.trim())) {
      setMessage({ tone: "error", text: "进行中的 Project 必须填写类别、目标和完成标准。" });
      return;
    }

    setSaving(true);
    const isCreating = editingId === temporaryProjectId;
    const response = await fetch("/api/projects", {
      method: isCreating ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(isCreating ? {} : { id: editingId }),
        name: draft.name.trim(),
        category: draft.category.trim() || null,
        objective: draft.objective.trim() || null,
        successCriteria: draft.successCriteria.trim() || null,
        status: draft.status,
        priority: draft.priority,
        startDate: draft.startDate || null,
        targetDate: draft.targetDate || null,
        weeklyTargetMinutes: draft.weeklyTargetMinutes === "" ? null : Number(draft.weeklyTargetMinutes),
      }),
    });
    setSaving(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage({ tone: "error", text: body?.error ?? "保存失败，Project 未修改。" });
      return;
    }

    const body = (await response.json()) as { project: { id: string; color: string } };
    setProjectItems((items) =>
      items.map((project) =>
        project.id === editingId
          ? {
              ...project,
              id: body.project.id,
              color: body.project.color,
              name: draft.name.trim(),
              category: draft.category.trim() || null,
              objective: draft.objective.trim() || null,
              successCriteria: draft.successCriteria.trim() || null,
              status: draft.status,
              priority: draft.priority,
              startDate: draft.startDate || null,
              targetDate: draft.targetDate || null,
              weeklyTargetMinutes: draft.weeklyTargetMinutes === "" ? null : Number(draft.weeklyTargetMinutes),
              needsDefinition: !draft.category.trim() || !draft.objective.trim() || !draft.successCriteria.trim(),
            }
          : project,
      ),
    );
    setEditingId(null);
    setDraft(null);
    setMessage({ tone: "ok", text: isCreating ? "Project 已创建。" : "Project 定义已保存。" });
  }

  return (
    <div className="paw-page">
      <section className="paw-page-header paw-project-header">
        <div>
          <p className="paw-project-kicker">Project Portfolio</p>
          <h1 className="paw-page-date">项目组合</h1>
          <p className="paw-project-intro">每张卡片是一项具体 Project；类别说明它属于课程、科研或工作等领域，优先级用于解决项目之间的排期冲突。</p>
        </div>
        <div className="paw-project-header-actions">
          <button type="button" className="paw-primary-btn" onClick={startCreating} disabled={saving}>
            <Plus size={15} /> 新建 Project
          </button>
          <a href="/backlog" className="paw-secondary-btn">查看 Backlog</a>
        </div>
      </section>

      {data.dataUnavailable ? <p className="paw-status-pill warn">当前没有可用的数据源。</p> : null}
      {message ? <p className={`paw-task-action-feedback ${message.tone}`} role="status">{message.text}</p> : null}

      {projectItems.length === 0 ? (
        <section className="paw-empty">
          <h2>还没有 Project</h2>
          <p>创建具体项目后，它们会在这里按状态和优先级展示。</p>
        </section>
      ) : (
        <div className="paw-project-grid">
          {projectItems.map((project) => {
            const isEditing = project.id === editingId && draft;
            return (
              <article key={project.id} className={`paw-project-card ${project.needsDefinition ? "needs-definition" : ""}`}>
                <div className="paw-project-card-head">
                  <span className="paw-project-color" style={{ background: project.color }} aria-hidden="true" />
                  <div>
                    <div className="paw-project-badges">
                      <span>{project.category ?? "类别待补充"}</span>
                      <span>{statusLabels[project.status]}</span>
                      <span>优先级 {priorityLabels[project.priority]}</span>
                    </div>
                    <h2>{project.name}</h2>
                  </div>
                  <button type="button" className="paw-secondary-btn paw-project-edit" onClick={() => startEditing(project)}>
                    <Pencil size={14} /> 编辑定义
                  </button>
                </div>

                {project.needsDefinition ? <p className="paw-project-warning">这个旧 Project 仍待定义；系统不会猜测它的类别或目标。</p> : null}

                <div className="paw-project-definition">
                  <section>
                    <h3><Target size={14} /> 目标</h3>
                    <p>{project.objective ?? "待补充"}</p>
                  </section>
                  <section>
                    <h3><CheckCircle2 size={14} /> 完成标准</h3>
                    <p>{project.successCriteria ?? "待补充"}</p>
                  </section>
                </div>

                <div className="paw-project-meta-row">
                  <span><CalendarDays size={13} /> {project.startDate ?? "未设开始日期"} → {project.targetDate ?? "未设目标日期"}</span>
                  <span><Clock3 size={13} /> {project.weeklyTargetMinutes === null ? "未设每周最低投入" : `每周 ${minutesLabel(project.weeklyTargetMinutes)}`}</span>
                </div>

                <div className="paw-project-counts">
                  <span>待办 {project.taskCounts.todo}</span>
                  <span>完成 {project.taskCounts.done}</span>
                  <span>Backlog {project.taskCounts.backlog}</span>
                </div>

                <section className="paw-project-milestones">
                  <h3>Milestones</h3>
                  {project.milestones.length === 0 ? <p className="muted">还没有 Milestone。</p> : null}
                  {project.milestones.map((milestone) => (
                    <div key={milestone.id} className="paw-project-milestone">
                      <span>{milestone.title}</span>
                      <small>{milestoneStatusLabels[milestone.status]}{milestone.targetDate ? ` · ${milestone.targetDate}` : ""}</small>
                    </div>
                  ))}
                </section>

                <section className="paw-project-milestones">
                  <h3>Tasks / Subtasks</h3>
                  {project.tasks.length === 0 ? <p className="muted">还没有关联任务。</p> : null}
                  {project.tasks.map((task) => (
                    <div key={task.id} className="paw-project-milestone">
                      <span>{task.parentTaskId ? "↳ " : ""}{task.title}</span>
                      <small>
                        {task.parentTitle ? `属于 ${task.parentTitle} · ` : ""}
                        {task.milestoneTitle ? `${task.milestoneTitle} · ` : ""}
                        {taskStatusLabels[task.status]} · {task.date ?? "未定日期"}
                      </small>
                    </div>
                  ))}
                </section>

                {isEditing ? (
                  <form className="paw-project-form" onSubmit={saveProject}>
                    <div className="paw-project-form-grid">
                      <label>
                        <span>Project 名称</span>
                        <input className="paw-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
                      </label>
                      <label>
                        <span>类别</span>
                        <input className="paw-input" list="project-category-options" placeholder="课程/考试、科研、工作…" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} />
                      </label>
                      <label>
                        <span>状态</span>
                        <select className="paw-input" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as ProjectDraft["status"] })}>
                          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>优先级</span>
                        <select className="paw-input" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as ProjectDraft["priority"] })}>
                          {Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>开始日期</span>
                        <input type="date" className="paw-input" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} />
                      </label>
                      <label>
                        <span>目标日期</span>
                        <input type="date" className="paw-input" value={draft.targetDate} onChange={(event) => setDraft({ ...draft, targetDate: event.target.value })} />
                      </label>
                      <label>
                        <span>每周最低投入（分钟）</span>
                        <input type="number" min="0" max="10080" className="paw-input" value={draft.weeklyTargetMinutes} onChange={(event) => setDraft({ ...draft, weeklyTargetMinutes: event.target.value })} />
                      </label>
                    </div>
                    <label>
                      <span>目标</span>
                      <textarea className="paw-textarea" value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} rows={3} />
                    </label>
                    <label>
                      <span>完成标准</span>
                      <textarea className="paw-textarea" value={draft.successCriteria} onChange={(event) => setDraft({ ...draft, successCriteria: event.target.value })} rows={3} />
                    </label>
                    <div className="paw-modal-actions">
                      <button type="button" className="paw-secondary-btn" onClick={cancelEditing} disabled={saving}>取消</button>
                      <button type="submit" className="paw-primary-btn" disabled={saving}>{saving ? "保存中…" : editingId === temporaryProjectId ? "创建 Project" : "保存 Project"}</button>
                    </div>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      <datalist id="project-category-options">
        <option value="课程/考试" />
        <option value="科研" />
        <option value="工作" />
      </datalist>
    </div>
  );
}
