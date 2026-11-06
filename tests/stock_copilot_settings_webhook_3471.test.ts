/**
 * Issue #3471 — the Stock Copilot push leg: a broker/mode selection
 * change NOTIFIES the affected user's OrchestratorAgent through the
 * agent's built-in webhook channel (#3474, PortThink), instead of
 * the copilot learning about it at the next cycle firing or the
 * panel's next poll (the #3470 stale-display defect).
 *
 * Pins:
 * - The signing seam: the port's verifier accepts exactly what the
 *   delivery side signs (HMAC-SHA256 over the raw body, the
 *   `sha256=<hex>` header) — one scheme, both sides in the port's
 *   pure mapping module.
 * - Delivery: after a selection write commits, the Worker delivers
 *   a signed POST to the affected login's instance at the reserved
 *   `/webhooks/settings` path, in-Worker (the instance's DO stub
 *   fetch — the same dispatch every production request uses). The
 *   payload carries the FACT of change only (kind, login,
 *   changedAt) — never a value the hook should trust.
 * - Fail-open to the floor: no THINK_WEBHOOK_SECRET ⇒ the delivery
 *   is SKIPPED with a loud structured log (never sent unsigned);
 *   a failed/refused delivery never throws and never fails the
 *   user's settings write — #3473's observe floor bounds the
 *   staleness behind it.
 * - The hook: a settings event for the instance's OWN login
 *   re-resolves the selection through the #3451 resolver and
 *   compares it with the selection held in the instance's state.
 *   A change writes a "selection changed" entry (old → new,
 *   source: notified) into the copilot activity feed through the
 *   activity port and setStates the new selection (the base
 *   Agent broadcast #3472 consumes). No change ⇒ no record, no
 *   broadcast. A different login's event ⇒ ignored. The first
 *   notification establishes the held baseline silently.
 * - Both real write routes notify after the write commits: the
 *   environment switch (mode) and the tenant providers POST
 *   (broker). Rejected writes notify nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PortThink } from "../src/actors/thinkAdapter";
import type { ActorWebhookEvent } from "../src/actors/actorPorts";
import {
  THINK_WEBHOOK_SECRET_ENV,
  THINK_WEBHOOK_SIGNATURE_HEADER,
  signThinkWebhookSignature,
  verifyThinkWebhookSignature,
} from "../src/actors/thinkPortMapping";
import {
  SETTINGS_WEBHOOK_SOURCE,
  createSettingsChangeNotifier,
  deliverSettingsChangeWebhook,
  type SettingsChange,
} from "../src/agents/settingsWebhookNotify";
import {
  COPILOT_SELECTION_STATE_KEY,
  handleSettingsWebhook,
  readHeldCopilotSelection,
  type SettingsWebhookContext,
} from "../src/agents/orchestrator/settingsWebhook";
import {
  BROKER_ENVIRONMENT_SETTING_KEY,
  handleEnvironmentSwitch,
  type BrokerEnvironmentSwitchContext,
} from "../src/agents/routes/brokerEnvironment";
import {
  handleReportsRoutes,
  type ReportsRouteContext,
} from "../src/agents/routes/reports";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { createInMemoryStockCopilotActivityPort } from "../src/data/createStockCopilotStorePorts";
import type { StockCopilotActivityPort } from "../src/data/stockCopilotStorePorts";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";

const SECRET = "test-webhook-secret-3471";
const LOGIN = "alice";
const CHANGED_AT = "2026-11-06T09:15:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A DO-namespace fake: records every delivered request per instance name. */
function fakeNamespace(responder?: (req: Request) => Response | Promise<Response>) {
  const received: Array<{ name: string; request: Request }> = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (request: Request) => {
        received.push({ name: id.name, request });
        return responder ? responder(request) : new Response("OK");
      },
    }),
  };
  return { ns, received };
}

function settingsEvent(payload: unknown, source = SETTINGS_WEBHOOK_SOURCE): ActorWebhookEvent {
  const rawBody = JSON.stringify(payload);
  return {
    source,
    payload,
    rawBody,
    headers: new Headers({ "content-type": "application/json" }),
    url: new URL(`https://agent.openaimp.com/agents/orchestrator-agent/${LOGIN}/webhooks/${source}`),
  };
}

/** The hook's host state: an Agent-state cell recording every broadcast. */
function stateCell(initial?: unknown) {
  const cell = {
    value: initial as unknown,
    broadcasts: [] as unknown[],
    getState: () => cell.value,
    setState: (next: unknown) => {
      cell.value = next;
      cell.broadcasts.push(next);
    },
  };
  return cell;
}

