"use client";
import { Check, X } from "lucide-react";
import { redactPrivateTitle } from "@/lib/display/privacy";
import type { RescheduleViewData } from "@/lib/planning/view-data";
import { ReviewTechnicalDetails } from "./review-feedback";
import styles from "./review-import-card.module.css";
type Item = RescheduleViewData["patchItems"][number];
export function ReviewImportCard({ item, decision, pending, onDecide, onDismiss }: {
 item: Item; decision?: "accepted" | "rejected"; pending: boolean;
 onDecide: (id: string, decision: "accepted" | "rejected") => void; onDismiss: (id: string) => void;
}) {
 const blocked = Boolean(item.skipped || item.conflict || item.protected);
 const status = item.conflict ? "冲突 · 暂不能导入" : item.skipped ? "已跳过" : item.protected ? "受保护" : decision === "accepted" ? "已选择导入 · 待提交" : decision === "rejected" ? "已选择拒绝 · 待提交" : "待确认";
 const title = redactPrivateTitle(item.title.replace(/^导入日程表：\s*/, "").replace(/^MCP draft$/, "未命名日程"));
 const overlaps = item.conflict?.actual?.overlaps;
 const entries = [...new Set((Array.isArray(overlaps) ? overlaps : []).map(value => typeof value === "string" ? value : value && typeof value === "object" && typeof value.title === "string" ? value.title : "").filter(Boolean))];
 const total = typeof item.conflict?.actual?.overlapCount === "number" ? item.conflict.actual.overlapCount : null;
 const body = <>
   <p className={styles.description}>{blocked ? "这份建议尚未导入，当前日程保持原样。" : "确认后创建固定日程；提交时还会重新检查冲突并核对结果。"}</p>
   {item.conflict ? <section className={styles.conflicts} aria-label="导入冲突"><strong>与已有安排重叠</strong>
     {entries.length ? <ul>{entries.map(entry => <li key={entry}>{redactPrivateTitle(entry)}</li>)}</ul> : <p>冲突详情未提供，请基于当前日程重新生成建议。</p>}
     {total !== null ? <p>检查记录了 {total} 处重叠；上方已合并重复描述{total > (Array.isArray(overlaps) ? overlaps.length : 0) ? "，这里只显示部分条目" : ""}。</p> : null}
   </section> : null}
   <div className={styles.actions}>
     {blocked ? <button type="button" className="paw-secondary-btn" onClick={() => onDismiss(item.patchId)} disabled={pending}>丢弃整份建议</button> : <>
       <button type="button" className={decision === "accepted" ? "paw-secondary-btn" : "paw-primary-btn"} onClick={() => onDecide(item.id,"accepted")} disabled={pending} aria-pressed={decision === "accepted"}><Check size={15}/>{decision === "accepted" ? "撤回导入选择" : "选择导入"}</button>
       <button type="button" className="paw-secondary-btn" onClick={() => onDecide(item.id,"rejected")} disabled={pending} aria-pressed={decision === "rejected"}><X size={15}/>{decision === "rejected" ? "撤回拒绝选择" : "拒绝这项"}</button>
       <span>选择后，在页面底部提交确认。</span>
     </>}
   </div>
   {item.impact.filter(value => value.startsWith("地点")).map(value => <p className={styles.location} key={value}>{redactPrivateTitle(value)}</p>)}
   <details className={styles.explanation}><summary>查看完整说明</summary><p>{redactPrivateTitle(item.reason)}</p>
     {blocked ? <p>{item.protected ? "保护规则阻止了此操作。" : "如需继续，请重新生成可审核的导入建议。"}</p> : null}
   </details>
   <ReviewTechnicalDetails operationType={item.operationType} patchId={item.provenance.patchId} operationIndex={item.provenance.operationIndex} createdBy={item.provenance.createdBy} createdAt={new Date(item.provenance.createdAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})} agentRun={item.agentRun ? {label:item.agentRunLabel,status:item.agentRun.status,id:item.agentRun.id} : undefined}>
     {blocked ? <dl><div><dt>检查结果</dt><dd>{redactPrivateTitle(item.conflict?.reason ?? item.skippedReason ?? "未提供")}</dd></div>{item.conflict ? <><div><dt>建议基于</dt><dd>{redactPrivateTitle(JSON.stringify(item.conflict.expected ?? {}, null, 2))}</dd></div><div><dt>当前检查</dt><dd>{redactPrivateTitle(JSON.stringify(item.conflict.actual ?? {}, null, 2))}</dd></div></> : null}</dl> : null}
   </ReviewTechnicalDetails>
 </>;
 return <article className={`paw-suggestion-card ${styles.card}`} data-import-status={blocked ? "blocked" : "pending"}>
   {blocked ? <details className={styles.archived}><summary><div className={styles.heading}><span className={`${styles.status} ${item.conflict ? styles.warning : ""}`}>{status}</span><h2>{title}</h2><p>{item.to}</p></div><span className={styles.expand}>展开查看</span></summary><div className={styles.body}>{body}</div></details>
     : <><div className={styles.heading}><span className={styles.status}>{status}</span><h2>{title}</h2><p>{item.to}<span className={styles.neutral}>尚未导入</span></p></div>{body}</>}
 </article>;
}
