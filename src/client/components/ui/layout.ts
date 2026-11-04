/**
 * Shared layout-primitive types (#3048).
 *
 * Gap values are names from the spacing scale in tokens.css — never raw
 * lengths at call sites. The CSS classes live in primitives.css.
 */
export type LayoutGap =
  | "0"
  | "0-5"
  | "1"
  | "1-5"
  | "2"
  | "2-5"
  | "3"
  | "4"
  | "5"
  | "6"
  | "8"
  | "10"
  | "12"
  | "16";

export type LayoutAlign = "start" | "center" | "end" | "stretch";

export type LayoutJustify = "start" | "center" | "end" | "between" | "around";

/**
 * Auto-fit column floor presets. These are component-internal layout
 * constants (like Card's fixed radii), not design tokens: a floor is a
 * breakpoint-like dimension, and the call site names only the preset.
 */
export type GridMinWidth = "xs" | "sm" | "md" | "lg" | "xl";

export function gapClass(gap: LayoutGap): string {
  return `gap-${gap}`;
}

export function alignClass(align: LayoutAlign): string {
  return `align-${align}`;
}

export function justifyClass(justify: LayoutJustify): string {
  return `justify-${justify}`;
}
