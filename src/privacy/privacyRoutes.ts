/**
 * #1765 (parent #1717, F-41): user-facing privacy route handlers.
 *
 * Pure handlers: no env, no binding, no store client. The server
 * wires them to the session store; each handler decides only
 * status codes and response shape — the same shape as
 * src/data/retentionRoute.ts (the #1701 retention-purge route).
 *
 * Decision order, every route: 401 (no session) → 405
 * (wrong method) → 200/500. A session without an internalUserId
 * is a legacy session (see src/server.ts /api/me): it cannot
 * name its own subject, so it is answered 403, never given a
 * synthetic identity and never served another subject's data.
 * Every route serves ONLY the caller's own subject: the subject
 * is derived from the session, and a caller-supplied subject
 * that differs from it is answered 403.
 *
 * Erasure honesty: POST /api/privacy/erasure returns 200 with
 * the cascade report even when a leg deferred or failed —
 * complete=false in that case, never a false pass. The HTTP
 * status reports that the request was handled; the report
 * body reports whether erasure completed. A 500 is reserved
 * for the cascade itself throwing outside the per-leg guard.
 */
import {
  admtNotice,
  applyGpcToPreferences,
  eraseSubject,
  parseSecGpc,
  type AdmtNotice,
  type ErasureLeg,
  type ErasureReport,
  type ExportPayload,
  type PrivacyPreferences,
} from "./privacyDsar";

export interface PrivacySession {
  internalUserId?: unknown;
  githubLogin?: unknown;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Returns the caller's own subject id, or null when it cannot be named. */
function ownSubject(session: PrivacySession | null): string | null {
  if (!session) return null;
  return typeof session.internalUserId === "string" && session.internalUserId.length > 0
    ? session.internalUserId
    : null;
}

/**
 * Shared gate: 401 without a session, 403 for a legacy session
 * (no internalUserId) or a subject mismatch, 405 for a wrong
 * method. Returns the subject on pass, or the Response to return.
 */
function gate(
  session: PrivacySession | null,
  method: string,
  allowed: string,
  requestedSubject?: string,
): { subject: string } | Response {
  if (!session) return json({ error: "unauthorized" }, 401);
  if (method !== allowed) return json({ error: "method_not_allowed" }, 405);
  const subject = ownSubject(session);
  if (!subject) return json({ error: "forbidden" }, 403);
  if (requestedSubject !== undefined && requestedSubject !== subject) {
    return json({ error: "forbidden" }, 403);
  }
  return { subject };
}

export interface PrivacyStatusInput {
  session: PrivacySession | null;
  method: string;
  secGpcHeader: string | null;
  preferences: PrivacyPreferences;
}

/**
 * GET /api/privacy/status: the ADMT pre-use notice (PRV-003), the
 * request's GPC state (PRV-004), and the subject's effective
 * preferences — GPC on the request forces opt-outs on in the
 * response, so a GPC browser always sees itself as opted out.
 */
export async function handlePrivacyStatusRoute(input: PrivacyStatusInput): Promise<Response> {
  const gated = gate(input.session, input.method, "GET");
  if (gated instanceof Response) return gated;
  const gpcOptOut = parseSecGpc(input.secGpcHeader);
  const preferences = applyGpcToPreferences(input.preferences, gpcOptOut);
  const notice: AdmtNotice = admtNotice(preferences);
  return json({ subject: gated.subject, gpcOptOut, preferences, admtNotice: notice }, 200);
}

export interface PrivacyPreferencesInput {
  session: PrivacySession | null;
  method: string;
  subject: string;
  secGpcHeader: string | null;
  body: unknown;
  load: (subject: string) => Promise<PrivacyPreferences>;
  save: (subject: string, prefs: PrivacyPreferences) => Promise<void>;
}

/**
 * GET/POST /api/privacy/preferences: the ADMT opt-out mechanism
 * (PRV-003) and the stored sale/sharing opt-out (PRV-004).
 * POST accepts only boolean fields; anything else is ignored,
 * never coerced — an unknown field cannot flip an opt-out.
 * A GPC header on the request forces both opt-outs on at save
 * time, so the stored record can never contradict a live GPC
 * signal the subject just sent.
 */
export async function handlePrivacyPreferencesRoute(
  input: PrivacyPreferencesInput,
): Promise<Response> {
  if (input.method !== "GET" && input.method !== "POST") {
    const gated = gate(input.session, input.method, "GET", input.subject);
    if (gated instanceof Response) return gated;
    return json({ error: "method_not_allowed" }, 405);
  }
  const gated = gate(input.session, input.method, input.method, input.subject);
  if (gated instanceof Response) return gated;
  const current = await input.load(gated.subject);
  if (input.method === "GET") {
    return json({ subject: gated.subject, preferences: current }, 200);
  }
  const body = (input.body ?? {}) as Record<string, unknown>;
  const next: PrivacyPreferences = {
    saleSharingOptOut:
      typeof body.saleSharingOptOut === "boolean" ? body.saleSharingOptOut : current.saleSharingOptOut,
    admtOptOut: typeof body.admtOptOut === "boolean" ? body.admtOptOut : current.admtOptOut,
  };
  const effective = applyGpcToPreferences(next, parseSecGpc(input.secGpcHeader));
  await input.save(gated.subject, effective);
  return json({ subject: gated.subject, preferences: effective }, 200);
}

export interface PrivacyExportInput {
  session: PrivacySession | null;
  method: string;
  subject: string;
  loadExport: (subject: string) => Promise<ExportPayload>;
}

/** GET /api/privacy/export: the user-facing export endpoint (PRV-002). */
export async function handlePrivacyExportRoute(input: PrivacyExportInput): Promise<Response> {
  const gated = gate(input.session, input.method, "GET", input.subject);
  if (gated instanceof Response) return gated;
  try {
    const payload = await input.loadExport(gated.subject);
    return json(payload, 200);
  } catch (err) {
    console.error(
      "[privacy] Export failed:",
      err instanceof Error ? err.message : String(err),
    );
    return json({ error: "privacy_export_failed" }, 500);
  }
}

export interface PrivacyErasureInput {
  session: PrivacySession | null;
  method: string;
  subject: string;
  legs: ErasureLeg[];
}

/**
 * POST /api/privacy/erasure: the automated erasure cascade
 * (PRV-001). The response body IS the cascade report; a
 * deferred or failed leg yields complete=false, never a 500
 * (the request was handled) and never a false pass.
 */
export async function handlePrivacyErasureRoute(input: PrivacyErasureInput): Promise<Response> {
  const gated = gate(input.session, input.method, "POST", input.subject);
  if (gated instanceof Response) return gated;
  try {
    const report: ErasureReport = await eraseSubject(gated.subject, input.legs);
    return json(report, 200);
  } catch (err) {
    console.error(
      "[privacy] Erasure cascade failed:",
      err instanceof Error ? err.message : String(err),
    );
    return json({ error: "privacy_erasure_failed" }, 500);
  }
}
