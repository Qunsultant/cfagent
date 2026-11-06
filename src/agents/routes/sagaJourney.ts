/**
 * Saga journey routes — issue #2041 S2 (Q1 ruled: all decision
 * surfaces, first answer wins).
 *
 * Two routes, registered in src/server.ts (Worker entry, where
 * the SAGA_WORKFLOW + ORCHESTRATOR_AGENT bindings and the session
 * auth live; the caller passes the requireAuth login, mirroring
 * the extracted-route pattern — this module never imports the
 * entry point):
 * - GET /api/saga/journey-gates — pending journey gates for the
 *   session user (panel + chat surfaces poll this; a decided
 *   gate drops out of the list, which IS the panel/chat
 *   dismissal — state-driven cleanup, no explicit action).
 * - POST /api/saga/journey-decision { sagaId, decision, surface }
 *   — answer a gate from the panel or chat surface. Owner check:
 *   the gate must be pending for the session login (a foreign
 *   or never-prompted gate answers 404 — no cross-user leak);
 *   an already-decided gate answers 409 superseded with the
 *   deciding surface. Delivery goes through the single
 *   deliverJourneyDecision helper (the Slack surface's handler
 *   uses the same helper), so no surface invents its own event
 *   path.
 *
 * Auth follows the extracted-route pattern: absent login → 401,
 * never a synthetic identity (#1185). Pending-gate reads go
 * through the ORCHESTRATOR_AGENT shared-instance stub (same path S1's
 * audit forwarder writes through), so they share S1's live-proof
 * caveat: unit-pinned here, live proof owner-side.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import type { Env } from "../../types";
import {
  deliverJourneyDecision,
  findDecidedJourneyGate,
  listPendingJourneyGates,
  sagaAuditOwnerStub,
} from "../../workflows/sagaJourneyGate";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * Handle the saga journey routes. Returns null for non-matching
 * paths (the caller keeps routing). sessionLogin is the
 * requireAuth login from the caller; null → 401.
 */
export async function handleSagaJourneyRoutes(
  request: Request,
  url: URL,
  path: string,
  env: Env,
  sessionLogin: string | null,
): Promise<Response | null> {
  if (path === "/api/saga/journey-gates" && request.method === "GET") {
    if (!sessionLogin) return unauthenticatedResponse();
    let stub;
    try {
      stub = sagaAuditOwnerStub(env);
    } catch (err) {
      return json(
        { error: `Journey-gate listing unavailable: ${err instanceof Error ? err.message : String(err)}` },
        503,
      );
    }
    try {
      const gates = await listPendingJourneyGates(stub, sessionLogin);
      return json({ gates }, 200);
    } catch (err) {
      return json(
        { error: `Journey-gate listing failed: ${err instanceof Error ? err.message : String(err)}` },
        503,
      );
    }
  }

  if (path === "/api/saga/journey-decision" && request.method === "POST") {
    if (!sessionLogin) return unauthenticatedResponse();
    const body = (await request.json().catch(() => null)) as {
      sagaId?: unknown;
      decision?: unknown;
      surface?: unknown;
    } | null;
    if (!body || typeof body.sagaId !== "string" || !body.sagaId) {
      return json({ error: "sagaId is required." }, 400);
    }
    if (body.decision !== "approved" && body.decision !== "denied") {
      return json({ error: "decision must be approved or denied." }, 400);
    }
    const surface = body.surface ?? "panel";
    if (surface !== "panel" && surface !== "chat") {
      return json({ error: "surface must be panel or chat." }, 400);
    }
    let stub;
    try {
      stub = sagaAuditOwnerStub(env);
    } catch (err) {
      return json(
        { error: `Journey decision unavailable: ${err instanceof Error ? err.message : String(err)}` },
        503,
      );
    }
    try {
      const gates = await listPendingJourneyGates(stub, sessionLogin);
      const gate = gates.find((g) => g.sagaId === body.sagaId);
      if (!gate) {
        const decided = await findDecidedJourneyGate(stub, body.sagaId as string);
        if (decided) {
          return json(
            { accepted: false, superseded: true, decidedBy: decided.decidingSurface },
            409,
          );
        }
        return json({ error: "No pending journey gate for this saga." }, 404);
      }
      const result = await deliverJourneyDecision(
        env.SAGA_WORKFLOW as unknown as Parameters<typeof deliverJourneyDecision>[0],
        {
          sagaId: body.sagaId as string,
          decision: {
            sagaId: body.sagaId as string,
            decision: body.decision,
            deciderLogin: sessionLogin,
            surface,
          },
        },
      );
      if (!result.accepted) {
        return json(
          { accepted: false, superseded: true, decidedBy: result.decidedBy },
          409,
        );
      }
      return json({ accepted: true }, 200);
    } catch (err) {
      return json(
        { error: `Journey decision failed: ${err instanceof Error ? err.message : String(err)}` },
        503,
      );
    }
  }

  return null;
}
