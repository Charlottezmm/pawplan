import { Archive, Clock3, FolderKanban } from "lucide-react";
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

export function BacklogView({ data }: { data: BacklogViewData }) {
  return (
    <div className="paw-page">
      <section className="paw-page-header paw-project-header">
        <div>
          <p className="paw-project-kicker">Backlog · {data.totalCount}</p>
          <h1 className="paw-page-date">已移出排期</h1>
          <p className="paw-project-intro">这里只保存你明确决定暂不排期的任务。逾期或普通延后的任务不会自动进入这里。</p>
        </div>
        <a href="/projects" className="paw-secondary-btn"><FolderKanban size={15} /> 查看 Projects</a>
      </section>

      {data.dataUnavailable ? <p className="paw-status-pill warn">当前没有可用的数据源。</p> : null}

      {data.totalCount === 0 ? (
        <section className="paw-empty">
          <Archive size={28} />
          <h2>Backlog 是空的</h2>
          <p>没有任务被移出排期。</p>
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
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
