/**
 * Issue #359-04: audit routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the audit-log read route (GET /api/audit) and the two audit-write
 * routes (POST /api/audit, POST /api/audit/event), all operating on the
 * mas_events table implemented under #270/PR #302. The three blocks were
 * contiguous in routeRequest (between the ads/revenue/referrals handler and
 * the autopilot block), so this module exports ONE handler invoked from
 * routeRequest at the EXACT position the original blocks occupied in the
 * sequential path.endsWith matching sequence. It returns a Response when one
 * of its paths matches, or null when none does — matching order relative to
 * all other handlers is preserved by the call site.
 *
 * The audit writes funnel through the single owner recordAudit() (issue
 * #270): POST /audit calls the audit() seam (which delegates to
 * recordAudit()), and POST /api/audit/event calls recordAudit() directly.
 * The extraction keeps that delegation exactly — nothing is inlined here.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit AuditRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import type { AgentName } from "../../types";
import { DatabaseORM, type SqlStorage } from "../../orm";
import { codedMessage, resolveOutcome } from "../../outcomes/outcomeAspects";
import { requestInvalidResponse } from "../../api/requestValidation";
import { runRestTool } from "./restToolBridge";
import { auditEventPort } from "../../data/createAuditEventPorts";
import {
  resolveAuditWriteRestSwitch,
  validateStrictAuditWrite,
  type RestTwinsScopedModes,
} from "../../config/restTwinsModes";
import { COMMERCIAL_DEFAULTS } from "../../config/commercialDefaults";
import { settingReadFromSql } from "../../services/screeningFlags";
import {
  AUDIT_CHAIN_LAST_VERIFICATION_KEY,
  parseAuditChainVerificationRecord,
} from "../../services/auditChainVerification";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #5606 (G-3) — module logger on the structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/audit",
});


/** The subset of OrchestratorAgent surface the audit handlers need. */
export interface AuditRouteContext {
  ensureTables(): SqlStorage;
  /**
   * #1644: ORM accessor for command execution. Optional — routes without
   * it build a DatabaseORM over ensureTables() (same tables, no seeding).
   */
  getOrm?: () => DatabaseORM;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Single owner of audit-row inserts (issue #270): inserts one mas_events row (D1, #6102). */
  recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>
  ): Promise<{ id: string; type: string; agent: string; payload: Record<string, unknown>; created_at: string }>;
  /** #1733: Worker env for the AUDIT_WRITE_MODE global-env level (optional — unset falls through to legacy). */
  env?: unknown;
  /** #1733: optional session/user carriers for AUDIT_WRITE_MODE (run comes from body `mode` / query `?mode=`). Populated by the execution-context owner; unset carriers fall through to env. See src/config/restTwinsModes.ts. */
  scopedAuditModes?: RestTwinsScopedModes;
}

/** #1733: adapts this module's route context to the restTwinsModes switch host (the ctx audit type is narrower than the host's, so it is wrapped rather than passed through). */
function auditSwitchHost(ctx: AuditRouteContext) {
  return {
    scopedAuditModes: ctx.scopedAuditModes,
    env: ctx.env,
    audit: (type: string, agent: any, payload: Record<string, unknown>) => ctx.audit(type, agent, payload),
  };
}

/** #2371: code candidates from a parsed payload, in precedence order.
 * `coded_error` (the explicit outcome field) first, then `code`. Each
 * may be a bare code string, a "[CODE] message" rendering, or an
 * object carrying a `code` string. Anything else yields no candidate. */
function codeCandidates(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["coded_error", "code"]) {
    const v = payload[key];
    if (typeof v === "string") {
      out.push(v);
    } else if (v && typeof v === "object" && typeof (v as Record<string, unknown>).code === "string") {
      out.push((v as Record<string, unknown>).code as string);
    }
  }
  return out;
}

/**
 * #2371 (renders the #2381 outcome catalog): read-time aspect
 * resolution for one parsed payload. Returns the first cataloged code
 * found (coded_error before code), or null when nothing resolves.
 * Resolution goes through the single outcome resolver only
 * (resolveOutcome, alias-aware, never throws, never invents a code):
 * a pre-rename string resolves to the NEW code's aspects, an unknown
 * code passes through unresolved, and a bracketed "[CODE] ..."
 * rendering resolves only through its bracketed code. This is a
 * projection over the catalog — not a second resolver — and it never
 * touches stored rows.
 */
export interface ResolvedAuditAspects {
  code: string;
  businessMessage: string;
  category: string;
  retryable: boolean;
  /** Audit-channel variant: the established "[CODE] business message" rendering. */
  variant: string;
}

