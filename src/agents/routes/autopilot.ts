/**
 * Issue #359-05: autopilot routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the Autopilot control center routes (autopilot Phase 1): server-owned
 * run state, limits, kill switch, and policy verdicts —
 * GET /autopilot, POST /autopilot/state, POST /autopilot/kill-switch,
 * POST|PUT /autopilot/limits, POST /autopilot/evaluate.
 * The five blocks were contiguous in routeRequest (between the audit handler
 * and the Persistent Memory endpoint), so this module exports ONE handler
 * invoked from routeRequest at the EXACT position the original blocks
 * occupied in the sequential path.endsWith matching sequence. It returns a
 * Response when one of its paths matches, or null when none does — matching
 * order relative to all other handlers is preserved by the call site.
 *
 * Policy verdict evaluation stays delegated to the orchestrator-owned
 * evaluateAndRecordAutopilotVerdict() via the context — this module never
 * inlines the policy engine pipeline, the mas_policy_verdicts insert, or
 * the balance snapshot logic.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit AutopilotRouteContext parameter; there are no new globals and
 * no back-references into the class.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { createOrchestratorTablePorts } from "../../data/createOrchestratorTablePorts";
import type { AgentName, Env } from "../../types";
import type { SqlStorage } from "../../orm";
import {
  normalizeAutopilotLimits,
  type AutopilotPolicyLimits,
  type OrderIntent,
  type PolicyVerdict,
  type PolicyVerdictAttestation,
} from "../../services/riskPolicyEngine";
import type { ExecutionAccountContext } from "../../services/accountBindings";
import { resolveValidatedExecutionAccountContext } from "../../services/accountBindings";
import { ACCOUNT_BINDING_CONFIG } from "../../config/accountBindings";
import { codedMessage, getOutcome } from "../../outcomes/outcomeAspects";
import { tradingTypeFor } from "../../trading";
import { listD1JobOutcomes } from "../../services/runLedgerReads";
import {
  resolveAutopilotVerdictTrendPolicy,
  summarizeAutopilotVerdictTrend,
} from "../../services/autopilotVerdictTrend";

/** Shape of the server-owned autopilot run state (see getAutopilotState). */
export interface AutopilotState {
  running: boolean;
  killSwitch: boolean;
  killSwitchReason: string | null;
  limits: AutopilotPolicyLimits;
  ordersToday: number;
  ordersDate: string;
  peakEquity: number | null;
  updatedAt: string | null;
}

/** The subset of OrchestratorAgent surface the autopilot handlers need. */
export interface AutopilotRouteContext {
  ensureTables(): SqlStorage;
  /** #5061: the deployment env (verdict-trend thresholds). */
  env?: Env;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  getAutopilotState(): AutopilotState;
  writeAutopilotState(patch: Record<string, unknown>): AutopilotState;
  /** Policy-verdict pipeline (owner: OrchestratorAgent). Never inlined here. */
  evaluateAndRecordAutopilotVerdict(params: {
    userLogin: string;
    requestedEnv: unknown;
    sessionId: string;
    intent: OrderIntent;
    draftId?: string | null;
    dryRun?: boolean;
    /** Issue #5100 (F3 of #5094): the validated binding resolution,
     *  recorded on the verdict. (The resolved context, not just the
     *  tuple — the verdict also carries the binding scope + source.) */
    binding?: ExecutionAccountContext;
  }): Promise<{ verdict: PolicyVerdict; attestation: PolicyVerdictAttestation }>;
}

