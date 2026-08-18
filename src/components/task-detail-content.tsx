import { AlertTriangle, CheckCircle2, ExternalLink, FileText, ListChecks, Target } from "lucide-react";
import React, { type ReactNode } from "react";

import type { TaskDetailSectionView, TaskDetailView } from "@/lib/planning/view-data";

type Resource = {
  description: string;
  href: string;
  host: string;
  label: string;
};

const executionLabels = new Set(["执行", "步骤"]);
const completionLabels = new Set(["完成标准", "验收", "产出"]);
const boundaryLabels = new Set(["卡点与边界", "卡点", "边界"]);
const resourceLabels = new Set(["快捷链接", "资源"]);

function trimBareUrl(value: string) {
  return value.replace(/[.,，。；;!！?？)）]+$/, "");
}

function hostname(href: string) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "打开链接";
  }
}

export function parseTaskResource(line: string): Resource | null {
  const markdown = line.match(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/);
  if (markdown) {
    const href = markdown[2];
    const remainder = `${line.slice(0, markdown.index)} ${line.slice((markdown.index ?? 0) + markdown[0].length)}`
      .trim()
      .replace(/^[\-—–:：|·\s]+/, "");
    return { label: markdown[1], href, host: hostname(href), description: remainder };
  }

  const bare = line.match(/https?:\/\/[^\s<>{}\[\]"]+/);
  if (!bare) return null;
  const href = trimBareUrl(bare[0]);
  const before = line.slice(0, bare.index).trim().replace(/[\-—–:：|·\s]+$/, "");
  const after = line.slice((bare.index ?? 0) + bare[0].length).trim().replace(/^[\-—–:：|·\s]+/, "");
  return {
    label: before || hostname(href),
    href,
    host: hostname(href),
    description: after,
  };
}

function InlineDetailText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>{}\[\]"]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const markdownHref = match[2];
    const bareHref = match[3] ? trimBareUrl(match[3]) : null;
    const href = markdownHref ?? bareHref!;
    const label = match[1] ?? hostname(href);
    parts.push(
      <a key={`${href}-${match.index}`} className="paw-detail-inline-link" href={href} target="_blank" rel="noreferrer">
        {label}
      </a>,
    );
    cursor = match.index + match[0].length;
    if (bareHref && bareHref.length < match[0].length) {
      parts.push(match[0].slice(bareHref.length));
    }
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function sectionIcon(label: string) {
  if (label === "目标") return <Target size={15} />;
  if (executionLabels.has(label)) return <ListChecks size={15} />;
  if (completionLabels.has(label)) return <CheckCircle2 size={15} />;
  if (boundaryLabels.has(label)) return <AlertTriangle size={15} />;
  if (resourceLabels.has(label)) return <ExternalLink size={15} />;
  return <FileText size={15} />;
}

function sectionTone(label: string) {
  if (label === "目标") return "goal";
  if (executionLabels.has(label)) return "steps";
  if (completionLabels.has(label)) return "completion";
  if (boundaryLabels.has(label)) return "boundary";
  if (resourceLabels.has(label)) return "resources";
  return "default";
}

function ResourceSection({ section }: { section: TaskDetailSectionView }) {
  return (
    <div className="paw-detail-resource-list">
      {section.lines.map((line, index) => {
        const resource = parseTaskResource(line);
        if (!resource) return <p key={`${section.label}-${index}`} className="paw-detail-resource-fallback"><InlineDetailText text={line} /></p>;
        return (
          <a
            key={`${resource.href}-${index}`}
            className="paw-detail-resource-card"
            href={resource.href}
            target="_blank"
            rel="noreferrer"
          >
            <span className="paw-detail-resource-copy">
              <strong>{resource.label}</strong>
              {resource.description ? <span>{resource.description}</span> : null}
              <small>{resource.host}</small>
            </span>
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        );
      })}
    </div>
  );
}

function DetailSection({ section }: { section: TaskDetailSectionView }) {
  const tone = sectionTone(section.label);
  const content = resourceLabels.has(section.label) ? (
    <ResourceSection section={section} />
  ) : executionLabels.has(section.label) ? (
    <ol className="paw-detail-steps">
      {section.lines.map((line, index) => <li key={`${section.label}-${index}`}><InlineDetailText text={line} /></li>)}
    </ol>
  ) : section.label === "目标" && section.lines.length === 1 ? (
    <p className="paw-detail-goal"><InlineDetailText text={section.lines[0]} /></p>
  ) : (
    <ul className="paw-detail-list">
      {section.lines.map((line, index) => (
        <li key={`${section.label}-${index}`}>
          {completionLabels.has(section.label) ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
          <span><InlineDetailText text={line} /></span>
        </li>
      ))}
    </ul>
  );

  return (
    <section className={`paw-detail-section tone-${tone}`}>
      <h3>{sectionIcon(section.label)}<span>{section.label}</span></h3>
      {content}
    </section>
  );
}

export function TaskDetailContent({ detail, notes }: { detail: TaskDetailView; notes: string | null }) {
  if (detail.sections.length === 0) {
    return notes
      ? <p className="paw-task-detail-raw">{notes}</p>
      : <p className="paw-task-detail-raw muted">这条任务还没有详细描述。</p>;
  }

  return (
    <div className="paw-task-detail-content">
      {detail.summary ? <p className="paw-detail-summary"><InlineDetailText text={detail.summary} /></p> : null}
      {detail.sections.map((section, index) => (
        <DetailSection key={`${section.label}-${index}`} section={section} />
      ))}
    </div>
  );
}
