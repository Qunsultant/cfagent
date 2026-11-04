import React from "react";
import { gapClass, alignClass, justifyClass, type LayoutGap, type LayoutAlign, type LayoutJustify } from "./layout";

export interface FlexProps extends Omit<React.HTMLAttributes<HTMLElement>, "className"> {
  /** Spacing-scale gap between children (default "0" — the CSS initial). */
  gap?: LayoutGap;
  /** Cross-axis alignment (default "stretch" — the CSS initial). */
  align?: LayoutAlign;
  /** Main-axis distribution (default "start" — the CSS initial). */
  justify?: LayoutJustify;
  /** Wrap onto multiple lines instead of overflowing. */
  wrap?: boolean;
  /** Render an inline-flex span instead of a block flex div — for rows
   *  inside text flow, where a div would break the line. */
  inline?: boolean;
  /** Element to render ("div" by default; "span" only with inline). */
  as?: "div" | "span";
  className?: string;
  children: React.ReactNode;
}

/**
 * Flex (#3048)
 * The shared horizontal layout: a flex row whose gap, alignment,
 * distribution, and wrapping come from token-scale classes in
 * primitives.css. Replaces hand-rolled `display: flex` inline styles.
 */
export function Flex({ gap = "0", align = "stretch", justify = "start", wrap = false, inline = false, as = "div", className = "", children, ...rest }: FlexProps) {
  const classes = `ui-flex ${gapClass(gap)} ${alignClass(align)} ${justifyClass(justify)}${inline ? " inline" : ""}${wrap ? " wrap" : ""} ${className}`.trim();
  return React.createElement(as, { className: classes, ...rest }, children);
}