interface HookRig {
  ctx: SettingsWebhookContext;
  activity: StockCopilotActivityPort;
  commercial: InMemoryCommercialAdapter;
  settings: Map<string, string>;
  cell: ReturnType<typeof stateCell>;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
  tenantId: string;
}

async function hookRig(opts?: {
  storedEnvironment?: string;
  brokerId?: string;
  heldState?: unknown;
  ownLogin?: string | undefined;
  commercial?: InMemoryCommercialAdapter | null;
}): Promise<HookRig> {
  const settings = new Map<string, string>();
  if (opts?.storedEnvironment) settings.set(BROKER_ENVIRONMENT_SETTING_KEY, opts.storedEnvironment);
  const commercial = opts && "commercial" in opts ? opts.commercial : new InMemoryCommercialAdapter();
  const tenantId = resolveIaaaTenant({});
  if (commercial && opts?.brokerId) {
    await commercial.setTenantProviders(tenantId, { dataProviderId: "etrade", brokerId: opts.brokerId });
  }
  const activity = createInMemoryStockCopilotActivityPort();
  const cell = stateCell(opts?.heldState);
  const audits: HookRig["audits"] = [];
  const ownLogin = opts && "ownLogin" in opts ? opts.ownLogin : LOGIN;
  const ctx: SettingsWebhookContext = {
    env: {},
    activity,
    readSettingRaw: (key) => settings.get(key) ?? null,
    getScreenerExecutionContext: async () =>
      ownLogin ? { userLogin: ownLogin } : undefined,
    commercial,
    getState: cell.getState,
    setState: cell.setState,
    audit: (type, _agent, payload) => {
      audits.push({ type, payload });
    },
    now: () => new Date(CHANGED_AT),
  };
  return { ctx, activity, commercial: commercial as InMemoryCommercialAdapter, settings, cell, audits, tenantId };
}

function heldSelection(brokerId: string, environment: string, mode: string) {
  return {
    [COPILOT_SELECTION_STATE_KEY]: {
      brokerId,
      environment,
      mode,
      source: "notified",
      updatedAt: "2026-11-06T08:00:00.000Z",
    },
  };
}

// ---------------------------------------------------------------------------
// Signing seam
// ---------------------------------------------------------------------------

