/**
 * #1755 (parent #1717) — the single PEP gateway PATTERN.
 *
 * Decision (recorded on #1755 before this build): the PEPs do NOT
 * collapse to a single runtime gateway — requireAuth (401 before
 * any permission is evaluated), the integration:connect gates
 * (session + tenant resolution + the #1749 legacy-grace rule),
 * and the schedule/access-request gates have irreducibly different
 * preconditions. What consolidates is the PATTERN: this one helper
 * implements the shouldEnforcePdp + permission + grace-expired-403
 * mapping that was copy-pasted, identically, at the four
 * integration:connect sites in src/server.ts (E*TRADE/Public start
 * + verifier), and all four sites now call it. Its outcomes map
 * byte-identically onto those blocks' responses:
 *   enforced:false            -> pre-change path, no response
 *   enforced:true, allowed    -> proceed
 *   enforced:true, denied, graceExpired:true  -> 403 legacy_pdp_grace_expired
 *   enforced:true, denied, graceExpired:false -> 403 authorization denied
 *
 * The helper decides through the PDP port (createInProcessPdp):
 * policy from the platform-only resolver (compiled by default;
 * a snapshot only when the platform configured one), attributes
 * from the membership store adapted to the PIP port. It performs
 * no enforcement itself and changes no decision — it only removes
 * the duplication between the four call sites.
 */

import {
  membershipStoreToAttributeProvider,
  type MembershipStore,
  type Permission,
  type PermissionDenialReader,
} from "./authorization";
import {
  isLegacyPdpGraceExpired,
  shouldEnforcePdp,
} from "./iaaaGithubEndToEnd";
import {
  compiledPolicyProvider,
  createInProcessPdp,
  resolvePdpPolicySource,
  snapshotPolicyProvider,
} from "./pdpPorts";
import type { Env, SessionData } from "../types";

export type RoutePepOutcome =
  | { enforced: false }
  | { enforced: true; allowed: true }
  | { enforced: true; allowed: false; graceExpired: boolean };

export interface RoutePepInput {
  /** Worker env (IAAA_PDP_ENABLED + the platform-only policy switches). */
  env: Partial<Env> & {
    IAAA_PDP_POLICY_SOURCE?: unknown;
    IAAA_PDP_POLICY_SNAPSHOT_JSON?: unknown;
  };
  session: SessionData | null | undefined;
  tenantId: string;
  permission: Permission;
  membershipStore: MembershipStore;
  /**
   * #2450: when supplied, the PDP honors per-user permission
   * denials (deny-beats-grant) for this check. Without it the
   * decision is denial-unaware, exactly as before. The four
   * integration:connect gates pass the KV denial store.
   */
  permissionDenialStore?: PermissionDenialReader;
  nowMs: number;
}

export async function evaluateRoutePep(
  input: RoutePepInput,
): Promise<RoutePepOutcome> {
  const { env, session, tenantId, permission, membershipStore, permissionDenialStore, nowMs } = input;
  if (!shouldEnforcePdp(env, session, nowMs)) {
    return { enforced: false };
  }
  const graceExpired = isLegacyPdpGraceExpired(env, session, nowMs);
  if (!session?.internalUserId) {
    // Same as checkRoutePermission: no internal id, nothing to evaluate.
    return { enforced: true, allowed: false, graceExpired };
  }
  const resolved = resolvePdpPolicySource(
    env as unknown as Record<string, unknown>,
  );
  const pdp = createInProcessPdp({
    policyProvider:
      resolved.source === "snapshot" && resolved.snapshot
        ? snapshotPolicyProvider(resolved.snapshot)
        : compiledPolicyProvider(),
    attributeProvider: membershipStoreToAttributeProvider(
      membershipStore,
      permissionDenialStore,
    ),
  });
  const decision = await pdp.decide({
    internalUserId: session.internalUserId,
    tenantId,
    permission,
    nowMs,
  });
  if (decision.decision === "allow") {
    return { enforced: true, allowed: true };
  }
  return { enforced: true, allowed: false, graceExpired };
}

