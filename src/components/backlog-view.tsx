import { Archive, Clock3, FolderKanban } from "lucide-react";
import { PlanSectionNav } from "@/components/plan-section-nav";
import { BacklogRescheduleControl } from "@/components/task-transition-controls";
import { LegacyTaskTriage } from "@/components/legacy-task-triage";
import type { LegacySkippedViewData } from "@/lib/planning/legacy-skipped";
import type { BacklogViewData } from "@/lib/planning/project-view-data";

const priorityLabels = { low: "低", normal: "普通", high: "高", urgent: "紧急" } as const;

function minutesLabel(minutes: number) {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function BacklogView({ data, legacySkipped }: { data: BacklogViewData; legacySkipped: LegacySkippedViewData }) {
  return (
    <div className="paw-page">
      <PlanSectionNav />
      <section className="paw-page-header paw-project-header">
        <div>
          <p className="paw-project-kicker">稍后处理 · {data.totalCount}</p>
          <h1 className="paw-page-date">稍后处理</h1>
          <p className="paw-project-intro">这里只保存你明确决定暂不排期的任务。为任务选择新日期后，它会重新成为“计划中”。</p>
        </div>
        <a href="/projects" className="paw-secondary-btn"><FolderKanban size={15} /> 查看 Projects</a>
      </section>

      {data.dataUnavailable ? <p className="paw-status-pill warn">当前没有可用的数据源。</p> : null}

      {data.totalCount === 0 ? (
        <section className="paw-empty">
          <Archive size={28} />
          <h2>稍后处理是空的</h2>
          <p>没有暂不排期的任务。</p>
        </section>
      ) : (
        <div className="paw-backlog-groups">
          {data.groups.map((group) => (
            <section key={group.projectId ?? "unassigned"} className="paw-backlog-group">
              <header>
                <span className="paw-project-color" style={{ background: group.color }} aria-hidden="true" />
                <div>
                  <h2>{group.projectName}</h2>
                  <p>{group.category ?? "未分类"} · {group.tasks.length} 条</p>
                </div>
              </header>
              <div className="paw-backlog-list">
                {group.tasks.map((task) => (
                  <article key={task.id} className="paw-backlog-task">
                    <div>
                      <h3>{task.title}</h3>
                      {task.notes ? <p>{task.notes}</p> : null}
                    </div>
                    <div className="paw-backlog-task-meta">
                      <span><Clock3 size={12} /> {minutesLabel(task.estimatedMinutes)}</span>
                      <span>优先级 {priorityLabels[task.priority]}</span>
                      <span>最近更新 {task.updatedLabel}</span>
                    </div>
                    <BacklogRescheduleControl taskId={task.id} />
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {legacySkipped.dataUnavailable ? (
        <p className="paw-status-pill warn">旧兼容任务暂时无法读取。</p>
      ) : legacySkipped.tasks.length > 0 ? (
        <LegacyTaskTriage tasks={legacySkipped.tasks} />
      ) : null}
    </div>
  );
}