describe("webhook signing seam (#3471, beside the #3474 verifier)", () => {
  it("signs exactly what the port verifies: sha256 HMAC over the raw body", async () => {
    const body = JSON.stringify({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT });
    const header = await signThinkWebhookSignature(body, SECRET);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    await expect(verifyThinkWebhookSignature(body, header, SECRET)).resolves.toBe(true);
    await expect(verifyThinkWebhookSignature(body + " ", header, SECRET)).resolves.toBe(false);
    await expect(verifyThinkWebhookSignature(body, header, "other-secret")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("settings-change webhook delivery (#3471)", () => {
  const change: SettingsChange = { kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT };

  it("delivers a signed POST to the login's own instance at /webhooks/settings, fact-of-change payload only", async () => {
    const { ns, received } = fakeNamespace();
    const env = { [THINK_WEBHOOK_SECRET_ENV]: SECRET, SEARCH_AGENT: ns };
    const out = await deliverSettingsChangeWebhook(env as never, change);
    expect(out).toEqual({ delivered: true });
    expect(received).toHaveLength(1);
    expect(received[0].name).toBe(LOGIN);
    const req = received[0].request;
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe(`/agents/orchestrator-agent/${LOGIN}/webhooks/settings`);
    const raw = await req.text();
    // The payload is the FACT of change — no broker/mode values for a hook to trust.
    expect(JSON.parse(raw)).toEqual({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT });
    const signature = req.headers.get(THINK_WEBHOOK_SIGNATURE_HEADER);
    await expect(verifyThinkWebhookSignature(raw, signature, SECRET)).resolves.toBe(true);
  });

  it("skips with a loud log when THINK_WEBHOOK_SECRET is unset — never sends unsigned, never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ns, received } = fakeNamespace();
    const out = await deliverSettingsChangeWebhook({ SEARCH_AGENT: ns } as never, change);
    expect(out.delivered).toBe(false);
    expect(out.reason).toContain("secret");
    expect(received).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("THINK_WEBHOOK_SECRET");
  });

  it("reports a refused delivery (the instance's 503) without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ns } = fakeNamespace(() => new Response("Webhook secret not configured", { status: 503 }));
    const env = { [THINK_WEBHOOK_SECRET_ENV]: SECRET, SEARCH_AGENT: ns };
    const out = await deliverSettingsChangeWebhook(env as never, change);
    expect(out.delivered).toBe(false);
    expect(out.reason).toContain("503");
  });

  it("skips when the agent namespace is unbound, without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await deliverSettingsChangeWebhook({ [THINK_WEBHOOK_SECRET_ENV]: SECRET } as never, change);
    expect(out.delivered).toBe(false);
  });

  it("the notifier defers through waitUntil when the host provides it, and never throws", async () => {
    const { ns, received } = fakeNamespace();
    const deferred: Array<Promise<unknown>> = [];
    const notify = createSettingsChangeNotifier(
      { [THINK_WEBHOOK_SECRET_ENV]: SECRET, SEARCH_AGENT: ns } as never,
      (p) => {
        deferred.push(p);
      },
    );
    expect(() => notify(change)).not.toThrow();
    expect(deferred).toHaveLength(1);
    await deferred[0];
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The orchestrator's hook
// ---------------------------------------------------------------------------

describe("orchestrator settings webhook hook (#3471)", () => {
  it("first notification establishes the held baseline silently: state set, no activity record", async () => {
    const rig = await hookRig({ storedEnvironment: "TEST", brokerId: "alpaca" });
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT }));
    expect(readHeldCopilotSelection(rig.cell.value)).toEqual({
      brokerId: "alpaca",
      environment: "TEST",
      mode: "paper",
      source: "notified",
      updatedAt: CHANGED_AT,
    });
    expect(rig.cell.broadcasts).toHaveLength(1);
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(rig.audits).toHaveLength(0);
  });

  it("a mode change against the baseline records old → new (source: notified), updates state, and audits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await hookRig({
      storedEnvironment: "PROD",
      brokerId: "alpaca",
      heldState: heldSelection("alpaca", "TEST", "paper"),
    });
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT }));
    const records = rig.activity.listActivity(LOGIN, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      userLogin: LOGIN,
      outcome: "selection_changed",
      entries: [],
      exits: [],
      detail: "alpaca · paper → alpaca · live (source: notified)",
    });
    expect(readHeldCopilotSelection(rig.cell.value)).toMatchObject({
      brokerId: "alpaca",
      environment: "PROD",
      mode: "live",
    });
    expect(rig.cell.broadcasts).toHaveLength(1);
    expect(rig.audits).toEqual([
      {
        type: "stock_copilot.selection_changed",
        payload: expect.objectContaining({ userLogin: LOGIN, kind: "mode_changed" }),
      },
    ]);
  });

  it("a broker change against the baseline records the old → new broker", async () => {
    const rig = await hookRig({
      storedEnvironment: "TEST",
      brokerId: "etrade",
      heldState: heldSelection("alpaca", "TEST", "paper"),
    });
    await handleSettingsWebhook(
      rig.ctx,
      settingsEvent({ kind: "broker_selection_changed", login: LOGIN, changedAt: CHANGED_AT }),
    );
    const records = rig.activity.listActivity(LOGIN, 10);
    expect(records).toHaveLength(1);
    expect(records[0].detail).toBe("alpaca · paper → etrade · paper (source: notified)");
    expect(readHeldCopilotSelection(rig.cell.value)).toMatchObject({ brokerId: "etrade", mode: "paper" });
  });

  it("a notification that changes nothing is silent: no record, no broadcast, no audit", async () => {
    const rig = await hookRig({
      storedEnvironment: "TEST",
      brokerId: "alpaca",
      heldState: heldSelection("alpaca", "TEST", "paper"),
    });
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT }));
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(rig.cell.broadcasts).toHaveLength(0);
    expect(rig.audits).toHaveLength(0);
  });

  it("an event naming a different login is ignored — the hook acts only for its own instance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await hookRig({ storedEnvironment: "PROD", brokerId: "alpaca" });
    await handleSettingsWebhook(
      rig.ctx,
      settingsEvent({ kind: "mode_changed", login: "bob", changedAt: CHANGED_AT }),
    );
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(rig.cell.broadcasts).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("a context-less instance cannot verify ownership and ignores the event", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await hookRig({ storedEnvironment: "PROD", brokerId: "alpaca", ownLogin: undefined });
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT }));
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(rig.cell.broadcasts).toHaveLength(0);
  });

  it("an unresolved selection (broker store unbound) records and broadcasts nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await hookRig({ storedEnvironment: "PROD", commercial: null });
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT }));
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(rig.cell.broadcasts).toHaveLength(0);
  });

  it("non-settings sources and malformed payloads are ignored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await hookRig({ storedEnvironment: "PROD", brokerId: "alpaca" });
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "mode_changed", login: LOGIN, changedAt: CHANGED_AT }, "github"));
    await handleSettingsWebhook(rig.ctx, settingsEvent({ kind: "something_else", login: LOGIN, changedAt: CHANGED_AT }));
    await handleSettingsWebhook(rig.ctx, settingsEvent({ login: LOGIN }));
    await handleSettingsWebhook(rig.ctx, settingsEvent("not-a-record"));
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(rig.cell.broadcasts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The write routes notify (after the write commits)
// ---------------------------------------------------------------------------

function switchCtx(overrides: Partial<BrokerEnvironmentSwitchContext> = {}) {
  const store = new Map<string, string>();
  const notifications: SettingsChange[] = [];
  const ctx: BrokerEnvironmentSwitchContext = {
    readSettingRaw: (key) => store.get(key) ?? null,
    writeSetting: (key, value) => {
      store.set(key, value);
    },
    env: {},
    notifySettingsChanged: (change) => {
      notifications.push(change);
    },
    ...overrides,
  };
  return { store, ctx, notifications };
}

function apiPost(path: string, body: unknown, login?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (login) headers.set("x-user-login", login);
  return new Request(`https://agent.openaimp.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("environment switch notifies the mode change (#3471)", () => {
  it("a persisted switch notifies mode_changed for the session login", async () => {
    const { ctx, notifications } = switchCtx();
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "PROD" }, LOGIN), ctx);
    expect(res.status).toBe(200);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "mode_changed", login: LOGIN });
    expect(typeof notifications[0].changedAt).toBe("string");
  });

  it("a rejected switch (invalid value) notifies nothing", async () => {
    const { ctx, notifications } = switchCtx();
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "BOGUS" }, LOGIN), ctx);
    expect(res.status).toBe(400);
    expect(notifications).toHaveLength(0);
  });

  it("a switch that cannot persist (no writer) fails closed and notifies nothing", async () => {
    const { ctx, notifications } = switchCtx({ writeSetting: undefined });
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "TEST" }, LOGIN), ctx);
    expect(res.status).toBe(500);
    expect(notifications).toHaveLength(0);
  });

  it("a switch without a session login still persists, but no instance is notified", async () => {
    const { store, ctx, notifications } = switchCtx();
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "TEST" }), ctx);
    expect(res.status).toBe(200);
    expect(store.get(BROKER_ENVIRONMENT_SETTING_KEY)).toBe("TEST");
    expect(notifications).toHaveLength(0);
  });
});

/** Minimal D1Database stand-in over node:sqlite (the data-foundation test pattern). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

function reportsCtx(env: unknown, notifications: SettingsChange[]): ReportsRouteContext {
  return {
    ensureTables: () => ({ exec: () => [] }) as never,
    env: env as ReportsRouteContext["env"],
    getScreenerAgent: () => ({ getHistory: async () => [] }) as never,
    getScreenerExecutionContext: async () => undefined,
    getReportDispatchHitl: () => false,
    setReportDispatchHitl: vi.fn(),
    getReportConfirmation: vi.fn(() => null),
    decideReportConfirmation: vi.fn(),
    createReportConfirmation: vi.fn(() => "conf-1"),
    confirmationDeliveryMeta: vi.fn(() => ({})),
    deliverStoredReportEmail: vi.fn(async () => "sent" as const),
    deliverStoredReportWebhook: vi.fn(async () => ({ outcome: "sent" as const, result: { success: true, status: 200 } })),
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true, status: 200 })),
    storeResearchReportCanonicalAsync: vi.fn(async () => ({ reportId: "r1", generationId: "g1" })),
    audit: vi.fn(),
    reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
    notifySettingsChanged: (change) => {
      notifications.push(change);
    },
  } as ReportsRouteContext;
}

describe("tenant providers POST notifies the broker change (#3471)", () => {
  it("a committed provider write notifies broker_selection_changed for the session login", async () => {
    const notifications: SettingsChange[] = [];
    const ctx = reportsCtx({ AGENT_DB: new MockD1Database(), IAAA_TENANT_ID: "tenant-1" }, notifications);
    const req = apiPost("/api/tenant/settings/providers", { dataProviderId: "yahoo", brokerId: "alpaca" }, LOGIN);
    const res = await handleReportsRoutes(req, new URL(req.url), "/tenant/settings/providers", "sess", ctx);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { brokerId?: string };
    expect(body.brokerId).toBe("alpaca");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "broker_selection_changed", login: LOGIN });
  });

  it("an invalid provider body is rejected and notifies nothing", async () => {
    const notifications: SettingsChange[] = [];
    const ctx = reportsCtx({ AGENT_DB: new MockD1Database(), IAAA_TENANT_ID: "tenant-1" }, notifications);
    const req = apiPost("/api/tenant/settings/providers", { dataProviderId: "schwab", brokerId: "alpaca" }, LOGIN);
    const res = await handleReportsRoutes(req, new URL(req.url), "/tenant/settings/providers", "sess", ctx);
    expect(res?.status).toBe(400);
    expect(notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End to end: route → signed in-Worker delivery → PortThink channel → hook
// ---------------------------------------------------------------------------

describe("end to end through the real PortThink channel (#3471 on #3474)", () => {
  it("a mode switch lands as a selection-changed activity entry on the user's instance", async () => {
    const rig = await hookRig({ storedEnvironment: "TEST", brokerId: "alpaca" });

    /** The receiver: a PortThink agent whose hook is the orchestrator's settings handler. */
    class ReceiverAgent extends PortThink {
      constructor(ctx: unknown, env: unknown) {
        super(ctx as never, env as never);
        this.portHooks = {
          getModel: () => null,
          getSystemPrompt: () => "",
          getTools: () => ({}),
          beforeTurn: async () => undefined,
          onChatResponse: async () => {},
          onWebhook: async (event) => {
            await handleSettingsWebhook(
              {
                ...rig.ctx,
                getState: () => (this as unknown as { state: unknown }).state,
                setState: (next) => {
                  (this as unknown as { setState(n: unknown): void }).setState(next);
                },
              },
              event,
            );
          },
        };
      }
    }
    const receiver = new ReceiverAgent(
      { storage: { get: async () => null } },
      { [THINK_WEBHOOK_SECRET_ENV]: SECRET },
    );
    const { ns } = fakeNamespace((req) => receiver.fetch(req));
    const env = { [THINK_WEBHOOK_SECRET_ENV]: SECRET, SEARCH_AGENT: ns };
    const deferred: Array<Promise<unknown>> = [];
    const notify = createSettingsChangeNotifier(env as never, (p) => {
      deferred.push(p);
    });

    const { ctx } = switchCtx({ notifySettingsChanged: notify });
    // First switch (TEST, the already-stored value): the delivery
    // establishes the instance's held baseline.
    const first = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "TEST" }, LOGIN), ctx);
    expect(first.status).toBe(200);
    await deferred[0];
    expect(rig.activity.listActivity(LOGIN, 10)).toHaveLength(0);
    expect(readHeldCopilotSelection((receiver as unknown as { state: unknown }).state)).toMatchObject({
      brokerId: "alpaca",
      mode: "paper",
    });

    // The user flips to PROD in the panel menu; the stored setting
    // the resolver reads is the new one by the time the hook runs.
    rig.settings.set(BROKER_ENVIRONMENT_SETTING_KEY, "PROD");
    const second = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "PROD" }, LOGIN), ctx);
    expect(second.status).toBe(200);
    await deferred[1];
    const records = rig.activity.listActivity(LOGIN, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "selection_changed",
      detail: "alpaca · paper → alpaca · live (source: notified)",
    });
    const broadcasts = (receiver as unknown as { stateBroadcasts: unknown[] }).stateBroadcasts;
    expect(broadcasts.length).toBeGreaterThanOrEqual(2);
  });

  it("with the secret unset the switch still succeeds and nothing is delivered (the #3473 floor owns convergence)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ns, received } = fakeNamespace();
    const notify = createSettingsChangeNotifier({ SEARCH_AGENT: ns } as never);
    const { store, ctx } = switchCtx({ notifySettingsChanged: notify });
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "PROD" }, LOGIN), ctx);
    expect(res.status).toBe(200);
    expect(store.get(BROKER_ENVIRONMENT_SETTING_KEY)).toBe("PROD");
    // Delivery is fire-and-forget; give the skipped attempt its tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});
