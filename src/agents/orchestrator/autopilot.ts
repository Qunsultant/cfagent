/**
 * Issue #992: Autopilot policy envelope (state, settings-backed limits, verdict evaluation) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * AutopilotContext.
 */

import type { AgentContext } from "agents";
import { createOrchestratorTablePorts, type OrchestratorTablePorts } from "../../data/createOrchestratorTablePorts";
import type { DatabaseORM } from "../../orm";
import type { AgentName, Env } from "../../types";
import { getValidTokens, etradeIdentityFromLogin } from "../../security/etradeOAuth";
import { ETradeRestClient } from "../../trading";
import { AGENT_DIDS } from "../did";
import {
  attestVerdict,
  buildAccountStateFromBalance,
  describeVerdict,
  evaluatePolicy,
  normalizeAutopilotLimits,
  type AutopilotAccountState,
  type OrderIntent,
  type PolicyVerdict,
  type PolicyVerdictAttestation,
} from "../../services/riskPolicyEngine";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/autopilot",
});

/**
 * Ports the autopilot functions receive from the class. The state key
 * remains the class's static (AUTOPILOT_STATE_KEY); it is passed by
 * value so the stored key string is unchanged.
 */
export interface AutopilotContext {
  env: Env;
  ensureTables: () => AgentContext["storage"]["sql"];
  getOrm: () => DatabaseORM;
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
  autopilotStateKey: string;
}

export function marketDateKey(now: Date = new Date()): string {
  // Daily order budgets roll at 00:00 UTC. Deliberately simple and
  // deterministic; an exchange-local (America/New_York) rollover is a
  // follow-up that needs tz-aware handling.
  return now.toISOString().slice(0, 10);
}

/** The family's ports over the context's sql handle (#2359). */
function ports(ctx: AutopilotContext): OrchestratorTablePorts {
  return createOrchestratorTablePorts(ctx.ensureTables() as never);
}

