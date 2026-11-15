import React from "react";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "purple"
  | "trade";

export interface BadgeProps {
  tone?: BadgeTone;
  size?: "xs" | "sm" | "md";
  /** Show a leading status dot in the badge's tone color. */
  dot?: boolean;
  /** Render the label in tracked uppercase (nav/status-label style). */
  uppercase?: boolean;
  title?: string;
  className?: string;
  /**
   * Data-driven inline style (issue 2161: per-ad accent colors from the
   * ad record, not design values — shape still comes from the Badge).
   */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Badge (#492)
 * Small status/label pill. Tone is semantic (docs/architecture/UX/ux-architecture.md
 * section 6: status is never carried by color alone — pair with the label
 * text; the dot is only a redundant cue). Styles: ./primitives.css.
 */
export function Badge({
  tone = "neutral",
  size = "md",
  dot = false,
  uppercase = false,
  title,
  className = "",
  style,
  children,
}: BadgeProps) {
  return (
    <span className={`ui-badge tone-${tone} size-${size} ${uppercase ? "uppercase" : ""} ${className}`} title={title} style={style}>
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
