/**
 * Issue #2863 — client helper for report replay (POST /api/reports/replay).
 *
 * A replay is NOT a new run: the server returns the persisted report
 * with replay provenance (charged: false, liveFetch: false). The
 * x-user-login header is set by server.ts from the verified session,
 * so callers pass no identity here.
 */
export interface ReplayResponse {
  ok: boolean;
  replay?: {
    kind: string;
    reportKind?: string;
    originalRunId?: string;
    generationId?: string;
    replayedAt?: string;
    matchedCount?: number;
    totalScanned?: number;
    partial?: boolean;
    partialReasons?: string[];
    artifacts?: { pdfKey?: string; xlsxKey?: string; csvKey?: string; reportUrl?: string };
    body?: unknown;
  };
  error?: string;
}

export async function replayReport(args: {
  reportId?: string;
  runId?: string;
  symbol?: string;
}): Promise<ReplayResponse> {
  const res = await fetch("/api/reports/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = (await res.json().catch(() => ({}))) as { replay?: unknown; error?: string };
  if (!res.ok) {
    return { ok: false, error: data.error || `Replay failed (HTTP ${res.status}).` };
  }
  return { ok: true, replay: data.replay as ReplayResponse["replay"] };
}

/** One-line human summary for a replay envelope, for Notices. */
export function replaySummary(replay: NonNullable<ReplayResponse["replay"]>): string {
  if (replay.reportKind === "research") {
    return `Replayed stored research report for run ${replay.originalRunId ?? "unknown"} — no live re-fetch, no re-charge.`;
  }
  const counts =
    typeof replay.matchedCount === "number" && typeof replay.totalScanned === "number"
      ? `${replay.matchedCount} matched of ${replay.totalScanned} scanned`
      : "rows reproduced from persisted data";
  return `Replayed report from run ${replay.originalRunId ?? "unknown"} — ${counts}. No live re-fetch, no re-charge.`;
}
