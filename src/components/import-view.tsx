"use client";

import { Eye, FileText, Save, Table, Upload } from "lucide-react";
import { useState } from "react";
import { BackLink } from "./back-link";
import { CatIcon } from "./cat-icon";
import { Notice } from "./ui/notice";

type PlanPreview = {
  goal: string | null;
  projects: Array<{ name: string; deadline: string | null }>;
  constraints: string[];
  timezone: "Asia/Shanghai";
  warnings: string[];
  conflicts: string[];
};

type TimetablePreviewRow = {
  title: string;
  kind: "course" | "exam" | "meeting" | "unavailable" | "routine" | "recovery";
  dayOfWeek: string | null;
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
  course: string | null;
  location?: string | null;
  recurrence: string | null;
  notes: string | null;
};

type TimetablePreview = {
  rows: TimetablePreviewRow[];
  timezone: "Asia/Shanghai";
  blocksPreviewed: number;
  warnings: string[];
  conflicts: string[];
  rowStatuses: Array<{
    index: number;
    status: "new" | "existing" | "duplicate" | "conflict";
    reason: string;
  }>;
  newCount: number;
  existingCount: number;
  conflictCount: number;
};

type TimetableSaveResult = {
  status: "succeeded" | "no_change";
  blocksCreated: number;
  blocksExisting: number;
  coursesCreated: number;
  coursesReused: number;
  readback: Array<{ id: string; title: string; fingerprint: string }>;
};

type RequestState = "idle" | "previewing" | "saving";

const planExample = `Goal: ship PawPlan tomorrow

## Projects
- PawPlan Import: save imports by 2026-06-11

## Constraints
- protect tomorrow morning for verification
`;

const timetableExample = `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,Room 204,weekly,
`;

const timetableKindLabels: Record<TimetablePreviewRow["kind"], string> = {
  course: "课程",
  exam: "考试",
  meeting: "会议",
  unavailable: "不可用",
  routine: "日常安排",
  recovery: "休息恢复",
};

const weekdayLabels: Record<string, string> = {
  Monday: "星期一",
  Tuesday: "星期二",
  Wednesday: "星期三",
  Thursday: "星期四",
  Friday: "星期五",
  Saturday: "星期六",
  Sunday: "星期日",
};

async function postJson<T>(url: string, body: Record<string, unknown>, fallbackMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("网络请求失败，请检查连接后重试");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!response.ok) {
    const error = typeof payload === "object" && payload && "error" in payload ? payload.error : null;
    throw new Error(typeof error === "string" ? error : fallbackMessage);
  }
  return payload as T;
}

