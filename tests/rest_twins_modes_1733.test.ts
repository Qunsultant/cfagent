/**
 * #1733 (parent #1717, slice (m)): REST↔REST twins unification —
 * scan appendix (m) findings R01, R02, R04, R06, plus the R03/R05/M10
 * pins and the screen-vs-unified follow-up diff.
 *
 * RED pins (written BEFORE the implementation; the first run must
 * fail on the missing src/config/restTwinsModes.ts module).
 *
 * What this slice DOES (one genuine switch, the rest pinned):
 * - R04 audit writes: ONE new switch AUDIT_WRITE_MODE
 *   ("legacy" | "strict"), resolved run > session > user > global
 *   env > built-in (legacy), in the new pure port
 *   src/config/restTwinsModes.ts (same idiom as #1727 fossModes).
 *   legacy = each spelling keeps its own contract exactly:
 *   POST /audit stays unvalidated (defaults
 *   type=autopilot.policy_check, agent=trading, 200 {success,
 *   message}); POST /audit/event stays strict (201 record).
 *   strict = POST /audit ALSO applies the /audit/event validation
 *   (non-empty type ≤120 chars, agent trimmed to ≤64, payload
 *   ≤64 KB serialized) while keeping its own defaults and its 200
 *   shape. strict NEVER loosens /audit/event, and there is no
 *   "lenient" value: the switch can only tighten, never
 *   un-validate a previously validated path (Security Guard).
 *   An unrecognized winning value FAILS CLOSED to legacy,
 *   console-logged + audited as audit.config_error (no fall-through).
 * - R06 transaction-snap identity: the Worker fallback chain moves
 *   into the pure port helper resolveSnapIdentity (header OR
 *   tx.symbol OR the literal "browser_trader") with NO behavior
 *   change. The literal SURVIVES, and only as a defensive default:
 *   the Worker path requires a valid app session first
 *   (requireAuth → 401) and rejects a missing tx.symbol with 400
 *   BEFORE the chain runs, so on the reachable path the identity is
 *   always the header or tx.symbol — the literal is unreachable in
 *   practice. The DO route has no fallback (one shared block).
 * - R01 Alpaca twins: ALREADY unified by #1727's three-way
 *   FOSS_ALPACA_* switches; #1733 EXERCISES the reserved freedom by
 *   explicitly LEAVING the /trading defaults alone (order=trading,
 *   reads=none), with justification: no owner decision exists to
 *   change a production order/audit contract, and changing the
 *   /trading order default to foss would silently change order
 *   normalization (uppercasing, aliases) and the audit payload for
 *   existing /trading callers, while changing reads none→rest
 *   would start emitting audits for previously silent reads. The
 *   owner can overturn either default with one env var
 *   (FOSS_ALPACA_ORDER_MODE / FOSS_ALPACA_READS_MODE) — pinned here.
 *   /foss/snapshot keeps no /trading twin (asymmetry pinned, not a
 *   divergence: adding a /trading/snapshot endpoint is new surface,
 *   out of this slice's scope).
 * - R02 quote twins (REST↔REST leg): PINNED divergent-by-design.
 *   Provider/cache semantics belong to (e) #1725 (QUOTE_* modes)
 *   and (g) #1726/#1727 (ETRADE_* and FOSS_* quote modes); the (m) leg
 *   — /etrade/quote's x-user-login gate, TEST/PROD env selection,
 *   and no-cache headers vs /foss/quote's none — is inherent to
 *   the broker's per-user OAuth and live-quote freshness, not an
 *   accident: gating /foss would break public consumers, ungating
 *   /etrade would be an enforcement regression (no switch may
 *   disable its own enforcement). The batch pair
 *   /api/market/quotes = /api/foss/quotes (and the /ws spellings)
 *   are literally one branch each — IDENTICAL, pinned by citation
 *   in the PR body (server.ts is not unit-testable in isolation).
 * - R03 options-strategy aliases (strategies = best-trade, one if
 *   block) and R05 environment-switch aliases (one
 *   handleEnvironmentSwitch) are IDENTICAL — pinned by the existing
 *   extraction tests, not re-pinned here.
 * - M10 audit/schema reads: UNIFIED (#1644), pinned by the existing
 *   extraction tests (GET /audit 1–100 clamp + session filter +
 *   5-field projection; schema tables/query pass-through with the
 *   mas_categories default) — pin, don't rebuild.
 * - Follow-up diff (screen vs unified vs recommend/catalog/
 *   compare): /screen runs the filter-shaped DynamicOptionsScreener
 *   path (executeOptionsScreen, delivery + job outcome);
 *   /unified runs action-dispatched UnifiedOptionsService.execute
 *   (executeUnifiedOptions); /recommend is the single-owner
 *   handleOptionsStrategyRecommend; /compare runs the panel
 *   pipeline (runPanelPipelineRetired4068 + rankOptionsCompareCandidates);
 *   /catalog lists the strategy registry. Different request/
 *   response contracts by design — pinned, no switch (a switch
 *   selecting between them would be a phantom: they are different
 *   endpoints, not two spellings of one). The scan's "all through
 *   UnifiedOptionsService" is corrected: only /unified goes
 *   through UnifiedOptionsService.execute; /screen does not.
 *
 * No endpoint is removed, no code path is deleted. Production
 * switch values are an OWNER action — this slice sets none;
 * unset = legacy behavior everywhere.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveAuditWriteMode,
  levelsForAuditWriteMode,
  validateStrictAuditWrite,
  resolveSnapIdentity,
  auditConfigErrorEvent,
  AUDIT_WRITE_MODE_SWITCH,
  type AuditWriteMode,
  type RestTwinsScopedModes,
} from "../src/config/restTwinsModes";
import {
  handleAuditRoutes,
  type AuditRouteContext,
} from "../src/agents/routes/audit";
import { resolveMarketDataRestSwitch } from "../src/config/marketDataModes";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const auditCalls: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];
const baseCtx = (overrides: Partial<AuditRouteContext> = {}): AuditRouteContext => {
  auditCalls.length = 0;
  return {
    ensureTables: () => ({}) as any,
    audit: vi.fn((type: string, agent: any, payload: Record<string, unknown>) => {
      auditCalls.push({ type, agent, payload });
    }),
    recordAudit: vi.fn((type: string, agent: string, payload: Record<string, unknown>) => ({
      id: "rec-1",
      type,
      agent,
      payload,
      created_at: new Date().toISOString(),
    })),
    ...overrides,
  } as AuditRouteContext;
};

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const postAudit = (ctx: AuditRouteContext, body: unknown, path = "/api/audit") =>
  handleAuditRoutes(req("POST", path, body), new URL(`https://x${path}`), path, "s1", ctx);

describe("AUDIT_WRITE_MODE resolver (#1733 R04)", () => {
  it("defaults to legacy with no levels set", () => {
    const r = resolveAuditWriteMode(levelsForAuditWriteMode(undefined, undefined, undefined), "legacy");
    expect(r.mode).toBe("legacy");
    expect(r.invalid).toBe(false);
    expect(r.level).toBe("builtin");
  });

  it("resolves run > session > user > env, blank falls through", () => {
    const scoped: RestTwinsScopedModes = { session: { auditWrite: "strict" }, user: { auditWrite: "legacy" } };
    expect(resolveAuditWriteMode(levelsForAuditWriteMode(scoped, undefined, "legacy"), "legacy").mode).toBe("strict");
    expect(resolveAuditWriteMode(levelsForAuditWriteMode(scoped, "strict", undefined), "legacy").mode).toBe("strict");
    expect(resolveAuditWriteMode(levelsForAuditWriteMode({ user: { auditWrite: "strict" } }, "  ", "legacy"), "legacy").mode).toBe("strict");
    expect(resolveAuditWriteMode(levelsForAuditWriteMode(undefined, undefined, "strict"), "legacy").mode).toBe("strict");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolveAuditWriteMode(levelsForAuditWriteMode(undefined, " STRICT ", undefined), "legacy").mode).toBe("strict");
  });

  it("fails closed to legacy on an unrecognized winning value, with no fall-through", () => {
    const r = resolveAuditWriteMode(levelsForAuditWriteMode(undefined, "bogus", "strict"), "legacy");
    expect(r.mode).toBe("legacy");
    expect(r.invalid).toBe(true);
    expect(r.raw).toBe("bogus");
    expect(r.level).toBe("run");
    const nonString = resolveAuditWriteMode(levelsForAuditWriteMode(undefined, 42 as any, undefined), "legacy");
    expect(nonString.invalid).toBe(true);
    expect(nonString.mode).toBe("legacy");
  });

  it("names its switch and config-error event", () => {
    expect(AUDIT_WRITE_MODE_SWITCH).toBe("AUDIT_WRITE_MODE");
    expect(auditConfigErrorEvent()).toBe("audit.config_error");
  });
});

describe("strict audit-write validation (#1733 R04, shared by both spellings)", () => {
  it("accepts a valid body, trimming type and slicing agent to 64", () => {
    const ok = validateStrictAuditWrite({ type: "  my.event  ", agent: `x`.repeat(100), payload: { a: 1 } }, "trading");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.type).toBe("my.event");
      expect(ok.value.agent).toBe(`x`.repeat(64));
      expect(ok.value.payload).toEqual({ a: 1 });
    }
  });

  it("applies the caller's default agent when none is given", () => {
    const a = validateStrictAuditWrite({ type: "t" }, "trading");
    const b = validateStrictAuditWrite({ type: "t" }, "orchestrator");
    expect(a.ok && a.value.agent).toBe("trading");
    expect(b.ok && b.value.agent).toBe("orchestrator");
  });

  it("rejects a missing, empty, or over-long type", () => {
    expect(validateStrictAuditWrite({}, "trading").ok).toBe(false);
    expect(validateStrictAuditWrite({ type: "   " }, "trading").ok).toBe(false);
    expect(validateStrictAuditWrite({ type: "x".repeat(121) }, "trading").ok).toBe(false);
    expect(validateStrictAuditWrite({ type: "x".repeat(120) }, "trading").ok).toBe(true);
  });

  it("rejects a payload serializing over 64 KB and coerces a non-object payload to {}", () => {
    expect(validateStrictAuditWrite({ type: "t", payload: { big: "x".repeat(70000) } }, "trading").ok).toBe(false);
    const coerced = validateStrictAuditWrite({ type: "t", payload: "nope" }, "trading");
    expect(coerced.ok && coerced.value.payload).toEqual({});
  });
});

describe("POST /audit under the switch (#1733 R04)", () => {
  it("legacy (default): unvalidated, own defaults, 200 {success, message}", async () => {
    const ctx = baseCtx();
    const res = await postAudit(ctx, {});
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ success: true, message: "Audit event recorded" });
    expect(auditCalls[0]).toMatchObject({ type: "autopilot.policy_check", agent: "trading", payload: {} });
  });

  it("legacy (default): an over-long type is NOT rejected — the unvalidated path is named, not hidden", async () => {
    const ctx = baseCtx();
    const res = await postAudit(ctx, { type: "x".repeat(200) });
    expect(res!.status).toBe(200);
  });

  it("strict via body mode: bad type / over-long type / over-large payload are 400", async () => {
    const ctx = baseCtx();
    expect((await postAudit(ctx, { mode: "strict", type: "" }))!.status).toBe(400);
    expect((await postAudit(ctx, { mode: "strict", type: "x".repeat(121) }))!.status).toBe(400);
    expect((await postAudit(ctx, { mode: "strict", type: "t", payload: { big: "x".repeat(70000) } }))!.status).toBe(400);
  });

  it("strict via body mode: a valid write keeps /audit defaults and the 200 shape", async () => {
    const ctx = baseCtx();
    const res = await postAudit(ctx, { mode: "strict", payload: { a: 1 } });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ success: true, message: "Audit event recorded" });
    expect(auditCalls[0]).toMatchObject({ type: "autopilot.policy_check", agent: "trading", payload: { a: 1 } });
  });

  it("strict via global env: the route reads AUDIT_WRITE_MODE from ctx.env", async () => {
    const ctx = baseCtx({ env: { AUDIT_WRITE_MODE: "strict" } } as any);
    expect((await postAudit(ctx, { type: "" }))!.status).toBe(400);
    expect((await postAudit(ctx, { type: "ok" }))!.status).toBe(200);
  });

  it("strict via session carrier: session beats env", async () => {
    const ctx = baseCtx({
      env: { AUDIT_WRITE_MODE: "legacy" },
      scopedAuditModes: { session: { auditWrite: "strict" } },
    } as any);
    expect((await postAudit(ctx, { type: "" }))!.status).toBe(400);
  });

  it("invalid mode fails closed to legacy AND audits audit.config_error", async () => {
    const ctx = baseCtx();
    const res = await postAudit(ctx, { mode: "bogus", type: "x".repeat(200) });
    expect(res!.status).toBe(200);
    expect(auditCalls.some((c) => c.type === "audit.config_error")).toBe(true);
  });
});

describe("POST /audit/event under the switch (#1733 R04: never loosened)", () => {
  it("legacy default: still strict (missing type 400, valid write 201 record)", async () => {
    const ctx = baseCtx();
    expect((await postAudit(ctx, {}, "/api/audit/event"))!.status).toBe(400);
    const res = await postAudit(ctx, { type: "my.event", agent: "orchestrator", payload: { a: 1 } }, "/api/audit/event");
    expect(res!.status).toBe(201);
    expect(await res!.json()).toMatchObject({ type: "my.event", agent: "orchestrator" });
  });

  it("strict mode: identical strict behavior (the switch only tightens /audit)", async () => {
    const ctx = baseCtx();
    expect((await postAudit(ctx, { mode: "strict" }, "/api/audit/event"))!.status).toBe(400);
    const res = await postAudit(ctx, { mode: "strict", type: "t" }, "/api/audit/event");
    expect(res!.status).toBe(201);
  });

  it("invalid mode on /audit/event: config_error audited, strict behavior unchanged", async () => {
    const ctx = baseCtx();
    expect((await postAudit(ctx, { mode: "bogus" }, "/api/audit/event"))!.status).toBe(400);
    expect(auditCalls.some((c) => c.type === "audit.config_error")).toBe(true);
  });
});

describe("transaction-snap identity fallback (#1733 R06)", () => {
  it("header wins, then tx.symbol, then the defensive literal", () => {
    expect(resolveSnapIdentity("alice", "NVDA")).toBe("alice");
    expect(resolveSnapIdentity("", "NVDA")).toBe("NVDA");
    expect(resolveSnapIdentity(undefined, undefined)).toBe("browser_trader");
    expect(resolveSnapIdentity("", "")).toBe("browser_trader");
  });

  it("the Worker route delegates to the port helper and carries no inline fallback chain", () => {
    // Slice 7 of Qunsultant/cfagent#2902 (2026-11-05): the
    // transaction-snap route moved from src/server.ts to
    // src/server/routes/platform.ts; the entry surface is server.ts +
    // routes/*.ts, so the pin reads both files (assertions unchanged).
    const serverSrc = src("server.ts") + src("server/routes/platform.ts");
    expect(serverSrc).toContain("resolveSnapIdentity(request.headers.get(");
    // The old inline chain is gone (the literal still appears in the
    // explanatory comment above the call — that is documentation,
    // not a second fallback).
    expect(serverSrc).not.toContain('|| "browser_trader"');
    const portSrc = src("config/restTwinsModes.ts");
    expect(portSrc).toContain('"browser_trader"');
  });
});

describe("R01 /trading defaults deliberately left alone (#1733, freedom from #1727)", () => {
  const host = (env: Record<string, unknown> = {}) => ({
    scopedMarketDataModes: undefined,
    env,
    audit: vi.fn(),
  });
  it("/trading keeps order=trading and reads=none with nothing configured", () => {
    expect(resolveMarketDataRestSwitch(host(), "order", undefined, "trading")).toBe("trading");
    expect(resolveMarketDataRestSwitch(host(), "reads", undefined, "none")).toBe("none");
  });
  it("/foss keeps its own legacies, and the owner can overturn /trading with one env var", () => {
    // #1906 migration note: the resolver + module were renamed (fossModes ->
    // marketDataModes), and the deprecated FOSS_* env vars are still honored
    // when the canonical var is unset. The resolver aliases the "foss" VALUE
    // at the env level only (to "market-data"); the legacy surface default
    // passes through unnormalized, so the "foss" default below still reads
    // "foss" while the env-provided "foss" reads "market-data".
    expect(resolveMarketDataRestSwitch(host(), "order", undefined, "foss")).toBe("foss");
    expect(resolveMarketDataRestSwitch(host(), "reads", undefined, "rest")).toBe("rest");
    expect(resolveMarketDataRestSwitch(host({ FOSS_ALPACA_ORDER_MODE: "foss" }), "order", undefined, "trading")).toBe("market-data");
    expect(resolveMarketDataRestSwitch(host({ FOSS_ALPACA_READS_MODE: "rest" }), "reads", undefined, "none")).toBe("rest");
  });
  it("the orchestrator passes env into the audit routes (global-env level exists)", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const call = dispatchSrc.slice(dispatchSrc.indexOf("handleAuditRoutes(request, url, path, sessionId,"));
    expect(call.slice(0, call.indexOf("});"))).toContain("env:");
  });
});
