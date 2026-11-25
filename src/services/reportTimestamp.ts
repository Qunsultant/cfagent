/**
 * Issue 6479 — the ONE human timestamp formatter for report surfaces.
 *
 * It lived in `src/trading/screenerReportPdf.ts`; the Opportunity Hunt's page
 * needs the same string as its PDF, and importing the screener PDF module into
 * a client bundle would drag pdf-lib with it. The pure formatter moves here so
 * both the PDF renderers and the page read one implementation.
 */

/** Human timestamp (#2088): "Oct 28, 2026, 03:50 EDT (07:50 UTC)". Falls back to the raw ISO. */
export function formatReportTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(date);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const utc = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
    return `${get("month")} ${get("day")}, ${get("year")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")} (${utc} UTC)`;
  } catch {
    return iso;
  }
}