/**
 * #4653 — the PEP gate inventory for the SecHub PEP tab
 * (`GET /api/security/pep`).
 *
 * Every evaluateRoutePep / evaluateAgentSchedulePdp call site, as one
 * cited list kept next to the gateway they all call — not a second
 * copy, and not a tunable: no env var, session value, or config
 * entry can add, remove, or re-permission a gate (the same shape as
 * the PDP slice's cited coverage map in
 * src/server/routes/auth.ts, #4651). A wiring change updates this
 * list in place, and tests/sechub_pep_endpoint_4653.test.ts pins
 * each entry against its cited source file (gateway name +
 * permission/action literal + route literal), so a moved call site
 * fails loudly instead of silently shrinking the tab.
 *
 * Notes on the two non-obvious entries:
 * - `/auth/etrade/start` and `/api/etrade/oauth/start` share one
 *   branch (one call site, two routes) — both are listed, because
 *   the tab lists gated ROUTES.
 * - The fifth evaluateRoutePep site lives in
 *   src/server/routes/trading.ts (`/api/schedule/goals/approvals/...`,
 *   permission `action:approve`): the #4653 issue text names only the
 *   four `integration:connect` sites, but the acceptance criterion is
 *   "no route missing, none invented", so the live fifth site is
 *   listed too.
 * - The schedule gates match by suffix inside the ScheduledAgent DO
 *   (`endsWith("/schedules/webhook/followup")`, a regex for
 *   `/schedules/approvals/:id/(approve|reject)`); the routes below
 *   are the edge-facing `/api/...` addresses callers use.
 */
export type PepGatewayName = "evaluateRoutePep" | "evaluateAgentSchedulePdp";

export interface PepGateInfo {
  /** The route as a caller addresses it. */
  route: string;
  method: "GET" | "POST";
  /** The permission (route PEP) or action (schedule PDP) the gate checks. */
  permission: string;
  gateway: PepGatewayName;
  /** File holding the call site. */
  source: string;
  /** The denied response the gate returns, in business terms. */
  denied: string;
}

const PEP_DENIED_ROUTE =
  "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied";

export const PEP_GATE_INVENTORY: readonly PepGateInfo[] = [
  {
    route: "/auth/etrade/start",
    method: "GET",
    permission: "integration:connect",
    gateway: "evaluateRoutePep",
    source: "src/server/routes/auth.ts",
    denied: PEP_DENIED_ROUTE,
  },
  {
    route: "/api/etrade/oauth/start",
    method: "GET",
    permission: "integration:connect",
    gateway: "evaluateRoutePep",
    source: "src/server/routes/auth.ts",
    denied: PEP_DENIED_ROUTE,
  },
  {
    route: "/api/etrade/oauth/verifier",
    method: "POST",
    permission: "integration:connect",
    gateway: "evaluateRoutePep",
    source: "src/server/routes/auth.ts",
    denied: PEP_DENIED_ROUTE,
  },
  {
    route: "/auth/public/start",
    method: "GET",
    permission: "integration:connect",
    gateway: "evaluateRoutePep",
    source: "src/server/routes/auth.ts",
    denied: PEP_DENIED_ROUTE,
  },
  {
    route: "/api/public/connect",
    method: "POST",
    permission: "integration:connect",
    gateway: "evaluateRoutePep",
    source: "src/server/routes/auth.ts",
    denied: PEP_DENIED_ROUTE,
  },
  {
    route: "/api/schedule/goals/approvals/:id/(approve|reject)",
    method: "POST",
    permission: "action:approve",
    gateway: "evaluateRoutePep",
    source: "src/server/routes/trading.ts",
    denied: PEP_DENIED_ROUTE,
  },
  {
    route: "/api/schedules/webhook/followup",
    method: "POST",
    permission: "task:create",
    gateway: "evaluateAgentSchedulePdp",
    source: "src/agents/routes/schedules.ts",
    denied:
      "403 — this webhook caller is not authorized to mint a schedule follow-up (denial audited)",
  },
  {
    route: "/api/schedules/approvals/:id/(approve|reject)",
    method: "POST",
    permission: "action:approve",
    gateway: "evaluateAgentSchedulePdp",
    source: "src/agents/routes/schedules.ts",
    denied: "403 — approval denied by policy",
  },
];
