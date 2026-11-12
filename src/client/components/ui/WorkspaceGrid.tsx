import React from "react";
import { Grid } from "./Grid";
import { gapClass, type LayoutGap, type GridMinWidth } from "./layout";

/**
 * The three WorkspaceGrid variants (rule of three, §1.6b — no fourth;
 * a fourth variant is an exceptions-register entry, not a quiet addition):
 * - "workspace": the page's sections in an auto-fit grid (the default
 *   workspace arrangement).
 * - "list-detail": the order ticket's 1.4fr/1fr two-column layout
 *   (styles.css `.order-ticket-layout`), collapsing to one column
 *   below 900px.
 * - "feed": a single column — the feed/queue reading order.
 */
export type WorkspaceGridVariant = "workspace" | "list-detail" | "feed";

export interface WorkspaceGridProps {
  /** Which canonical arrangement (default "workspace"). */
  variant?: WorkspaceGridVariant;
  /** Token-scale gap between cells (default "4" — the order-workspace gap). */
  gap?: LayoutGap;
  /** Auto-fit column floor for the workspace variant (default "md"). */
  minColumnWidth?: GridMinWidth;
  children: React.ReactNode;
}

/**
 * WorkspaceGrid (#3134, Part of #2150)
 * The workspace grid (design-system §1.6b slot 4): the grid the page's
 * sections sit in, with named breakpoints and canonical variants.
 * Breakpoints (Material 3 window-size-class idea, web values):
 * compact <900px, medium 900–1440px, expanded >1440px. The compact
 * boundary is the hard rule — list-detail collapses to one column
 * below 900px, preserving the order ticket's existing collapse
 * exactly; the workspace variant's auto-fit covers medium/expanded
 * by adding columns as width grows.
 *
 * Built on the Grid primitive, not beside it: workspace and feed are
 * Grid (auto-fit / one column); list-detail renders the shared
 * .ui-grid hooks directly because Grid's API is equal columns only
 * and the asymmetric 1.4fr/1fr ratio is exactly what the variant
 * adds — the ratio and the 900px collapse live in primitives.css,
 * never as an inline style. Renders nothing with no children
 * (§1.6b slot rule). No outer margin — slot spacing is the
 * template's Stack gap. Pages migrate onto it in Wave 1 (#3138–#3140);
 * this slice builds the organism only.
 */
export function WorkspaceGrid({
  variant = "workspace",
  gap = "4",
  minColumnWidth = "md",
  children,
}: WorkspaceGridProps) {
  if (React.Children.count(children) === 0) return null;
  const hook = `ui-workspace-grid variant-${variant}`;
  if (variant === "list-detail") {
    return (
      <div className={`ui-grid ${gapClass(gap)} ${hook}`.trim()}>{children}</div>
    );
  }
  if (variant === "feed") {
    return (
      <Grid columns={1} gap={gap} className={hook}>
        {children}
      </Grid>
    );
  }
  return (
    <Grid autoFit minColumnWidth={minColumnWidth} gap={gap} className={hook}>
      {children}
    </Grid>
  );
}
