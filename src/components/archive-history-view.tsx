import Link from "next/link";
import { Archive, ChevronDown, Clock3, Filter, RotateCcw, Search } from "lucide-react";
import { PlanSectionNav } from "@/components/plan-section-nav";
import type { ArchiveHistoryViewData } from "@/lib/planning/project-view-data";
import { ArchiveRestoreControl } from "@/components/task-transition-controls";

const statusLabels = {
  todo: "计划中（归档前）",
  done: "完成（归档前）",
  skipped: "旧兼容状态（未完成）",
  backlog: "稍后处理（归档前）",
} as const;

function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function ArchiveHistoryView({ data }: { data: ArchiveHistoryViewData }) {
  const activeFilterCount = [
    data.filters.status,
    data.filters.projectId,
    data.filters.dateFrom,
    data.filters.dateTo,
  ].filter(Boolean).length;

  return (
    <div className="paw-page paw-archive-page">
      <PlanSectionNav />
      <section className="paw-page-header paw-archive-header">
        <div className="paw-archive-heading-icon" aria-hidden="true">
          <Archive size={21} />
        </div>
        <div className="paw-archive-heading-copy">
          <p className="paw-project-kicker">归档记录</p>
          <div className="paw-archive-title-row">
            <h1 className="paw-page-date">历史归档</h1>
            <span>{data.totalCount} 条</span>
          </div>
          <p className="paw-project-intro">
            已退出当前计划的任务会保留在这里。恢复后先进入“稍后处理”，不会直接打乱当前日程。
          </p>
        </div>
      </section>

      <details className="paw-archive-filters" open={activeFilterCount > 0 || undefined}>
        <summary>
          <span className="paw-archive-filter-label">
            <Filter size={15} />
            筛选归档
            {activeFilterCount > 0 ? <strong>{activeFilterCount}</strong> : null}
          </span>
          <span className="paw-archive-filter-hint">
            {activeFilterCount > 0 ? "已应用筛选" : "按状态、项目或日期查找"}
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </summary>
        <form method="get" className="paw-archive-filter-form">
          <div className="paw-archive-filter-grid">
            <label>
              <span>归档前状态</span>
              <select className="paw-input" name="status" defaultValue={data.filters.status ?? ""}>
                <option value="">全部状态</option>
                {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>所属项目</span>
              <select className="paw-input" name="project_id" defaultValue={data.filters.projectId ?? ""}>
                <option value="">全部项目</option>
                {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label>
              <span>开始日期</span>
              <input className="paw-input" type="date" name="date_from" defaultValue={data.filters.dateFrom ?? ""} />
            </label>
            <label>
              <span>结束日期（不含当天）</span>
              <input className="paw-input" type="date" name="date_to" defaultValue={data.filters.dateTo ?? ""} />
            </label>
          </div>
          <div className="paw-archive-filter-actions">
            {activeFilterCount > 0 ? (
              <Link href="/archive" className="paw-archive-clear-link"><RotateCcw size={14} /> 清除筛选</Link>
            ) : null}
            <button type="submit" className="paw-primary-btn"><Search size={15} /> 查看结果</button>
          </div>
        </form>
      </details>

      {data.dataUnavailable ? <p className="paw-status-pill warn">当前没有可用的数据源。</p> : null}

      {data.totalCount === 0 ? (
        <section className="paw-empty paw-archive-empty">
          <span className="paw-archive-empty-icon"><Archive size={25} /></span>
          <h2>{activeFilterCount > 0 ? "没有符合筛选条件的任务" : "暂无归档任务"}</h2>
          <p>
            {activeFilterCount > 0
              ? "换一组条件试试，或清除筛选查看全部归档。"
              : "归档会让任务退出当前计划，同时保留记录，之后仍可恢复。"}
          </p>
          {activeFilterCount > 0 ? <Link href="/archive" className="paw-archive-empty-link">查看全部归档</Link> : null}
        </section>
      ) : (
        <>
          <div className="paw-archive-results-head">
            <p>共 <strong>{data.totalCount}</strong> 条归档任务</p>
            <span><Clock3 size={13} /> {minutesLabel(data.totalMinutes)}</span>
          </div>
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
                      <ArchiveRestoreControl taskId={task.id} />
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
