import React from "react";
import { Flex } from "./Flex";

export interface SmallHeaderProps {
  /** Title text — the sub-section h5/h6 (one step below CardHeader's h4). */
  title?: React.ReactNode;
  /** Muted subtitle under the title. */
  subtitle?: React.ReactNode;
  /** Right-side meta: text, badges, or controls. */
  meta?: React.ReactNode;
  /** Content under the subtitle on the left. */
  belowSubtitle?: React.ReactNode;
  /**
   * Issue #5004: the heading's id — a section's aria-labelledby target,
   * same as CardHeader's id (#4913). Omitted when unset.
   */
  id?: string;
  /**
   * Issue #5004: heading level for semantics; default "h5". The only h6
   * site is OmnichannelPanel's email subject. A semantic prop like
   * Button's `size`, not a second treatment — one primitive, prop-selected
   * rendering.
   */
  level?: "h5" | "h6";
}

/**
 * SmallHeader (#5004, Part of #3695)
 * The one distributed small-header treatment: the 46 hand-rolled h5/h6
 * sites migrated here (Ceos's decision 2026-11-23: keep it as a
 * primitive, be consistent). Mirrors CardHeader's contract one step down
 * in size — Flex between/start/wrap/gap 2, h5/h6 title + muted subtitle
 * left, meta pushed right with .ui-push. Renders nothing with no title,
 * subtitle, meta, or belowSubtitle (CardHeader §1.6b parity).
 */
export function SmallHeader({ title, subtitle, meta, belowSubtitle, level = "h5", id }: SmallHeaderProps) {
  if (!title && !subtitle && !meta && !belowSubtitle) return null;
  return (
    <Flex
      justify="between"
      align="start"
      wrap
      gap="2"
      className="ui-small-header"
    >
      {(title || subtitle || belowSubtitle) && (
        <div className="ui-small-header-main">
          {title && (level === "h6" ? <h6 id={id}>{title}</h6> : <h5 id={id}>{title}</h5>)}
          {subtitle && <span className="ui-small-header-subtitle">{subtitle}</span>}
          {belowSubtitle}
        </div>
      )}
      {meta && <div className="ui-push">{meta}</div>}
    </Flex>
  );
}
