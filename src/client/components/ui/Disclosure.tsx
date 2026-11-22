import React from "react";

export interface DisclosureProps {
  /** The always-visible summary row (text or nodes). */
  summary: React.ReactNode;
  /** The content revealed when the disclosure is open. */
  children: React.ReactNode;
  /** Start open instead of closed (default false). */
  defaultOpen?: boolean;
  /** Extra classes on the <details> element (e.g. "ui-mt-1"). */
  className?: string;
}

/**
 * Disclosure (#5881)
 * The shared collapsible section: a native <details>/<summary> pair
 * styled from tokens in primitives.css, so no surface hand-rolls its
 * own details chrome with inline styles. Uncontrolled — the browser
 * owns the open state; defaultOpen only sets the initial state. The
 * summary keeps native keyboard/AT behaviour; the panel content is
 * plain children. No outer margin: the call site adds a ui-mt-*
 * utility when the section needs separation from above.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: DisclosureProps) {
  return (
    <details
      className={`ui-disclosure ${className}`.trim()}
      open={defaultOpen || undefined}
    >
      <summary className="ui-disclosure-summary">{summary}</summary>
      {children}
    </details>
  );
}
