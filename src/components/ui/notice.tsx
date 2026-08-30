"use client";

import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type NoticeTone = "info" | "success" | "warning" | "danger";

const noticeIcon = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
} as const;

export function Notice({
  tone = "info",
  title,
  children,
  dismissible = false,
  autoDismissMs,
  onDismiss,
  className,
}: {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  dismissible?: boolean;
  autoDismissMs?: number;
  onDismiss?: () => void;
  className?: string;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
  }, [title]);

  useEffect(() => {
    if (!autoDismissMs || tone !== "success") return;
    const timer = window.setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, onDismiss, tone, title]);

  if (!visible) return null;
  const Icon = noticeIcon[tone];

  function dismiss() {
    setVisible(false);
    onDismiss?.();
  }

  return (
    <section
      className={["paw-notice", `paw-notice-${tone}`, className].filter(Boolean).join(" ")}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <Icon className="paw-notice-icon" size={18} aria-hidden="true" />
      <div className="paw-notice-content">
        <p className="paw-notice-title">{title}</p>
        {children ? <div className="paw-notice-body">{children}</div> : null}
      </div>
      {dismissible ? (
        <button type="button" className="paw-notice-dismiss" onClick={dismiss} aria-label="关闭提示">
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}