function resolveAuditAspects(payload: Record<string, unknown>): ResolvedAuditAspects | null {
  try {
    for (const candidate of codeCandidates(payload)) {
      const trimmed = candidate.trim();
      const bracket = /^\[([^\]]+)\]/.exec(trimmed);
      const codes = bracket ? [bracket[1], trimmed] : [trimmed];
      for (const code of codes) {
        const resolved = resolveOutcome(code);
        if (resolved.resolved && resolved.entry) {
          return {
            code: resolved.entry.code,
            businessMessage: resolved.entry.businessMessage,
            category: resolved.entry.category,
            retryable: resolved.entry.retryable,
            variant: codedMessage(resolved.entry.code),
          };
        }
      }
    }
  } catch {
    // A read never fails because of resolution.
    return null;
  }
  return null;
}

/** 5-field audit projection shared by the list and detail endpoints: the
 * payload-JSON parse with { raw } fallback. The payload column is TEXT
 * (recordAudit stringifies), so a stored object can only arrive via a
 * foreign writer — { raw } keeps it readable instead of throwing.
 * #2371: adds the additive `resolvedAspects` field (read-time only —
 * the stored payload is returned unchanged and no row is rewritten). */
function projectAuditEvent(e: { id: string; type: string; agent: string; payload: string; createdAt: string }) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(e.payload);
  } catch {
    payload = { raw: e.payload };
  }
  return { id: e.id, type: e.type, agent: e.agent, payload, created_at: e.createdAt, resolvedAspects: resolveAuditAspects(payload) };
}

/**
 * Handles the audit routes. Returns a Response on match, null when no
 * audit path matches (the orchestrator then continues its sequential matching).
 */
