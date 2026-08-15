import { Archive, Clock3, FolderKanban } from "lucide-react";
import type { ArchiveHistoryViewData } from "@/lib/planning/project-view-data";

const statusLabels = { todo: "待办", done: "已完成", skipped: "已跳过", backlog: "Backlog" } as const;

function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function ArchiveHistoryView({ data }: { data: ArchiveHistoryViewData }) {
  return (
    <div className="paw-page">
      <section className="paw-page-header paw-project-header">
        <div>
          <p className="paw-project-kicker">Archive · {data.totalCount}</p>
          <h1 className="paw-page-date">历史归档</h1>
          <p className="paw-project-intro">
            归档任务已退出当前计划，但仍保留原来的待办、完成、跳过或 Backlog 状态，可以通过 MCP 精确恢复。
          </p>
        </div>
        <a href="/projects" className="paw-secondary-btn"><FolderKanban size={15} /> 查看 Projects</a>
      </section>

      <form method="get" className="paw-project-form">
        <label>
          <span>状态</span>
          <select className="paw-input" name="status" defaultValue={data.filters.status ?? ""}>
            <option value="">全部状态</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Project</span>
          <select className="paw-input" name="project_id" defaultValue={data.filters.projectId ?? ""}>
            <option value="">全部 Projects</option>
            {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label>
          <span>日期从</span>
          <input className="paw-input" type="date" name="date_from" defaultValue={data.filters.dateFrom ?? ""} />
        </label>
        <label>
          <span>日期到（不含）</span>
          <input className="paw-input" type="date" name="date_to" defaultValue={data.filters.dateTo ?? ""} />
        </label>
        <button type="submit" className="paw-secondary-btn">筛选</button>
        <a href="/archive" className="paw-secondary-btn">清除</a>
      </form>

      {data.dataUnavailable ? <p className="paw-status-pill warn">当前没有可用的数据源。</p> : null}

      {data.totalCount === 0 ? (
        <section className="paw-empty">
          <Archive size={28} />
          <h2>没有匹配的归档任务</h2>
          <p>归档后，任务会在这里保留历史并可恢复。</p>
        </section>
      ) : (
        <>
          <p className="paw-status-pill">共 {data.totalCount} 条 · {minutesLabel(data.totalMinutes)}</p>
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
                        <p>{statusLabels[task.status]} · 原日期 {task.date ?? "未记录"}</p>
                      </div>
                      <div className="paw-backlog-task-meta">
                        <span><Clock3 size={12} /> {minutesLabel(task.estimatedMinutes)}</span>
                        <span>归档于 {task.archivedLabel}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
