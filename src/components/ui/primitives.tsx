import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

function classes(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return <button className={classes("paw-ui-button", `paw-ui-button-${variant}`, className)} {...props} />;
}

export function IconButton({
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} className={classes("paw-ui-icon-button", className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={classes("paw-ui-card", className)} {...props} />;
}

export function StatusBadge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  return <span className={classes("paw-ui-status-badge", `paw-ui-status-${tone}`, className)} {...props} />;
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes("paw-ui-empty-state", className)}>
      <p className="paw-ui-empty-title">{title}</p>
      {description ? <p className="paw-ui-empty-description">{description}</p> : null}
      {action ? <div className="paw-ui-empty-action">{action}</div> : null}
    </div>
  );
}
