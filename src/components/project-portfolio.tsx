import { CalendarDays, CheckCircle2, ChevronDown, Clock3, Sparkles, Target } from "lucide-react";
import Link from "next/link";
import { PlanSectionNav } from "@/components/plan-section-nav";
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
  skipped: "旧记录",
};

const taskStatusLabels = { todo: "计划中", done: "已完成", skipped: "旧记录", backlog: "稍后处理" } as const;

function minutesLabel(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}

function completion(project: ProjectPortfolioItemView) {
  const included = project.taskCounts.todo + project.taskCounts.done;
  return included === 0 ? 0 : Math.round((project.taskCounts.done / included) * 100);
}

function ProjectCard({ project }: { project: ProjectPortfolioItemView }) {
  const openTasks = project.tasks.filter((task) => task.status === "todo" || task.status === "backlog");
  const nextTasks = openTasks.filter((task) => task.status === "todo").slice(0, 3);
  const nextMilestone = project.milestones.find(
    (milestone) => milestone.status === "planned" || milestone.status === "in_progress",
  );
  const progress = completion(project);

  return (
    <article className={`paw-project-card paw-project-card-compact ${project.needsDefinition ? "needs-definition" : ""}`}>
      <div className="paw-project-card-head">
        <span className="paw-project-color" style={{ background: project.color }} aria-hidden="true" />
        <div className="min-w-0">
          <div className="paw-project-badges">
            <span>{project.category ?? "类别待 AI 补充"}</span>
            <span>{statusLabels[project.status]}</span>
          </div>
          <h2>{project.name}</h2>
        </div>
      </div>

      <p className="paw-project-objective">{project.objective ?? "AI 尚未补充项目目标。"}</p>

      <div className="paw-project-meta-row">
        <span><CalendarDays size={13} /> {project.targetDate ? `目标 ${project.targetDate}` : "未设目标日期"}</span>
        {project.weeklyTargetMinutes === null ? null : (
          <span><Clock3 size={13} /> 每周 {minutesLabel(project.weeklyTargetMinutes)}</span>
        )}
        <span><CheckCircle2 size={13} /> {project.taskCounts.done}/{project.taskCounts.done + project.taskCounts.todo} 完成</span>
      </div>

      <div className="paw-project-progress" role="progressbar" aria-label={`${project.name} 完成度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="paw-project-counts">
        <span>计划中 {project.taskCounts.todo}</span>
        <span>稍后处理 {project.taskCounts.backlog}</span>
        <span>已完成 {project.taskCounts.done}</span>
        {project.taskCounts.skipped > 0 ? <span>旧任务待整理 {project.taskCounts.skipped}</span> : null}
      </div>

      {project.needsDefinition ? (
        <p className="paw-project-warning"><Sparkles size={14} /> 等待助手补充类别、目标和完成标准；修改会先进入审核。</p>
      ) : null}

      {nextMilestone || nextTasks.length > 0 ? (
        <div className="paw-project-next">
          {nextMilestone ? (
            <div>
              <small>下一个 Milestone</small>
              <strong>{nextMilestone.title}</strong>
              <span>{nextMilestone.targetDate ?? "未定日期"}</span>
            </div>
          ) : null}
          {nextTasks.map((task) => (
            <div key={task.id}>
              <small>下一步</small>
              <strong>{task.title}</strong>
              <span>{task.date ?? "未定日期"}</span>
            </div>
          ))}
        </div>
      ) : null}

      <details className="paw-project-details">
        <summary><ChevronDown size={15} /> 查看项目详情</summary>
        <div className="paw-project-definition">
          <section>
            <h3><Target size={14} /> 目标</h3>
            <p>{project.objective ?? "待 AI 补充"}</p>
          </section>
          <section>
            <h3><CheckCircle2 size={14} /> 完成标准</h3>
            <p>{project.successCriteria ?? "待 AI 补充"}</p>
          </section>
        </div>

        <section className="paw-project-milestones">
          <h3>Milestones</h3>
          {project.milestones.length === 0 ? <p className="muted">AI 尚未添加 Milestone。</p> : null}
          {project.milestones.map((milestone) => (
            <div key={milestone.id} className="paw-project-milestone">
              <span>{milestone.title}</span>
              <small>{milestoneStatusLabels[milestone.status]}{milestone.targetDate ? ` · ${milestone.targetDate}` : ""}</small>
            </div>
          ))}
        </section>

        <section className="paw-project-milestones">
          <h3>未完成任务</h3>
          {openTasks.length === 0 ? <p className="muted">没有计划中或稍后处理的任务。</p> : null}
          {openTasks.map((task) => (
            <div key={task.id} className="paw-project-milestone">
              <span>{task.parentTaskId ? "↳ " : ""}{task.title}</span>
              <small>{taskStatusLabels[task.status]} · {task.date ?? "未定日期"}</small>
            </div>
          ))}
        </section>
      </details>
    </article>
  );
}

export function ProjectPortfolio({ data }: { data: ProjectPortfolioViewData }) {
  const visibleProjects = data.projects.filter((project) => (
    project.status === "active" &&
    (
      !project.needsDefinition ||
      project.taskCounts.todo > 0 ||
      project.taskCounts.backlog > 0 ||
      project.milestones.some((milestone) => milestone.status === "planned" || milestone.status === "in_progress")
    )
  ));
  const legacyProjects = data.projects.filter((project) => !visibleProjects.some((visible) => visible.id === project.id));

  return (
    <div className="paw-page">
      <PlanSectionNav />
      <section className="paw-page-header paw-project-header">
        <div>
          <p className="paw-project-kicker">进行中的项目 · {visibleProjects.length}</p>
          <h1 className="paw-page-date">项目</h1>
          <p className="paw-project-intro">项目定义由助手维护；这里默认只展示目标、进度、下一里程碑和近期任务。</p>
        </div>
        <Link href="/review" className="paw-primary-btn"><Sparkles size={15} /> 查看 AI 建议</Link>
      </section>

      {data.dataUnavailable ? <p className="paw-status-pill warn">当前没有可用的数据源。</p> : null}

      {visibleProjects.length === 0 ? (
        <section className="paw-empty">
          <Sparkles size={28} />
          <h2>还没有整理好的进行中项目</h2>
          <p>助手补充项目定义或关联待办后，会先进入审核；批准后显示在这里。</p>
        </section>
      ) : (
        <div className="paw-project-grid">
          {visibleProjects.map((project) => <ProjectCard key={project.id} project={project} />)}
        </div>
      )}

      {legacyProjects.length > 0 ? (
        <details className="paw-project-legacy">
          <summary>查看待整理或历史项目 · {legacyProjects.length}</summary>
          <div className="paw-project-grid">
            {legacyProjects.map((project) => <ProjectCard key={project.id} project={project} />)}
          </div>
        </details>
      ) : null}
    </div>
  );
}
