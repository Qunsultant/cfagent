/**
 * Issue #1779 (Adapter S5, program #1717) — the one ActorGateway port.
 *
 * Before S5, route/service/DO code addressed Durable Object instances
 * inline (`namespace.idFromName` / `idFromString` + `get`, then
 * `stub.fetch` or a typed RPC method) at 35 scan sites, grown to 42
 * on current main as new routes landed. After S5 every such site goes
 * through this interface, and the Cloudflare implementation in
 * `cloudflareActorGateway.ts` is the ONLY module that calls
 * `idFromName` / `idFromString` / `get` for actor dispatch.
 *
 * This file carries types + the interface ONLY — no provider access.
 * The namespace shape reuses the existing `DoNamespaceLike` from
 * `src/data/durableKv.ts` (extended with the optional
 * `idFromString` that the payments webhook forwarder needs); no new
 * addressing scheme is introduced, and the agents-SDK seams stay
 * untouched (`routeAgentRequest` in `src/server.ts`, `ctx.exports`
 * SDK resolution).
 *
 * Typed stub access: `stub<T>` covers single-use route contracts
 * (the caller keeps its existing inline stub type as the type
 * argument — the addressing, not the contract, moves). The ONE
 * duplicated inline stub type in the tree — the PaymentsAgent
 * `budgetCheck` shape, written twice in `src/agents/scheduled-agent.ts`
 * — is collapsed into the shared `PaymentsAgentStub` below, and both
 * sites use `paymentsStub()`. The duplicated `getScreenerAgent()`
 * pair (orchestrator vs scheduledTasks) is collapsed the same way:
 * both call `stub()` with the single shared instance name from
 * `src/agents/screenerAgentName.ts` (`resolveScreenerAgentName`) —
 * the issue-authorized dedup for this slice, with equivalence
 * recorded in the PR body (identical names on every legitimate
 * input; the only delta is fail-closed: a missing login AND missing
 * service identity now throws instead of addressing a
 * `screener:undefined` instance).
 *
 * No config switch is needed for this slice: no behavior variant is
 * introduced, only the access path moves, and there is exactly one
 * adapter (Cloudflare). Scoped adapter selection therefore resolves
 * to the built-in default; no caller — and no route — can configure
 * away an enforcement through this port (dispatch is addressing,
 * not an IAAA gate, and every gate check still runs before the
 * dispatch exactly as before).
 */

import type { DoNamespaceLike, DoStubLike } from "../data/durableKv";
import type { UnifiedScheduleRecord } from "../data/unifiedSchedulePorts";

/**
 * A DO namespace as the gateway sees it: the existing
 * `DoNamespaceLike` shape plus the optional `idFromString` used to
 * address an instance by an already-resolved id (payments webhook
 * settlement routing). Namespaces without `idFromString` fail loud
 * on `addressFromId` / `dispatchFromId`, never silently.
 */
export interface ActorNamespaceLike extends DoNamespaceLike {
  idFromString?(id: string): unknown;
}

/** A DO stub as the gateway sees it: at minimum, `fetch`. */
export type ActorStubLike = DoStubLike;

/**
 * The internal PaymentsAgent RPC contract (issue #1779 D2): the
 * budget check both ScheduledAgent call sites make against the
 * `default` PaymentsAgent instance. This replaces the inline stub
 * type previously duplicated at both sites; it is NOT the external
 * `IPaymentGatewayStrategy` (Stripe/PayPal/LemonSqueezy) and must not
 * be conflated with it.
 */
export interface PaymentsAgentStub {
  budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
}

/** The ScreenerAgent PDF RPC used by `fetchScreenerPdf`. */
export interface ScreenerPdfStub {
  getPdfByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
}

/**
 * The TickerAgent RPC used by the Schedules home list read (issue
 * #3121 #4237): the one ticker-push record, or null when the feed
 * was never armed. Typed RPC through `actorGateway.stub`, the
 * `budgetCheck` / `getPdfByKey` precedent — no new addressing.
 */
export interface TickerPushRecordStub {
  getTickerPushRecord(): Promise<UnifiedScheduleRecord | null>;
  /** Issue #4352 — the feed is schedulable: pause, resume, set the cadence. */
  pauseTickerPush(): Promise<{ ok: true }>;
  resumeTickerPush(): Promise<{ ok: true }>;
  setTickerPushInterval(intervalSeconds: number): Promise<{ ok: true; intervalSeconds: number }>;
}

/**
 * The one actor-gateway port: address a DO instance, fetch through
 * it, or take a typed RPC stub for it. All methods delegate to the
 * SAME namespace object the caller passes in — existing namespace
 * mocks keep working unchanged, and no binding is ever invented:
 * a missing namespace (or a missing addressing method) throws a
 * named ActorGateway error, preserving every call site's existing
 * fail-loud contract.
 */
export interface ActorGateway {
  /** Resolve an instance id by name (`idFromName`). */
  address(namespace: ActorNamespaceLike, instanceName: string): unknown;
  /** Resolve an instance id from an already-resolved id (`idFromString`). */
  addressFromId(namespace: ActorNamespaceLike, id: string): unknown;
  /** Take a typed RPC stub for a named instance. */
  stub<T>(namespace: ActorNamespaceLike, instanceName: string): T;
  /** Take a typed RPC stub for an id-addressed instance. */
  stubFromId<T>(namespace: ActorNamespaceLike, id: string): T;
  /** Fetch a request through a named instance (`stub.fetch`). */
  dispatch(
    namespace: ActorNamespaceLike,
    instanceName: string,
    request: Request,
  ): Promise<Response>;
  /** Fetch a request through an id-addressed instance. */
  dispatchFromId(
    namespace: ActorNamespaceLike,
    id: string,
    request: Request,
  ): Promise<Response>;
  /** The `default` PaymentsAgent stub, for `budgetCheck` RPC. */
  paymentsStub(namespace: ActorNamespaceLike): PaymentsAgentStub;
}
