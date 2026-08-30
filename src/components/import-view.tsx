"use client";

import { Eye, FileText, Save, Table } from "lucide-react";
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

async function postJson<T>(url: string, body: Record<string, string>, fallbackMessage: string): Promise<T> {
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
      await postJson<{ message: string }>(
        "/api/imports/timetable/save",
        {
          csv: timetableCsv,
          confirmation: "CONFIRM_TIMETABLE_IMPORT",
          previewToken: timetablePreviewToken,
        },
        "无法保存 timetable.csv，请稍后重试",
      );
      setTimetableMessage("已保存 timetable.csv：已新增时间块；重复导入目前仍可能重复添加。");
    } catch (error) {
      setTimetableError(error instanceof Error ? error.message : "无法保存 timetable.csv，请稍后重试");
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
          {planError ? <p className="paw-error">{planError}</p> : null}
          {planMessage ? <p className="paw-toast">{planMessage}</p> : null}
          {planPreview ? (
            <div className="paw-import-preview">
              <p className="paw-more-label">目标：{planPreview.goal ?? "未识别"}</p>
              <p className="paw-row-meta">项目：{planPreview.projects.length} · 时区：{planPreview.timezone}</p>
              {planPreview.warnings.length > 0 ? (
                <div>
                  <p className="paw-more-text">提醒（{planPreview.warnings.length}）：不会阻止保存，建议先确认</p>
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
                  <p className="paw-more-text">冲突（{planPreview.conflicts.length}）：可能产生重复或重叠，保存前请确认</p>
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
            <button
              className="paw-secondary-btn"
              type="button"
              onClick={() => {
                setTimetableCsv(timetableExample);
                setTimetablePreview(null);
                setTimetablePreviewToken(null);
                setTimetableMessage(null);
                setTimetableError(null);
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
                预览行数：{timetablePreview.rows.length} · 将生成时间块：{timetablePreview.blocksPreviewed} · 时区：{timetablePreview.timezone}
              </p>
              {timetablePreview.warnings.length > 0 ? (
                <div>
                  <p className="paw-more-text">提醒（{timetablePreview.warnings.length}）：不会阻止保存，建议先确认</p>
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
                  <p className="paw-more-text">冲突（{timetablePreview.conflicts.length}）：可能产生重复或重叠，保存前请确认</p>
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
                      {timetableKindLabels[row.kind]} ·{" "}
                      {row.dayOfWeek ? (weekdayLabels[row.dayOfWeek] ?? row.dayOfWeek) : row.startsOn} · {row.startTime}-
                      {row.endTime}
                      {row.location ? ` · ${row.location}` : " · 地点待确认"}
                    </span>
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
