/**
 * Issue #5169 — the Observability home: one address, sub-routes.
 *
 * Home: `?tab=observability`. Sub-route scheme, following the
 * app's existing `?tab=` + `?view=` deep-link pattern
 * (`src/client/router.ts` `parseViewFromSearch`):
 * `?tab=observability&view=archive`.
 *
 * - `view=archive` (default, and the only view today): the R2
 *   archive file browser (`OtelArchivePanel`) — the archived
 *   OTLP JSONL objects S1/S2 write, listed by date with signal
 *   and size, each linked to its raw content. Read-only.
 * - `view=config` (S7, #5086): the message catalog + runtime
 *   config port (`OtelConfigPanel`) — every overridable key
 *   with its effective value and winning source, editable by a
 *   platform admin (each change versioned + audited).
 *
 * This module is pure: URLSearchParams in, values out. No
 * window, no fetch, no Cloudflare — the same hexagonal shape as
 * the S1 primitives (`src/services/consolidatedScheduling.ts`)
 * and the SecurityHub view module it mirrors.
 */

/** The one Observability home tab id. */
export const OBSERVABILITY_TAB = "observability";

/** The consolidated home's views. */
export type ObservabilityView = "archive" | "config";

export const OBSERVABILITY_VIEWS: readonly ObservabilityView[] = ["archive", "config"];

export const OBSERVABILITY_VIEW_LABELS: Record<ObservabilityView, string> = {
  archive: "Archive",
  config: "Config",
};

export function isObservabilityView(value: unknown): value is ObservabilityView {
  return typeof value === "string" && (OBSERVABILITY_VIEWS as readonly string[]).includes(value);
}

/**
 * Canonicalize a raw `?view=` value: an unknown or missing view falls
 * back to `archive`. Never throws, never returns an invalid view.
 */
export function normalizeObservabilityView(value: unknown): ObservabilityView {
  if (isObservabilityView(value)) return value;
  return "archive";
}

export interface ObservabilityDeepLink {
  view: ObservabilityView;
}

/** Parse the home's deep link out of a query string. */
export function parseObservabilityDeepLink(search: string): ObservabilityDeepLink {
  const params = new URLSearchParams(search);
  return {
    view: normalizeObservabilityView(params.get("view")),
  };
}