/**
 * Handles the Autopilot control center routes. Returns a Response on match,
 * null when no autopilot path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleAutopilotRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AutopilotRouteContext
): Promise<Response | null> {
  // ---------------------------------------------------------------------
  // Autopilot control center (autopilot Phase 1): server-owned run state,
  // limits, kill switch, and policy verdicts.
  // ---------------------------------------------------------------------
  if (path.endsWith("/autopilot") && request.method === "GET") {
    try {
      const state = ctx.getAutopilotState();
      let recentVerdicts: Array<Record<string, unknown>> = [];
      try {
        // Issue #2359 (#1976 step 4d): the read serves through
        // the policy-verdict port (same projection, same
        // newest-first order) instead of raw SQL.
        recentVerdicts = createOrchestratorTablePorts(ctx.ensureTables() as never)
          .verdicts.listRecent(25) as unknown as Array<Record<string, unknown>>;
      } catch {
        recentVerdicts = [];
      }
      // Issue #5061 (AG-7): the verdicts are read for their aggregate, not
      // just listed — a binding rule that keeps blocking is named to the
      // operator here. Evidence only: the envelope changes by human edit.
      const verdictTrend = summarizeAutopilotVerdictTrend(
        recentVerdicts as unknown as Array<{
          passed: number;
          binding_rule: string | null;
          created_at: string;
        }>,
        resolveAutopilotVerdictTrendPolicy(ctx.env),
      );
      return Response.json({
        ...state,
        engine: "riskPolicyEngine",
        recentVerdicts,
        verdictTrend,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to read autopilot state" }, { status: 500 });
    }
  }

  // Issue #1333: the job-outcome sink as Autopilot Control's job
  // feed — every bridged/bus/manual/discovery outcome, newest first,
  // labeled by origin (kind + trigger + status + coded error).
  // Issue #6101 — the DO sink is gone; the feed reads the folded
  // outcome facts on the D1 run records directly.
  if (path.endsWith("/autopilot/jobs") && request.method === "GET") {
    try {
      const limitRaw = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
      const jobs = await listD1JobOutcomes(ctx.env ?? {}, { limit });
      return Response.json({ jobs, count: jobs.length });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to read job outcomes" }, { status: 500 });
    }
  }

  if (path.endsWith("/autopilot/state") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      if (typeof body.running !== "boolean") {
        return Response.json({ error: "running (boolean) is required" }, { status: 400 });
      }
      const next = ctx.writeAutopilotState({ running: body.running });
      ctx.audit("autopilot.state_changed", "trading", {
        running: next.running,
        by: request.headers.get("x-user-login") || sessionId || "unknown",
      });
      return Response.json(next);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to update autopilot state" }, { status: 500 });
    }
  }

  if (path.endsWith("/autopilot/kill-switch") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const active = Boolean(body.active);
      const reason = active
        ? String(body.reason || "Emergency stop from the autopilot control center").slice(0, 200)
        : null;
      const next = ctx.writeAutopilotState({ killSwitch: active, killSwitchReason: reason });
      ctx.audit("autopilot.kill_switch", "trading", { active, reason });
      return Response.json(next);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to update kill switch" }, { status: 500 });
    }
  }

  if (path.endsWith("/autopilot/limits") && (request.method === "POST" || request.method === "PUT")) {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const limits = normalizeAutopilotLimits(body?.limits ?? body);
      const next = ctx.writeAutopilotState({ limits });
      ctx.audit("autopilot.limits_updated", "trading", { limits });
      return Response.json(next);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to update policy limits" }, { status: 500 });
    }
  }

  if (path.endsWith("/autopilot/evaluate") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const symbol = String(body.symbol || "").trim().toUpperCase();
      const quantity = Number(body.quantity) || 0;
      if (!symbol || quantity <= 0) {
        return Response.json({ error: "symbol and a positive quantity are required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const limitPrice = body.limitPrice !== undefined ? Number(body.limitPrice) : undefined;
      // This endpoint is declared before the E*TRADE routes resolve the
      // environment header, so it resolves the same value locally.
      const envHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
      const snapshotEnv: "TEST" | "PROD" | undefined = envHeader === "TEST" || envHeader === "PROD" ? envHeader : undefined;
      // Issue #5100 (F3 of #5094): the evaluation resolves the bound
      // account first — an unbound tenant is refused with the coded
      // failure, and the resolved tuple rides the verdict record.
      // Broker comes from the tenant's stored selection (lazy import
      // — providerConnections sits on a load cycle with the trading
      // barrel); mode from tradingTypeFor; autopilot intents are
      // stock-only (OrderIntent carries no option legs).
      const bindingMissing = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
      if (!ctx.env) {
        return Response.json(
          { ok: false, code: bindingMissing, error: codedMessage(bindingMissing, "No execution environment is available to resolve the bound account.") },
          { status: getOutcome(bindingMissing)?.httpStatus ?? 404 },
        );
      }
      const { readTenantBrokerSelection } = await import("../../services/providerConnections");
      const brokerRead = await readTenantBrokerSelection(ctx.env);
      if (brokerRead.status !== "ok") {
        return Response.json(
          { ok: false, code: bindingMissing, error: codedMessage(bindingMissing, `No broker selection is configured for this tenant: ${brokerRead.error}`) },
          { status: getOutcome(bindingMissing)?.httpStatus ?? 404 },
        );
      }
      const evaluateBroker = brokerRead.brokerId;
      const evaluateMode = tradingTypeFor(evaluateBroker, snapshotEnv ?? "TEST");
      const bindingRes = await resolveValidatedExecutionAccountContext(ctx.env, userLogin, {
        broker: evaluateBroker,
        mode: evaluateMode,
        accountType: "stock",
        scope: "autopilot",
      });
      if (!bindingRes.ok) {
        return Response.json(
          { ok: false, code: bindingRes.code, error: bindingRes.error },
          { status: bindingRes.status },
        );
      }
      const { verdict, attestation } = await ctx.evaluateAndRecordAutopilotVerdict({
        userLogin,
        requestedEnv: snapshotEnv,
        sessionId,
        dryRun: body.dryRun !== false,
        binding: bindingRes.context,
        intent: {
          symbol,
          action: String(body.action || "BUY").toUpperCase(),
          quantity,
          orderType: body.orderType || "MARKET",
          estimatedPrice: Number.isFinite(limitPrice as number) ? (limitPrice as number) : null,
          estimatedTotal: Number.isFinite(Number(body.estimatedTotal)) ? Number(body.estimatedTotal) : null,
        },
      });
      return Response.json({ verdict, attestation, requestedBy: String(body.requestedBy || userLogin) });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to evaluate policy" }, { status: 500 });
    }
  }

  return null;
}