export function ImportView() {
  const [planMarkdown, setPlanMarkdown] = useState("");
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null);
  const [planPreviewToken, setPlanPreviewToken] = useState<string | null>(null);
  const [planState, setPlanState] = useState<RequestState>("idle");
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const [timetableCsv, setTimetableCsv] = useState("");
  const [timetablePreview, setTimetablePreview] = useState<TimetablePreview | null>(null);
  const [timetablePreviewToken, setTimetablePreviewToken] = useState<string | null>(null);
  const [timetableState, setTimetableState] = useState<RequestState>("idle");
  const [timetableMessage, setTimetableMessage] = useState<string | null>(null);
  const [timetableError, setTimetableError] = useState<string | null>(null);
  const [allowTimetableConflicts, setAllowTimetableConflicts] = useState(false);

  async function previewPlan() {
    setPlanState("previewing");
    setPlanError(null);
    setPlanMessage(null);
    try {
      const payload = await postJson<{ preview: PlanPreview; previewToken: string }>(
        "/api/imports/plan",
        { markdown: planMarkdown },
        "无法预览 plan.md，请稍后重试",
      );
      setPlanPreview(payload.preview);
      setPlanPreviewToken(payload.previewToken);
    } catch (error) {
      setPlanPreview(null);
      setPlanPreviewToken(null);
      setPlanError(error instanceof Error ? error.message : "无法预览 plan.md，请稍后重试");
    } finally {
      setPlanState("idle");
    }
  }

  async function savePlan() {
    if (!planPreviewToken) {
      setPlanError("请先预览 plan.md。");
      return;
    }
    setPlanState("saving");
    setPlanError(null);
    setPlanMessage(null);
    try {
      await postJson<{ message: string }>(
        "/api/imports/plan/save",
        {
          markdown: planMarkdown,
          confirmation: "CONFIRM_PLAN_IMPORT",
          previewToken: planPreviewToken,
        },
        "无法保存 plan.md，请稍后重试",
      );
      setPlanMessage("已保存 plan.md：项目已创建或复用，未自动生成任务或里程碑。");
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "无法保存 plan.md，请稍后重试");
    } finally {
      setPlanState("idle");
    }
  }

  async function previewTimetable() {
    setTimetableState("previewing");
    setTimetableError(null);
    setTimetableMessage(null);
    try {
      const payload = await postJson<{ preview: TimetablePreview; previewToken: string }>(
        "/api/imports/timetable",
        { csv: timetableCsv },
        "无法预览 timetable.csv，请稍后重试",
      );
      setTimetablePreview(payload.preview);
      setTimetablePreviewToken(payload.previewToken);
      setAllowTimetableConflicts(false);
    } catch (error) {
      setTimetablePreview(null);
      setTimetablePreviewToken(null);
      setTimetableError(error instanceof Error ? error.message : "无法预览 timetable.csv，请稍后重试");
    } finally {
      setTimetableState("idle");
    }
  }

  async function saveTimetable() {
    if (!timetablePreviewToken) {
      setTimetableError("请先预览 timetable.csv。");
      return;
    }
    setTimetableState("saving");
    setTimetableError(null);
    setTimetableMessage(null);
    try {
      const payload = await postJson<{ result: TimetableSaveResult; message: string }>(
        "/api/imports/timetable/save",
        {
          csv: timetableCsv,
          confirmation: "CONFIRM_TIMETABLE_IMPORT",
          previewToken: timetablePreviewToken,
          allowConflicts: allowTimetableConflicts,
        },
        "无法保存 timetable.csv，请稍后重试",
      );
      setTimetableMessage(
        payload.result.status === "no_change"
          ? `没有新增日程：${payload.result.blocksExisting} 个时间块已经存在。`
          : `已新增 ${payload.result.blocksCreated} 个时间块，跳过 ${payload.result.blocksExisting} 个重复项，并完成回读。`,
      );
    } catch (error) {
      setTimetableError(error instanceof Error ? error.message : "无法保存 timetable.csv，请稍后重试");
    } finally {
      setTimetableState("idle");
    }
  }

  async function loadTimetableFile(file: File | undefined) {
    if (!file) return;
    setTimetableError(null);
    if (file.size > 200_000) {
      setTimetableError("CSV 文件不能超过 200 KB。");
      return;
    }
    try {
      const content = await file.text();
      setTimetableCsv(content);
      setTimetablePreview(null);
      setTimetablePreviewToken(null);
      setTimetableMessage(null);
      setAllowTimetableConflicts(false);
    } catch {
      setTimetableError("无法读取 CSV 文件，请重新选择。");
    }
  }

  return (
    <div className="paw-page">
      <section className="paw-page-header">
        <BackLink />
        <h1 className="paw-page-date">导入</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">支持 plan.md 和 timetable.csv。先预览，确认没问题再保存。</p>
        </div>
      </section>

      <section className="paw-import-grid">
        <div className="paw-card paw-import-panel">
          <div className="paw-import-heading">
            <span className="paw-more-icon">
              <FileText size={18} />
            </span>
            <div>
              <h2 className="paw-more-label">plan.md</h2>
              <p className="paw-more-text">保存会写入当前计划的导入摘要和项目，不自动生成任务或里程碑。</p>
            </div>
          </div>
          <label className="paw-field-label" htmlFor="plan-markdown">
            Markdown 内容
          </label>
          <textarea
            id="plan-markdown"
            className="paw-textarea paw-import-textarea"
            value={planMarkdown}
            onChange={(event) => {
              setPlanMarkdown(event.target.value);
              setPlanPreview(null);
              setPlanPreviewToken(null);
              setPlanMessage(null);
            }}
          />
          <div className="paw-save-row">
            <button
              className="paw-secondary-btn"
              type="button"
              onClick={() => {
                setPlanMarkdown(planExample);
                setPlanPreview(null);
                setPlanPreviewToken(null);
                setPlanMessage(null);
                setPlanError(null);
              }}
              disabled={planState !== "idle"}
            >
              填入 plan.md 示例
            </button>
          </div>
          <div className="paw-save-row">
            <button className="paw-secondary-btn" type="button" onClick={previewPlan} disabled={planState !== "idle"}>
              <Eye size={16} />
              {planState === "previewing" ? "正在预览" : "预览"}
            </button>
            <button
              className="paw-primary-btn"
              type="button"
              onClick={savePlan}
              disabled={planState !== "idle" || !planPreview || !planPreviewToken}
            >
              <Save size={16} />
              {planState === "saving" ? "正在保存" : "保存"}
            </button>
          </div>
          {planError ? <Notice tone="danger" title={planError} dismissible onDismiss={() => setPlanError(null)} /> : null}
          {planMessage ? <Notice tone="success" title={planMessage} autoDismissMs={5000} onDismiss={() => setPlanMessage(null)} /> : null}
          {planPreview ? (
            <div className="paw-import-preview">
              <p className="paw-more-label">目标：{planPreview.goal ?? "未识别"}</p>
              <p className="paw-row-meta">项目：{planPreview.projects.length} · 时区：{planPreview.timezone}</p>
              {planPreview.warnings.length > 0 ? (
                <Notice tone="warning" title={`提醒（${planPreview.warnings.length}）`}>
                  <p>不会阻止保存，建议先确认。</p>
                  <ul className="paw-import-notice-list">
                    {planPreview.warnings.map((warning) => (
                      <li className="paw-list-row" key={warning}>
                        <span className="paw-row-meta">{warning}</span>
                      </li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              {planPreview.conflicts.length > 0 ? (
                <Notice tone="danger" title={`冲突（${planPreview.conflicts.length}）`}>
                  <p>可能产生重复或重叠，保存前请确认。</p>
                  <ul className="paw-import-notice-list">
                    {planPreview.conflicts.map((conflict) => (
                      <li className="paw-list-row" key={conflict}>
                        <span className="paw-row-meta">{conflict}</span>
                      </li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              <ul className="paw-list">
                {planPreview.projects.map((project) => (
                  <li className="paw-list-row" key={`${project.name}-${project.deadline ?? "none"}`}>
                    <span className="paw-row-title">{project.name}</span>
                    <span className="paw-row-meta">{project.deadline ?? "无截止日期"}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="paw-card paw-import-panel">
          <div className="paw-import-heading">
            <span className="paw-more-icon">
              <Table size={18} />
            </span>
            <div>
              <h2 className="paw-more-label">timetable.csv</h2>
              <p className="paw-more-text">先预览再保存；已存在的日程会自动跳过，时间重叠需要额外确认。</p>
            </div>
          </div>
          <label className="paw-field-label" htmlFor="timetable-csv">
            CSV 内容
          </label>
          <textarea
            id="timetable-csv"
            className="paw-textarea paw-import-textarea"
            value={timetableCsv}
            onChange={(event) => {
              setTimetableCsv(event.target.value);
              setTimetablePreview(null);
              setTimetablePreviewToken(null);
              setTimetableMessage(null);
              setAllowTimetableConflicts(false);
            }}
          />
          <div className="paw-save-row">
            <label className="paw-secondary-btn paw-file-upload" htmlFor="timetable-file">
              <Upload size={16} />
              选择 CSV 文件
            </label>
            <input
              id="timetable-file"
              className="sr-only"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => void loadTimetableFile(event.target.files?.[0])}
              disabled={timetableState !== "idle"}
            />
            <button
              className="paw-secondary-btn"
              type="button"
              onClick={() => {
                setTimetableCsv(timetableExample);
                setTimetablePreview(null);
                setTimetablePreviewToken(null);
                setTimetableMessage(null);
                setTimetableError(null);
                setAllowTimetableConflicts(false);
              }}
              disabled={timetableState !== "idle"}
            >
              填入 timetable.csv 示例
            </button>
          </div>
          <div className="paw-save-row">
            <button className="paw-secondary-btn" type="button" onClick={previewTimetable} disabled={timetableState !== "idle"}>
              <Eye size={16} />
              {timetableState === "previewing" ? "正在预览" : "预览"}
            </button>
            <button
              className="paw-primary-btn"
              type="button"
              onClick={saveTimetable}
              disabled={
                timetableState !== "idle" ||
                !timetablePreview ||
                !timetablePreviewToken ||
                (timetablePreview.conflictCount > 0 && !allowTimetableConflicts)
              }
            >
              <Save size={16} />
              {timetableState === "saving" ? "正在保存" : "保存"}
            </button>
          </div>
          {timetableError ? <Notice tone="danger" title={timetableError} dismissible onDismiss={() => setTimetableError(null)} /> : null}
          {timetableMessage ? <Notice tone="success" title={timetableMessage} autoDismissMs={5000} onDismiss={() => setTimetableMessage(null)} /> : null}
          {timetablePreview ? (
            <div className="paw-import-preview">
              <p className="paw-row-meta">
                预览 {timetablePreview.rows.length} 行 · 将新增 {timetablePreview.newCount} · 已存在/重复 {timetablePreview.existingCount} · 时区：{timetablePreview.timezone}
              </p>
              {timetablePreview.warnings.length > 0 ? (
                <Notice tone="warning" title={`提醒（${timetablePreview.warnings.length}）`}>
                  <p>不会阻止保存，建议先确认。</p>
                  <ul className="paw-import-notice-list">
                    {timetablePreview.warnings.map((warning) => (
                      <li className="paw-list-row" key={warning}>
                        <span className="paw-row-meta">{warning}</span>
                      </li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              {timetablePreview.conflicts.length > 0 ? (
                <Notice tone="danger" title={`冲突（${timetablePreview.conflicts.length}）`}>
                  <p>以下日程与现有安排重叠。只有明确接受重叠后才能保存。</p>
                  <ul className="paw-import-notice-list">
                    {timetablePreview.conflicts.map((conflict) => (
                      <li className="paw-list-row" key={conflict}>
                        <span className="paw-row-meta">{conflict}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="paw-import-conflict-confirm">
                    <input
                      type="checkbox"
                      checked={allowTimetableConflicts}
                      onChange={(event) => setAllowTimetableConflicts(event.target.checked)}
                    />
                    我确认仍要保存这些重叠日程
                  </label>
                </Notice>
              ) : null}
              <ul className="paw-list">
                {timetablePreview.rows.map((row, index) => (
                  <li className="paw-list-row" key={`${row.title}-${index}`}>
                    <span>
                      <span className="paw-row-title">{row.title}</span>
                      <span className="paw-row-meta">
                        {timetableKindLabels[row.kind]} ·{" "}
                        {row.dayOfWeek ? (weekdayLabels[row.dayOfWeek] ?? row.dayOfWeek) : row.startsOn} · {row.startTime}-
                        {row.endTime}
                        {row.location ? ` · ${row.location}` : " · 地点待确认"}
                      </span>
                    </span>
                    {timetablePreview.rowStatuses[index] ? (
                      <span className={`paw-import-status ${timetablePreview.rowStatuses[index].status}`}>
                        {timetablePreview.rowStatuses[index].reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

      </section>
    </div>
  );
}
