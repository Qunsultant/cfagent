import React from "react";
import { PageShell, type PageShellProps } from "./PageShell";
import { Stack } from "./Stack";

/**
 * PageTemplate slot props (#3131, Part of #2150): the named slots
 * around the workspace. Each slot is a ReactNode the page supplies;
 * the organisms that fill them land in #3132–#3134 (ContextStrip,
 * KpiRibbon, SummaryCard, WorkspaceGrid, ActionBar, QueueFeed).
 * Until then a page passes its own primitive-built content — the
 * slot order and spacing are already the template's, so the
 * organisms drop in without moving anything.
 */
export interface PageTemplateSlots {
  /** Live context (symbol, spot, strategy) — ContextStrip (#3132). */
  contextStrip?: React.ReactNode;
  /** Headline numbers as label/value rows — KpiRibbon (#3132). */
  kpiRibbon?: React.ReactNode;
  /** The closing actions bar — ActionBar (#3134). */
  actionBar?: React.ReactNode;
  /** The closing queue/feed section — QueueFeed (#3134). */
  queueRail?: React.ReactNode;
}

export interface PageTemplateProps
  extends Omit<PageShellProps, "children">,
    PageTemplateSlots {
  /**
   * The workspace slot: the page's sections. Pages compose slots,
   * never layout CSS — the workspace grid itself is WorkspaceGrid
   * (#3134); until it lands, sections render in a Stack at the
   * order-workspace gap.
   */
  children?: React.ReactNode;
}

/**
 * PageTemplate (#3131)
 * The template layer between primitives and pages: header + slots +
 * states, in canonical order. The PageShell chrome is kept (title +
 * scope note + loading/error/empty states, carried by primitives),
 * and the chrome hosts (page/tab/nested, #3125) are preserved —
 * PageTemplate renders PageShell, which reads PageChromeContext, so
 * the SAME template renders as a standalone route, as a tab
 * (content only, no second header), and nested (Card surface, title
 * as card heading) with zero changes to itself.
 *
 * Slot order: header, context strip, KPI ribbon, workspace,
 * action bar, queue rail. States win over every slot, exactly as
 * in PageShell. No new CSS: slot spacing is the Stack gap.
 */
export function PageTemplate({
  title,
  scopeNote,
  loading = false,
  loadingLabel = "Loading",
  error = null,
  empty = false,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  contextStrip,
  kpiRibbon,
  actionBar,
  queueRail,
  children,
}: PageTemplateProps) {
  return (
    <PageShell
      title={title}
      scopeNote={scopeNote}
      loading={loading}
      loadingLabel={loadingLabel}
      error={error}
      empty={empty}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      emptyAction={emptyAction}
    >
      <Stack gap="4">
        {contextStrip}
        {kpiRibbon}
        {children}
        {actionBar}
        {queueRail}
      </Stack>
    </PageShell>
  );
}
