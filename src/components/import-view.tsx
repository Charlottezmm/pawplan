"use client";

import { Ban, Eye, FileText, Save, Table } from "lucide-react";
import { useState } from "react";
import { BackLink } from "./back-link";
import { CatIcon } from "./cat-icon";

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
  kind: "course" | "meeting" | "unavailable" | "routine" | "recovery";
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

async function postJson<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Import request failed");
  return payload as T;
}

export function ImportView() {
  const [planMarkdown, setPlanMarkdown] = useState(planExample);
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null);
  const [planPreviewToken, setPlanPreviewToken] = useState<string | null>(null);
  const [planState, setPlanState] = useState<RequestState>("idle");
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const [timetableCsv, setTimetableCsv] = useState(timetableExample);
  const [timetablePreview, setTimetablePreview] = useState<TimetablePreview | null>(null);
  const [timetablePreviewToken, setTimetablePreviewToken] = useState<string | null>(null);
  const [timetableState, setTimetableState] = useState<RequestState>("idle");
  const [timetableMessage, setTimetableMessage] = useState<string | null>(null);
  const [timetableError, setTimetableError] = useState<string | null>(null);

  async function previewPlan() {
    setPlanState("previewing");
    setPlanError(null);
    setPlanMessage(null);
    try {
      const payload = await postJson<{ preview: PlanPreview; previewToken: string }>("/api/imports/plan", { markdown: planMarkdown });
      setPlanPreview(payload.preview);
      setPlanPreviewToken(payload.previewToken);
    } catch (error) {
      setPlanPreview(null);
      setPlanPreviewToken(null);
      setPlanError(error instanceof Error ? error.message : "Plan preview failed");
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
      const payload = await postJson<{ message: string }>("/api/imports/plan/save", {
        markdown: planMarkdown,
        confirmation: "CONFIRM_PLAN_IMPORT",
        previewToken: planPreviewToken,
      });
      setPlanMessage(payload.message);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Plan save failed");
    } finally {
      setPlanState("idle");
    }
  }

  async function previewTimetable() {
    setTimetableState("previewing");
    setTimetableError(null);
    setTimetableMessage(null);
    try {
      const payload = await postJson<{ preview: TimetablePreview; previewToken: string }>("/api/imports/timetable", { csv: timetableCsv });
      setTimetablePreview(payload.preview);
      setTimetablePreviewToken(payload.previewToken);
    } catch (error) {
      setTimetablePreview(null);
      setTimetablePreviewToken(null);
      setTimetableError(error instanceof Error ? error.message : "Timetable preview failed");
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
      const payload = await postJson<{ message: string }>("/api/imports/timetable/save", {
        csv: timetableCsv,
        confirmation: "CONFIRM_TIMETABLE_IMPORT",
        previewToken: timetablePreviewToken,
      });
      setTimetableMessage(payload.message);
    } catch (error) {
      setTimetableError(error instanceof Error ? error.message : "Timetable save failed");
    } finally {
      setTimetableState("idle");
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
              <p className="paw-more-text">保存会写入 active plan 的导入摘要和项目，不自动生成 tasks 或 milestones。</p>
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
          {planError ? <p className="paw-error">{planError}</p> : null}
          {planMessage ? <p className="paw-toast">{planMessage}</p> : null}
          {planPreview ? (
            <div className="paw-import-preview">
              <p className="paw-row-title">Goal: {planPreview.goal ?? "未识别"}</p>
              <p className="paw-row-meta">Projects: {planPreview.projects.length} · Timezone: {planPreview.timezone}</p>
              {planPreview.warnings.length > 0 ? (
                <div>
                  <p className="paw-row-title">Warnings</p>
                  <ul className="paw-list">
                    {planPreview.warnings.map((warning) => (
                      <li className="paw-list-row" key={warning}>
                        <span className="paw-row-meta">{warning}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {planPreview.conflicts.length > 0 ? (
                <div>
                  <p className="paw-row-title">Conflicts</p>
                  <ul className="paw-list">
                    {planPreview.conflicts.map((conflict) => (
                      <li className="paw-list-row" key={conflict}>
                        <span className="paw-row-meta">{conflict}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ul className="paw-list">
                {planPreview.projects.map((project) => (
                  <li className="paw-list-row" key={`${project.name}-${project.deadline ?? "none"}`}>
                    <span className="paw-row-title">{project.name}</span>
                    <span className="paw-row-meta">{project.deadline ?? "无 deadline"}</span>
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
              <p className="paw-more-text">保存后会按日期生成对应的时间块；注意重复保存会重复添加。</p>
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
            }}
          />
          <div className="paw-save-row">
            <button className="paw-secondary-btn" type="button" onClick={previewTimetable} disabled={timetableState !== "idle"}>
              <Eye size={16} />
              {timetableState === "previewing" ? "正在预览" : "预览"}
            </button>
            <button
              className="paw-primary-btn"
              type="button"
              onClick={saveTimetable}
              disabled={timetableState !== "idle" || !timetablePreview || !timetablePreviewToken}
            >
              <Save size={16} />
              {timetableState === "saving" ? "正在保存" : "保存"}
            </button>
          </div>
          {timetableError ? <p className="paw-error">{timetableError}</p> : null}
          {timetableMessage ? <p className="paw-toast">{timetableMessage}</p> : null}
          {timetablePreview ? (
            <div className="paw-import-preview">
              <p className="paw-row-meta">
                Preview rows: {timetablePreview.rows.length} · Blocks: {timetablePreview.blocksPreviewed} · Timezone: {timetablePreview.timezone}
              </p>
              {timetablePreview.warnings.length > 0 ? (
                <div>
                  <p className="paw-row-title">Warnings</p>
                  <ul className="paw-list">
                    {timetablePreview.warnings.map((warning) => (
                      <li className="paw-list-row" key={warning}>
                        <span className="paw-row-meta">{warning}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {timetablePreview.conflicts.length > 0 ? (
                <div>
                  <p className="paw-row-title">Conflicts</p>
                  <ul className="paw-list">
                    {timetablePreview.conflicts.map((conflict) => (
                      <li className="paw-list-row" key={conflict}>
                        <span className="paw-row-meta">{conflict}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ul className="paw-list">
                {timetablePreview.rows.map((row, index) => (
                  <li className="paw-list-row" key={`${row.title}-${index}`}>
                    <span className="paw-row-title">{row.title}</span>
                    <span className="paw-row-meta">
                      {row.kind} · {row.dayOfWeek ?? row.startsOn} · {row.startTime}-{row.endTime}
                      {row.location ? ` · ${row.location}` : " · 地点待确认"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="paw-card paw-import-panel disabled">
          <div className="paw-import-heading">
            <span className="paw-more-icon">
              <Ban size={18} />
            </span>
            <div>
              <h2 className="paw-more-label">HTML</h2>
              <p className="paw-more-text">HTML 暂未开放。</p>
              <p className="paw-more-text">当前不会解析、预览或保存 HTML 内容。</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
