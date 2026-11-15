import React from "react";

export type NoticeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export interface NoticeProps {
  tone?: NoticeTone;
  /** box = bordered panel; strip = full-width banner (top/bottom borders). */
  variant?: "box" | "strip";
  density?: "regular" | "compact";
  icon?: React.ReactNode;
  title?: string;
  /** When provided, renders a dismiss (✕) button with this handler. */
  onDismiss?: () => void;
  className?: string;
  children: React.ReactNode;
}

/**
 * Notice (#492)
 * Inline banner/alert for status, warnings, and guarantees
 * (docs/architecture/UX/ux-architecture.md sections 6/12). Danger and warning
 * tones announce via role="alert"; other tones use role="status" (or no
 * live role for neutral). Styles: ./primitives.css.
 */
export function Notice({
  tone = "info",
  variant = "box",
  density = "regular",
  icon,
  title,
  onDismiss,
  className = "",
  children,
}: NoticeProps) {
  const role = tone === "danger" || tone === "warning" ? "alert" : tone === "neutral" ? undefined : "status";
  return (
    <div role={role} className={`ui-notice tone-${tone} variant-${variant} density-${density} ${className}`}>
      {icon && (
        <span className="ui-notice-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="ui-notice-body">
        {title && <strong className="ui-notice-title">{title}</strong>}
        {children}
      </div>
      {onDismiss && (
        <button type="button" className="ui-notice-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  );
}
