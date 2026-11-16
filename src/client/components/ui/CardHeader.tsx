import React from "react";
import { Flex } from "./Flex";

export interface CardHeaderProps {
  /** Title text — the order form card's h4, the risk panel's strong title. */
  title?: React.ReactNode;
  /** Muted subtitle under the title (the order form card's header-subtitle). */
  subtitle?: React.ReactNode;
  /** Right-side meta: text, badges, or controls (refresh button, timeframe pills). */
  meta?: React.ReactNode;
  /** Content under the subtitle on the left (the order form card's broker/mode badges). */
  belowSubtitle?: React.ReactNode;
  /**
   * Issue #4913: the h4's id — a section's aria-labelledby target (the
   * audit-trail section is labelled by its heading). Omitted when unset.
   */
  id?: string;
  /**
   * Issue #4573: put title, subtitle, belowSubtitle and meta on ONE row
   * instead of stacking the left block. Long text ellipsizes (the
   * #4409 `.ui-single-line` rule) and meta stays pinned right. Pass the
   * full text in a `title=` attribute where truncation is possible.
   */
  singleLine?: boolean;
}

/**
 * CardHeader (#3133, Part of #2150)
 * The one distributed header treatment: the order form card's header
 * (OrderTicketPanel.tsx:371 — Flex between/start/wrap/gap 2, h4 title +
 * muted subtitle + badge row left, refresh button right) and the risk
 * panel's local CardHeader (RiskAnalysisPanel.tsx:70 — bold title left,
 * muted meta right) rebuilt as a primitive. Meta is pushed right with
 * .ui-push, so a meta-only header still reads right — the autopilot
 * chart card's timeframe pills (AutopilotControlCenter.tsx:819), whose
 * title lives in the PageSection above it. Renders nothing with no
 * title, subtitle, meta, or belowSubtitle (§1.6b). Pages migrate onto
 * it in Wave 1 (#3138–#3140); this slice builds the organism only.
 */
export function CardHeader({ title, subtitle, meta, belowSubtitle, singleLine = false, id }: CardHeaderProps) {
  if (!title && !subtitle && !meta && !belowSubtitle) return null;
  return (
    <Flex
      justify="between"
      align={singleLine ? "center" : "start"}
      wrap={!singleLine}
      gap="2"
      className={singleLine ? "ui-card-header ui-card-header-single" : "ui-card-header"}
    >
      {(title || subtitle || belowSubtitle) && (
        <div className="ui-card-header-main">
          {title && <h4 id={id}>{title}</h4>}
          {subtitle && <span className="ui-card-header-subtitle">{subtitle}</span>}
          {belowSubtitle}
        </div>
      )}
      {meta && <div className="ui-push">{meta}</div>}
    </Flex>
  );
}
