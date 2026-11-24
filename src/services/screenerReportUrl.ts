/**
 * Issue #1943: the single construction for screener report URLs.
 *
 * The event-bus path (src/events/screenerPublishers.ts) already builds
 * absolute URLs from APP_BASE_URL with a production fallback, while the
 * follow-up chain (src/services/screenerFollowups.ts) built bare
 * relative paths — which are not working links in Slack. Both paths
 * now build through here, so a report link is absolute wherever it
 * is rendered. An already-absolute URL passes through unchanged.
 */
export const FALLBACK_APP_BASE_URL = "https://agent.openaimp.com";

export function absoluteReportUrl(
  appBaseUrl: string | undefined,
  path: string,
): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = (appBaseUrl ?? "").replace(/\/+$/, "") || FALLBACK_APP_BASE_URL;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function screenerReportUrl(
  appBaseUrl: string | undefined,
  pdfKey: string,
): string {
  return absoluteReportUrl(
    appBaseUrl,
    `/api/screener/report.pdf?key=${encodeURIComponent(pdfKey)}`,
  );
}

export function optionsReportUrl(
  appBaseUrl: string | undefined,
  pdfKey: string,
): string {
  return absoluteReportUrl(
    appBaseUrl,
    `/api/options/report.pdf?key=${encodeURIComponent(pdfKey)}`,
  );
}

/** Issue 6403: the Opportunity Hunt report PDF download URL. */
export function opportunityHuntReportUrl(
  appBaseUrl: string | undefined,
  pdfKey: string,
): string {
  return absoluteReportUrl(
    appBaseUrl,
    `/api/opportunity-hunt/report.pdf?key=${encodeURIComponent(pdfKey)}`,
  );
}
