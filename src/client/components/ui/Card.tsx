import React from "react";

export interface CardProps {
  /**
   * Emphasized treatment (#4913): the union of the folded `elevated`
   * (raised surface + shadow) and `highlight` (primary-tinted background
   * + border) treatments — a raised, primary-tinted card for the lead
   * tile and the DetailCard surface.
   */
  emphasized?: boolean;
  padding?: "none" | "sm" | "md";
  className?: string;
  /**
   * Issue #3367: an anchor id, so a section nav can scroll to this card. The
   * alternative was a wrapper div or an inline style per section; a prop keeps
   * the markup flat and the style budget untouched.
   */
  id?: string;
  /**
   * Data-driven inline style (issue 2161: per-ad accent colors from the
   * ad record, not design values — layout still comes from tokens).
   */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Card (#492)
 * The shared surface container: card background, subtle border, 12px
 * radius, card shadow — the values the app's incumbent section cards
 * already use, formalized. Styles: ./primitives.css.
 */
export function Card({
  emphasized = false,
  padding = "md",
  className = "",
  id,
  style,
  children,
}: CardProps) {
  return (
    <div
      id={id}
      className={`ui-card ${emphasized ? "emphasized" : ""} pad-${padding} ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
