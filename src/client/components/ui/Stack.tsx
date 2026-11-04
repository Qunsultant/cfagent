import React from "react";
import { gapClass, alignClass, justifyClass, type LayoutGap, type LayoutAlign, type LayoutJustify } from "./layout";

export interface StackProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "className"> {
  /** Spacing-scale gap between children (default "0" — the CSS initial). */
  gap?: LayoutGap;
  /** Cross-axis alignment (default "stretch" — the CSS initial). */
  align?: LayoutAlign;
  /** Main-axis distribution (default "start" — the CSS initial). */
  justify?: LayoutJustify;
  className?: string;
  children: React.ReactNode;
}

/**
 * Stack (#3048)
 * The shared vertical layout: a flex column whose gap, alignment, and
 * distribution come from token-scale classes in primitives.css. Replaces
 * hand-rolled `display: flex; flexDirection: column` inline styles.
 * Extra div attributes (role, id, aria-*) pass through, so tabpanel
 * semantics survive migration unchanged.
 */
export function Stack({ gap = "0", align = "stretch", justify = "start", className = "", children, ...rest }: StackProps) {
  return (
    <div className={`ui-stack ${gapClass(gap)} ${alignClass(align)} ${justifyClass(justify)} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