export async function handleAuditRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AuditRouteContext
): Promise<Response | null> {
  // Issue #2437: audit-chain verification status (read-only). Returns the
  // persisted last-verification record written by the nightly retention
  // pass, so an operator can see when the chain last verified OK (and up
  // to which row) — or that it has never verified. The record is
  // instance-level (the shared Orchestrator instance's chain, like the
  // retention pass itself), not a session row, so no session filter
  // applies. Placed BEFORE the /audit/:id detail branch, whose regex
  // would otherwise swallow this segment.
  if (path.endsWith("/audit/chain-verification") && request.method === "GET") {
    try {
      const sql = ctx.ensureTables();
      const stored = settingReadFromSql(sql)(AUDIT_CHAIN_LAST_VERIFICATION_KEY);
      const record = parseAuditChainVerificationRecord(stored);
      if (!record) {
        return Response.json({ verified: false, reason: "never verified" });
      }
      return Response.json({ verified: true, ...record });
    } catch (err) {
      // #5606 (G-3): no raw store text reaches the client;
      // the detail stays in the server log.
      structuredLog.error("audit.fetch_audit_chain_verification", {
        message: `[audit] fetch audit chain verification failed: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: "Failed to fetch audit chain verification", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
    }
  }

  // Audit event detail endpoint (#1968)
  // GET /api/audit/:id returns one event with its full payload. The id
  // is session-scoped: an unknown id and a row from another session both
  // answer the same 404, so the endpoint never leaks cross-session
  // existence. The "event" segment is excluded so the POST /audit/event
  // write route keeps its existing fall-through behavior.
  const detailMatch = path.match(/\/audit\/([^/]+)$/);
  if (detailMatch && detailMatch[1] !== "event" && request.method === "GET") {
    try {
      // #6102: the event log lives in D1 now; a null port (AGENT_DB
      // unbound) fails closed — the DO table is frozen pre-cutover
      // history and is never read back here.
      const port = await auditEventPort(
        ctx.env as unknown as { AGENT_DB?: unknown },
      );
      if (!port) {
        return Response.json({ error: "Failed to fetch audit event", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
      }
      const row = await port.findById(detailMatch[1]);
      if (!row || row.sessionId !== sessionId) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json(projectAuditEvent(row as unknown as { id: string; type: string; agent: string; payload: string; createdAt: string }));
    } catch (err) {
      // #5606 (G-3): no raw store text reaches the client;
      // the detail stays in the server log.
      structuredLog.error("audit.fetch_audit_event", {
        message: `[audit] fetch audit event failed: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: "Failed to fetch audit event", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
    }
  }

  // Audit logs endpoint
  // #1644: the event query executes through the get_audit_events command.
  // The route keeps its contract as presentation: the 1..100 limit clamp,
  // the session_id filter (defense-in-depth — the ORM is per-DO-instance,
  // and recordAudit writes this instance's session key on every row),
  // the payload-JSON parse with { raw } fallback, and the 5-field
  // projection. #1968: the query params are passed INTO the command so
  // filtering happens before the limit is applied — the pre-fix route
  // fetched the newest 50 events overall and ignored every param, so a
  // type or time filter could never surface an older matching event.
  // `type` accepts the `event_type` alias; `before`/`after` accept the
  // `to`/`from` aliases. A non-numeric limit still clamps to NaN and
  // slices to zero rows (pinned by audit_routes_extraction.test.ts).
  if (path.endsWith("/audit") && request.method === "GET") {
    try {
      // #5611 (G-14): the default limit reads from COMMERCIAL_DEFAULTS;
      // the value stays 50, only its home moved. `||` is preserved so
      // the empty-string param behaves exactly as before.
      const limitParam = Number(url.searchParams.get("limit") || COMMERCIAL_DEFAULTS.auditDefaultLimit);
      const limit = Math.max(1, Math.min(100, limitParam));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
      const type = url.searchParams.get("type") ?? url.searchParams.get("event_type") ?? undefined;
      const agent = url.searchParams.get("agent") ?? undefined;
      const before = url.searchParams.get("before") ?? url.searchParams.get("to") ?? undefined;
      const after = url.searchParams.get("after") ?? url.searchParams.get("from") ?? undefined;
      const orm = ctx.getOrm?.() ?? new DatabaseORM(ctx.ensureTables());
      const out = (await runRestTool("get_audit_events", {
        limit: before || after ? 1000 : limit,
        ...(type ? { type } : {}),
        ...(agent ? { agent } : {}),
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      }, {
        orm,
        sessionId,
        audit: (type, agent, payload) => ctx.audit(type, agent, payload),
        // #6102: the command resolves the D1 event port from env.
        env: ctx.env,
      })) as { events: Array<{ id: string; sessionId: string; type: string; agent: string; payload: string; createdAt: string }> };

      const parsed = out.events
        .filter((e) => e.sessionId === sessionId)
        .slice(offset, offset + limit)
        .map(projectAuditEvent);

      return Response.json({ count: parsed.length, events: parsed });
    } catch (err) {
      // #5606 (G-3): no raw store text reaches the client;
      // the detail stays in the server log.
      structuredLog.error("audit.fetch_audit_log", {
        message: `[audit] fetch audit log failed: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: "Failed to fetch audit log", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
    }
  }

  if (path.endsWith("/audit") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // #1733 R04: audit-write mode (run body `mode` / query `?mode=`
      // > session > user > env > legacy). legacy = this route's
      // untouched unvalidated contract below; strict = the
      // /audit/event validation applied to this spelling, keeping
      // its own defaults (type=autopilot.policy_check,
      // agent=trading) and its 200 shape. Invalid mode fails
      // closed to legacy + audit.config_error (in the resolver).
      const writeMode = resolveAuditWriteRestSwitch(
        auditSwitchHost(ctx),
        body?.mode ?? url.searchParams.get("mode"),
        "legacy"
      );
      if (writeMode === "strict") {
        const validated = validateStrictAuditWrite(
          { ...body, type: body?.type ?? "autopilot.policy_check" },
          "trading"
        );
        if (!validated.ok) {
          // #5604: the strict-validation 400 is coded; the message is unchanged.
          return requestInvalidResponse(validated.error);
        }
        ctx.audit(
          validated.value.type,
          validated.value.agent as AgentName | "judge" | "nlq" | "orchestrator",
          validated.value.payload
        );
        return Response.json({ success: true, message: "Audit event recorded" });
      }
      const type = String(body.type || "autopilot.policy_check");
      const agent = (body.agent || "trading") as AgentName | "judge" | "nlq" | "orchestrator";
      const payload = (body.payload && typeof body.payload === "object") ? body.payload : body;
      ctx.audit(type, agent, payload);
      return Response.json({ success: true, message: "Audit event recorded" });
    } catch (err) {
      // #5606 (G-3): no raw store text reaches the client;
      // the detail stays in the server log.
      structuredLog.error("audit.record_failed", {
        message: `[audit] record failed failed: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: "Failed to record audit event", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
    }
  }

  // Audit event append — advertised by the WorkflowsHub Observability card
  // as "POST /api/audit/event" (issue #270). Same mas_events idiom as
  // POST /audit, but with strict validation and the stored record echoed
  // back, so callers need no second GET. Tenant-scoped like every other
  // audit row: session_id is the per-user Durable Object instance key.
  if (path.endsWith("/audit/event") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => null)) as {
        type?: unknown;
        agent?: unknown;
        payload?: unknown;
        mode?: unknown;
      } | null;
      // #1733 R04: the switch is resolved here only so an invalid
      // value audits audit.config_error; this spelling is strict in
      // EVERY mode — the switch never loosens it. Validation is the
      // shared port helper (byte-identical messages and bounds to
      // the inline code it replaces).
      resolveAuditWriteRestSwitch(
        auditSwitchHost(ctx),
        body?.mode ?? url.searchParams.get("mode"),
        "legacy"
      );
      const validated = validateStrictAuditWrite(body, "orchestrator");
      if (!validated.ok) {
        // #5604: the strict-validation 400 is coded; the message is unchanged.
        return requestInvalidResponse(validated.error);
      }
      const record = await ctx.recordAudit(validated.value.type, validated.value.agent, validated.value.payload);
      return Response.json(record, { status: 201 });
    } catch (err) {
      // #5606 (G-3): no raw store text reaches the client;
      // the detail stays in the server log.
      structuredLog.error("audit.record_event_failed", {
        message: `[audit] record event failed failed: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: "Failed to record audit event", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
    }
  }

  return null;
}
