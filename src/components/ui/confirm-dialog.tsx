"use client";

import { AlertTriangle } from "lucide-react";
import React from "react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { DialogSheet } from "./dialog-sheet";

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  pending = false,
  destructive = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  pending?: boolean;
  destructive?: boolean;
  children?: ReactNode;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogSheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      initialFocusRef={destructive ? cancelRef : confirmRef}
      closeDisabled={pending}
      variant="detail"
    >
      {children ? <div className="paw-confirm-detail">{children}</div> : null}
      {destructive ? (
        <p className="paw-confirm-warning">
          <AlertTriangle size={16} aria-hidden="true" />
          请确认对象和影响范围无误。
        </p>
      ) : null}
      <div className="paw-modal-actions">
        <button ref={cancelRef} type="button" className="paw-secondary-btn" onClick={onClose} disabled={pending}>
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={destructive ? "paw-danger-btn" : "paw-primary-btn"}
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? "处理中…" : confirmLabel}
        </button>
      </div>
    </DialogSheet>
  );
}
