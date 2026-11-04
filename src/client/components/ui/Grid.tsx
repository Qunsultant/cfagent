import React from "react";
import { gapClass, type LayoutGap, type GridMinWidth } from "./layout";

type GridTemplate =
  | { columns: 1 | 2 | 3 | 4 | 5 | 6; autoFit?: never; minColumnWidth?: never }
  | { columns?: never; autoFit: true; minColumnWidth?: GridMinWidth };

export type GridProps = Omit<React.HTMLAttributes<HTMLDivElement>, "className"> & {
  /** Spacing-scale gap between cells (default "0" — the CSS initial). */
  gap?: LayoutGap;
  className?: string;
  children: React.ReactNode;
} & GridTemplate;

/**
 * Grid (#3048)
 * The shared grid layout: either a fixed column count (1–6, via
 * cols-N classes) or an auto-fit row (via autofit-preset classes) whose
 * gap comes from the token scale in primitives.css. Replaces hand-rolled
 * `display: grid` inline styles. The template is always a class, never
 * an inline style, so migrating an element drops its style={{ }}.
 */
export function Grid({ gap = "0", className = "", children, columns, autoFit, minColumnWidth, ...divProps }: GridProps) {
  void autoFit;
  const templateClass = columns ? `cols-${columns}` : `autofit-${minColumnWidth ?? "md"}`;
  return (
    <div className={`ui-grid ${gapClass(gap)} ${templateClass} ${className}`.trim()} {...divProps}>
      {children}
    </div>
  );
}