export function readAutopilotStateRaw(ctx: AutopilotContext): Record<string, any> {
  try {
    const raw = ports(ctx).autopilot.getValue(ctx.autopilotStateKey);
    return raw ? (JSON.parse(raw) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

export function getAutopilotState(ctx: AutopilotContext) {
  const raw = readAutopilotStateRaw(ctx, );
  const today = marketDateKey();
  const storedDate = typeof raw.ordersDate === "string" ? raw.ordersDate : today;
  return {
    running: Boolean(raw.running),
    killSwitch: Boolean(raw.killSwitch),
    killSwitchReason: (raw.killSwitchReason as string | null) ?? null,
    limits: normalizeAutopilotLimits(raw.limits ?? null),
    ordersToday: storedDate === today ? Number(raw.ordersToday) || 0 : 0,
    ordersDate: today,
    peakEquity: typeof raw.peakEquity === "number" && Number.isFinite(raw.peakEquity) ? raw.peakEquity : null,
    updatedAt: (raw.updatedAt as string | null) ?? null,
  };
}

export function writeAutopilotState(ctx: AutopilotContext, patch: Record<string, unknown>) {
  const current = getAutopilotState(ctx, );
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  try {
    ports(ctx).autopilot.putValue(
      ctx.autopilotStateKey,
      JSON.stringify(next),
      next.updatedAt
    );
  } catch (err) {
    structuredLog.warn("autopilot.persist_state_failed", {
      message: "[OrchestratorAgent] Autopilot: failed to persist state:",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return next;
}

/** Counts a broker submission against today's autonomous order budget. */
export function incrementAutopilotOrdersToday(ctx: AutopilotContext): void {
  const state = getAutopilotState(ctx, );
  writeAutopilotState(ctx, { ordersToday: state.ordersToday + 1, ordersDate: state.ordersDate });
}

/** Best-effort broker balance snapshot; null when unavailable. */
export async function fetchBrokerBalanceSnapshot(ctx: AutopilotContext, userLogin: string, requestedEnv: unknown): Promise<unknown | null> {
  try {
    // Issue #2442 S3: the snapshot verdict resolves identity via the
    // alias record, so it agrees with the panel instead of missing
    // internal-id and alias-login keys. The data leg below (the
    // client) is untouched here; S2 (#2441) owns the client.
    const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
    const valid = await getValidTokens(ctx.env, userLogin, requestedEnv as any, identity);
    if (!valid) return null;
    const client = new ETradeRestClient(ctx.env, userLogin, requestedEnv as any);
    const accounts = await client.fetchAccounts();
    const key = accounts?.[0]?.accountKey || accounts?.[0]?.accountId;
    if (!key) return null;
    return await client.fetchBalance(key);
  } catch (err) {
    structuredLog.warn("autopilot.balance_snapshot_unavailable", {
      message: "[OrchestratorAgent] Autopilot: balance snapshot unavailable:",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Net open exposure for a symbol from the executed trade ledger. A canonical
 * live-book feed is a follow-up; until then this is the book view available
 * server-side, and a null result makes the envelope fail closed.
 */
export function openNotionalForSymbol(ctx: AutopilotContext, symbol: string): number | null {
  try {
    const trades = ctx.getOrm().trades?.findMany({}) as Array<Record<string, any>> | undefined;
    if (!trades) return null;
    const target = symbol.toUpperCase();
    let net = 0;
    for (const t of trades) {
      if (String(t.symbol || "").toUpperCase() !== target) continue;
      if (String(t.status || "") !== "executed") continue;
      const qty = Number(t.quantity) || 0;
      const price = Number(t.price) || 0;
      net += String(t.action || "").toUpperCase().startsWith("SELL") ? -qty * price : qty * price;
    }
    return Math.max(0, net);
  } catch {
    return null;
  }
}

/**
 * Evaluates the envelope, signs the verdict server-side, and records it.
 * Used by the preview gate, the execute gate, and the dry-run endpoint.
 */
export async function evaluateAndRecordAutopilotVerdict(ctx: AutopilotContext, params: {
  userLogin: string;
  requestedEnv: unknown;
  sessionId: string;
  intent: OrderIntent;
  draftId?: string | null;
  dryRun?: boolean;
}): Promise<{ verdict: PolicyVerdict; attestation: PolicyVerdictAttestation }> {
  const state = getAutopilotState(ctx, );
  const balance = await fetchBrokerBalanceSnapshot(ctx, params.userLogin, params.requestedEnv);
  const accountState: AutopilotAccountState = buildAccountStateFromBalance(balance, {
    ordersToday: state.ordersToday,
    peakEquity: state.peakEquity,
    asOf: new Date().toISOString(),
  });
  // Overlay the per-symbol exposure a balance payload cannot express.
  accountState.positionNotionalForSymbol = openNotionalForSymbol(ctx, params.intent.symbol);

  const verdict = evaluatePolicy({
    intent: params.intent,
    limits: state.limits,
    flags: { running: state.running, killSwitch: state.killSwitch, killSwitchReason: state.killSwitchReason },
    state: accountState,
    dryRun: params.dryRun,
  });

  const attestation = await attestVerdict(verdict, {
    signingKey: ctx.env.SESSION_SECRET,
    authorizerDid: state.running ? AGENT_DIDS.ORCHESTRATOR : "did:user:pending-human-authorization",
  });

  // Track peak equity so drawdown can be computed on later evaluations.
  if (accountState.equity !== null && (state.peakEquity === null || accountState.equity > state.peakEquity)) {
    writeAutopilotState(ctx, { peakEquity: accountState.equity });
  }

  try {
    ports(ctx).verdicts.insertVerdict({
      id: verdict.verdictId,
      sessionId: params.sessionId,
      symbol: verdict.intents.symbol,
      action: verdict.intents.action,
      quantity: verdict.intents.quantity,
      notional: verdict.intents.notional,
      mode: verdict.mode,
      dryRun: verdict.dryRun,
      passed: verdict.passed,
      executionAllowed: verdict.executionAllowed,
      requiresApproval: verdict.requiresApproval,
      bindingRule: verdict.bindingRule,
      detail: verdict.detail,
      limitsJson: JSON.stringify(verdict.limits),
      projectionsJson: JSON.stringify(verdict.projections),
      findingsJson: JSON.stringify(verdict.findings),
      signature: attestation.signature,
      signingKeyId: attestation.keyId,
      proposerDid: attestation.proposerDid,
      authorizerDid: attestation.authorizerDid,
      createdAt: verdict.evaluatedAt,
    });
  } catch (err) {
    structuredLog.warn("autopilot.persist_verdict_failed", {
      message: "[OrchestratorAgent] Autopilot: failed to persist verdict:",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Ledger event the control center already knows how to render.
  ctx.audit("autopilot.policy_verdict", "trading", {
    verdictId: verdict.verdictId,
    draftId: params.draftId ?? null,
    symbol: verdict.intents.symbol,
    summary: `${verdict.intents.action} ${verdict.intents.quantity} ${verdict.intents.symbol}${
      verdict.dryRun ? " (dry run)" : ""
    }`,
    policyCheckRule: describeVerdict(verdict),
    policyCheckPassed: verdict.passed,
    status: !verdict.passed || !verdict.executionAllowed
      ? "blocked"
      : verdict.requiresApproval
      ? "routed_to_approval"
      : "verified",
    bindingRule: verdict.bindingRule,
    dryRun: Boolean(verdict.dryRun),
    mode: verdict.mode,
    proposerDid: attestation.proposerDid,
    authorizerDid: attestation.authorizerDid,
    proofSignature: attestation.signature,
    projections: verdict.projections,
  });

  return { verdict, attestation };
}
