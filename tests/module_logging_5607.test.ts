/**
 * Issue #5607 (G-5/G-6) — module logging + coded messages across
 * the platform families (accounts, tenants, channels, assurance).
 *
 * Pins:
 * - No bare `console.*` in the four converted files.
 * - Every new catalog code resolves with the correct httpStatus
 *   (and the reused codes resolve too); the catalog holds 261
 *   outcomes.
 * - Module loggers emit with the file's component name at the
 *   expected level. Observable surface: the unbound sink
 *   (`createObservabilitySink({})`) writes JSON lines to
 *   console.info for every level, so tests spy on console.info
 *   and parse the JSON lines, exactly as
 *   tests/scanner_persist_audit_reroute.test.ts does.
 * - Coded bodies on a representative subset (401/403/404/405/503
 *   per family + one G9 409) with statuses unchanged.
 * - The G9 nested 200-payload fields stay untouched
 *   (`checkout.error`, `reason`).
 *
 * Statuses are asserted throughout; the message text is the
 * catalog rendering, never a hand-written literal.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handlePlatformTenantRoutes } from "../src/agents/routes/platformTenants";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { handlePlatformAccountRoutes } from "../src/agents/routes/platformAccounts";
import type {
  PlatformAccountPorts,
  PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import { handlePaymentAssuranceLiveRoutes } from "../src/agents/routes/paymentAssuranceLive";
import type {
  CardSessionEvidence,
  CheckoutPort,
  CheckoutPorts,
} from "../src/services/checkoutPorts";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { codedMessage, getOutcome } from "../src/outcomes/outcomeAspects";
import outcomeCatalog from "../src/outcomes/outcomeCatalog.json";

const CONVERTED = [
  "src/agents/routes/platformTenants.ts",
  "src/agents/routes/platformAccounts.ts",
  "src/agents/routes/platformChannels.ts",
  "src/agents/routes/paymentAssuranceLive.ts",
];

interface StructuredEvent {
  operation: string;
  level: string;
  component: string;
  fields: Record<string, unknown>;
}

function structuredLogEvents(spy: { mock: { calls: unknown[][] } }): StructuredEvent[] {
  const events: StructuredEvent[] = [];
  for (const call of spy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as {
        operation?: unknown;
        level?: unknown;
        component?: unknown;
        fields?: unknown;
      };
      if (parsed && typeof parsed.operation === "string") {
        events.push({
          operation: parsed.operation,
          level: typeof parsed.level === "string" ? parsed.level : "",
          component: typeof parsed.component === "string" ? parsed.component : "",
          fields:
            parsed.fields && typeof parsed.fields === "object"
              ? (parsed.fields as Record<string, unknown>)
              : {},
        });
      }
    } catch {
      // Non-JSON console.info lines are not structured events.
    }
  }
  return events;
}

/** Run `run` with console.info spied; return its result + the parsed structured events. */
async function captureInfo<T>(run: () => Promise<T>): Promise<{ result: T; events: StructuredEvent[] }> {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const result = await run();
    return { result, events: structuredLogEvents(spy) };
  } finally {
    spy.mockRestore();
  }
}

function forComponent(events: StructuredEvent[], component: string): StructuredEvent[] {
  return events.filter((e) => e.component === component);
}

function has(
  events: StructuredEvent[],
  operation: string,
  level: string,
  fields?: Record<string, unknown>,
): StructuredEvent | undefined {
  return events.find(
    (e) =>
      e.operation === operation &&
      e.level === level &&
      (fields === undefined ||
        Object.entries(fields).every(([k, v]) => e.fields[k] === v)),
  );
}

// ---------------------------------------------------------------------------
// Catalog pins
// ---------------------------------------------------------------------------

describe("module logging #5607: catalog codes", () => {
  it("the 7 new codes resolve with the correct httpStatus", () => {
    const expected: Array<[string, number]> = [
      ["FAILURE_COMMERCIAL_UNAUTHORIZED", 401],
      ["FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED", 405],
      ["FAILURE_COMMERCIAL_OPERATOR_REQUIRED", 403],
      ["FAILURE_PAYMENT_ASSURANCE_DISABLED", 403],
      ["FAILURE_PAYMENT_ASSURANCE_NOT_ALLOWED", 403],
      ["FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE", 409],
      ["FAILURE_PAYMENT_ASSURANCE_LIVE_TEST_ONLY", 403],
    ];
    for (const [code, status] of expected) {
      const entry = getOutcome(code);
      expect(entry, code).not.toBeNull();
      expect(entry!.httpStatus).toBe(status);
      expect(entry!.category).toBe("commercial");
      expect(entry!.outcome).toBe("failure");
      expect(entry!.retryable).toBe(false);
      expect(codedMessage(code)).toBe(`[${code}] ${entry!.businessMessage}`);
    }
    expect(Object.keys(outcomeCatalog.outcomes)).toHaveLength(276); // #5867: +1 FAILURE_COMMERCIAL_AUDIT_REQUIRED; +1 (#3571 residual: SUCCESS_TOP_UP_CLAIMED); +6 (#5098 tuple model: the six FAILURE_TUPLE_* validation codes); +7 (#5160 IDP profile codes)
  });

  it("the reused codes resolve with the correct httpStatus", () => {
    const expected: Array<[string, number]> = [
      ["FAILURE_COMMERCIAL_NOT_FOUND", 404],
      ["FAILURE_COMMERCIAL_REQUEST_INVALID", 400],
      ["FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503],
      ["FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE", 503],
      ["FAILURE_UNEXPECTED_ERROR", 500],
      ["FAILURE_PROFILE_NOT_SIGNED_IN", 401],
    ];
    for (const [code, status] of expected) {
      expect(getOutcome(code)?.httpStatus).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// Source pins: no bare console.*, no uncoded literals left
// ---------------------------------------------------------------------------

describe("module logging #5607: source pins", () => {
  it("no bare console.* in the converted files", () => {
    for (const file of CONVERTED) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });

  it("no uncoded error literal remains in the converted files", () => {
    const literals = [
      "Method not allowed",
      "Unknown tenant.",
      "Unauthorized: a signed-in session is required.",
      "Unauthorized: verified login required.",
      "Forbidden: tenant administration requires a store operator.",
      "Forbidden: channel administration requires a store operator.",
      "Forbidden: store operator required.",
      "AGENT_DB is not bound",
      "Commercial account store is unavailable.",
      "Onboarding state store is unavailable.",
      "not supported by the bound channel store",
      "payment_assurance flag is OFF",
      "Live testing is not configured for this login.",
      "Only live-test workflow ids can",
      "Internal error.",
      "native Stripe is not configured",
      "monetization flag is OFF",
      "PAYMENT_WORKFLOW binding is not configured",
    ];
    for (const file of CONVERTED) {
      const src = readFileSync(file, "utf8");
      for (const literal of literals) {
        expect(src, `${file}: ${literal}`).not.toContain(literal);
      }
    }
  });

  it("the hard-to-drive degrade sites exist (source presence)", () => {
    const accounts = readFileSync("src/agents/routes/platformAccounts.ts", "utf8");
    expect(accounts).toContain("platformAccounts.identity_resolve_degraded");
    expect(accounts).toContain("platformAccounts.signup_attribution_failed");
    expect(accounts).toContain("platform.account.referral_attribution_failed");
  });
});

// ---------------------------------------------------------------------------
// G2 — platformTenants
// ---------------------------------------------------------------------------

function tenantCtx(overrides: Record<string, unknown> = {}) {
  const commercial = new InMemoryCommercialAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  return {
    commercial,
    directory,
    operators: {
      listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }],
    },
    ...overrides,
  };
}

async function seedTenants(c: ReturnType<typeof tenantCtx>) {
  await c.commercial.upsertAccount({
    userId: "alice",
    tenantId: "tenant-a",
    tier: "PayPerUse",
    creditsUSD: 5,
    includedRuns: 2,
  });
  await c.commercial.upsertAccount({ userId: "bob", tenantId: "tenant-a", tier: "Free" });
  c.directory.seedTenant("tenant-a", ["alice", "bob"]);
  c.directory.seedTenant("tenant-b", []);
  await c.commercial.setTenantAdsEnabled("tenant-b", false);
}

function tenantReq(path: string, method: string, login: string | null, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callTenants(
  c: ReturnType<typeof tenantCtx>,
  path: string,
  method: string,
  login: string | null = "op",
  body?: unknown,
  envOverrides: Record<string, unknown> = {},
) {
  const res = await handlePlatformTenantRoutes(
    tenantReq(path, method, login, body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    {
      env: { COMMERCIAL_STORE_OPERATORS: "", ...envOverrides } as never,
      commercial: c.commercial as never,
      directory: c.directory as never,
      operators: c.operators as never,
      ...(c as Record<string, unknown>).audit !== undefined
        ? { audit: (c as Record<string, unknown>).audit as never }
        : {},
    },
  );
  if (!res) return { res, body: null as unknown };
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("module logging #5607: tenants (G2)", () => {
  it("list logs entry + outcome; refusals log warn with the code", async () => {
    const c = tenantCtx();
    await seedTenants(c);
    const { result, events } = await captureInfo(() => callTenants(c, "/platform-tenants", "GET"));
    expect(result.res?.status).toBe(200);
    const ev = forComponent(events, "agents/routes/platformTenants");
    expect(has(ev, "platformTenants.request_started", "info", { action: "list" })).toBeDefined();
    expect(has(ev, "platformTenants.tenants_listed", "info")).toBeDefined();

    const refused = await captureInfo(() => callTenants(c, "/platform-tenants", "GET", null));
    expect(refused.result.res?.status).toBe(401);
    expect(refused.result.body).toEqual({
      code: "FAILURE_COMMERCIAL_UNAUTHORIZED",
      error: codedMessage("FAILURE_COMMERCIAL_UNAUTHORIZED"),
    });
    const refusedEv = forComponent(refused.events, "agents/routes/platformTenants");
    expect(
      has(refusedEv, "platformTenants.request_refused", "warn", {
        code: "FAILURE_COMMERCIAL_UNAUTHORIZED",
        status: 401,
      }),
    ).toBeDefined();
  });

  it("403 / 404 / 405 / 503 are coded with statuses unchanged", async () => {
    const c = tenantCtx();
    await seedTenants(c);
    const forbidden = await callTenants(c, "/platform-tenants", "GET", "mallory");
    expect(forbidden.res?.status).toBe(403);
    expect(forbidden.body.code).toBe("FAILURE_COMMERCIAL_OPERATOR_REQUIRED");
    expect(forbidden.body.error).toBe(codedMessage("FAILURE_COMMERCIAL_OPERATOR_REQUIRED"));

    const unknown = await callTenants(c, "/platform-tenants/nope", "GET");
    expect(unknown.res?.status).toBe(404);
    expect(unknown.body.code).toBe("FAILURE_COMMERCIAL_NOT_FOUND");

    const wrongMethod = await callTenants(c, "/platform-tenants", "DELETE");
    expect(wrongMethod.res?.status).toBe(405);
    expect(wrongMethod.body.code).toBe("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED");

    const unbound = await handlePlatformTenantRoutes(
      tenantReq("/platform-tenants", "GET", "op"),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "session-1",
      {
        env: {} as never,
        commercial: null,
        directory: null,
        operators: { listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }] } as never,
      },
    );
    expect(unbound?.status).toBe(503);
    expect(((await unbound?.json()) as Record<string, unknown>).code).toBe(
      "FAILURE_COMMERCIAL_STORE_UNAVAILABLE",
    );
  });

  it("create / detail / settings log their outcome events", async () => {
    const c = tenantCtx();
    await seedTenants(c);
    const created = await captureInfo(() =>
      callTenants(c, "/platform-tenants", "POST", "op", { tenantId: "tenant-c" }),
    );
    expect(created.result.res?.status).toBe(201);
    expect(
      has(forComponent(created.events, "agents/routes/platformTenants"), "platformTenants.tenant_created", "info", {
        created: true,
      }),
    ).toBeDefined();
    const again = await captureInfo(() =>
      callTenants(c, "/platform-tenants", "POST", "op", { tenantId: "tenant-b" }),
    );
    expect(again.result.res?.status).toBe(200);
    expect(
      has(forComponent(again.events, "agents/routes/platformTenants"), "platformTenants.tenant_created", "info", {
        created: false,
      }),
    ).toBeDefined();

    const detail = await captureInfo(() => callTenants(c, "/platform-tenants/tenant-a", "GET"));
    expect(detail.result.res?.status).toBe(200);
    expect(
      has(forComponent(detail.events, "agents/routes/platformTenants"), "platformTenants.tenant_detail_read", "info"),
    ).toBeDefined();

    const settings = await captureInfo(() =>
      callTenants(c, "/platform-tenants/tenant-a/settings", "PATCH", "op", { adsEnabled: false }),
    );
    expect(settings.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(settings.events, "agents/routes/platformTenants"),
        "platformTenants.tenant_settings_updated",
        "info",
      ),
    ).toBeDefined();
  });

  it("operator-list and audit degrades log warns and never fail the call", async () => {
    const throwing = tenantCtx({
      operators: {
        listOperators: async () => {
          throw new Error("store list boom");
        },
      },
    });
    await seedTenants(throwing);
    const degraded = await captureInfo(() =>
      callTenants(throwing, "/platform-tenants", "GET", "op", undefined, {
        COMMERCIAL_STORE_OPERATORS: "op",
      }),
    );
    expect(degraded.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(degraded.events, "agents/routes/platformTenants"),
        "platformTenants.operator_list_degraded",
        "warn",
      ),
    ).toBeDefined();

    const auditThrowing = tenantCtx({
      audit: () => {
        throw new Error("audit boom");
      },
    });
    await seedTenants(auditThrowing);
    const created = await captureInfo(() =>
      callTenants(auditThrowing, "/platform-tenants", "POST", "op", { tenantId: "tenant-c" }),
    );
    expect(created.result.res?.status).toBe(201);
    expect(
      has(
        forComponent(created.events, "agents/routes/platformTenants"),
        "platformTenants.audit_annotation_failed",
        "warn",
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// G4 — platformChannels
// ---------------------------------------------------------------------------

function channelCtx(overrides: Record<string, unknown> = {}) {
  const channels = new InMemoryTenantChannelAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("tenant-a", ["alice"]);
  return {
    channels,
    directory,
    // #5867: audit-before-write needs a working IAAA audit store.
    auditStore: createMemoryAuditStore(),
    operators: {
      listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }],
    },
    ...overrides,
  };
}

async function callChannels(
  c: ReturnType<typeof channelCtx>,
  path: string,
  method: string,
  login: string | null = "op",
  body?: unknown,
  envOverrides: Record<string, unknown> = {},
) {
  const res = await handlePlatformChannelRoutes(
    tenantReq(path, method, login, body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    {
      env: { COMMERCIAL_STORE_OPERATORS: "", ...envOverrides } as never,
      channels: c.channels as never,
      directory: c.directory as never,
      auditStore: c.auditStore as never,
      operators: c.operators as never,
      ...(c as Record<string, unknown>).audit !== undefined
        ? { audit: (c as Record<string, unknown>).audit as never }
        : {},
    },
  );
  if (!res) return { res, body: null as unknown };
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("module logging #5607: channels (G4)", () => {
  it("read logs entry + outcome; refusals log warn with the code", async () => {
    const c = channelCtx();
    const { result, events } = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a", "GET"),
    );
    expect(result.res?.status).toBe(200);
    const ev = forComponent(events, "agents/routes/platformChannels");
    expect(has(ev, "platformChannels.request_started", "info", { action: "read" })).toBeDefined();
    expect(has(ev, "platformChannels.channels_read", "info")).toBeDefined();

    const refused = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a", "GET", null),
    );
    expect(refused.result.res?.status).toBe(401);
    expect(refused.result.body).toEqual({
      code: "FAILURE_COMMERCIAL_UNAUTHORIZED",
      error: codedMessage("FAILURE_COMMERCIAL_UNAUTHORIZED"),
    });
    expect(
      has(forComponent(refused.events, "agents/routes/platformChannels"), "platformChannels.request_refused", "warn", {
        code: "FAILURE_COMMERCIAL_UNAUTHORIZED",
        status: 401,
      }),
    ).toBeDefined();
  });

  it("403 / 404 / 405 / 503 are coded with statuses unchanged", async () => {
    const c = channelCtx();
    const forbidden = await callChannels(c, "/platform-channels/tenant-a", "GET", "mallory");
    expect(forbidden.res?.status).toBe(403);
    expect(forbidden.body.code).toBe("FAILURE_COMMERCIAL_OPERATOR_REQUIRED");

    const unknown = await callChannels(c, "/platform-channels/nope", "GET");
    expect(unknown.res?.status).toBe(404);
    expect(unknown.body.code).toBe("FAILURE_COMMERCIAL_NOT_FOUND");

    const wrongMethod = await callChannels(c, "/platform-channels/tenant-a", "DELETE");
    expect(wrongMethod.res?.status).toBe(405);
    expect(wrongMethod.body.code).toBe("FAILURE_COMMERCIAL_METHOD_NOT_ALLOWED");

    const unbound = await callChannels(channelCtx({ channels: null }), "/platform-channels/tenant-a", "GET");
    expect(unbound.res?.status).toBe(503);
    expect(unbound.body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");
  });

  it("webhook-url / slack-channel / patch log their outcome events", async () => {
    const c = channelCtx();
    const webhookGet = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a/webhook-url", "GET"),
    );
    expect(webhookGet.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(webhookGet.events, "agents/routes/platformChannels"),
        "platformChannels.webhook_url_read",
        "info",
      ),
    ).toBeDefined();
    const webhookPut = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a/webhook-url", "PUT", "op", {
        webhookUrl: "https://example.test/hook",
      }),
    );
    expect(webhookPut.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(webhookPut.events, "agents/routes/platformChannels"),
        "platformChannels.webhook_url_updated",
        "info",
      ),
    ).toBeDefined();

    const slackGet = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a/slack-channel", "GET"),
    );
    expect(slackGet.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(slackGet.events, "agents/routes/platformChannels"),
        "platformChannels.slack_channel_read",
        "info",
      ),
    ).toBeDefined();
    const slackPut = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a/slack-channel", "PUT", "op", {
        slackChannel: "#general",
      }),
    );
    expect(slackPut.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(slackPut.events, "agents/routes/platformChannels"),
        "platformChannels.slack_channel_updated",
        "info",
      ),
    ).toBeDefined();

    const patch = await captureInfo(() =>
      callChannels(c, "/platform-channels/tenant-a/channels", "PATCH", "op", {
        channels: { slack: true },
      }),
    );
    expect(patch.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(patch.events, "agents/routes/platformChannels"),
        "platformChannels.channels_updated",
        "info",
      ),
    ).toBeDefined();
  });

  it("operator-list and audit degrades log warns and never fail the call", async () => {
    const throwing = channelCtx({
      operators: {
        listOperators: async () => {
          throw new Error("store list boom");
        },
      },
    });
    const degraded = await captureInfo(() =>
      callChannels(throwing, "/platform-channels/tenant-a", "GET", "op", undefined, {
        COMMERCIAL_STORE_OPERATORS: "op",
      }),
    );
    expect(degraded.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(degraded.events, "agents/routes/platformChannels"),
        "platformChannels.operator_list_degraded",
        "warn",
      ),
    ).toBeDefined();

    const auditThrowing = channelCtx({
      audit: () => {
        throw new Error("audit boom");
      },
    });
    const patched = await captureInfo(() =>
      callChannels(auditThrowing, "/platform-channels/tenant-a/channels", "PATCH", "op", {
        channels: { slack: false },
      }),
    );
    expect(patched.result.res?.status).toBe(200);
    expect(
      has(
        forComponent(patched.events, "agents/routes/platformChannels"),
        "platformChannels.audit_annotation_failed",
        "warn",
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// G3 — platformAccounts
// ---------------------------------------------------------------------------

function accountPorts(overrides: Partial<PlatformAccountPorts> = {}): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
    profile: null,
    ...overrides,
  };
}

function accountCtx(
  ports: PlatformAccountPorts,
  env: Record<string, unknown> = {},
): PlatformAccountRouteContext {
  return { env: env as never, audit: vi.fn(), ports } as PlatformAccountRouteContext;
}

function accountReq(method: string, path: string, login?: string, body?: unknown): Request {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function callAccounts(
  ctx: PlatformAccountRouteContext,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const url = new URL(request.url);
  const res = await handlePlatformAccountRoutes(request, url, url.pathname, "session-1", ctx);
  if (!res) return null;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("module logging #5607: accounts (G3)", () => {
  it("self logs entry + outcome; the 401 is coded {code, message} with a refusal warn", async () => {
    const ports = accountPorts();
    await ports.commercial!.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const ctx = accountCtx(ports);
    const { result, events } = await captureInfo(() =>
      callAccounts(ctx, accountReq("GET", "/platform/accounts/self", "alice")),
    );
    expect(result?.status).toBe(200);
    const ev = forComponent(events, "agents/routes/platformAccounts");
    expect(has(ev, "platformAccounts.request_started", "info", { route: "self" })).toBeDefined();
    expect(has(ev, "platformAccounts.account_self_read", "info")).toBeDefined();

    const refused = await captureInfo(() =>
      callAccounts(ctx, accountReq("GET", "/platform/accounts/self")),
    );
    expect(refused.result?.status).toBe(401);
    expect(refused.result?.body.code).toBe("FAILURE_COMMERCIAL_UNAUTHORIZED");
    expect(refused.result?.body.message).toBe(
      getOutcome("FAILURE_COMMERCIAL_UNAUTHORIZED")!.businessMessage,
    );
    expect(
      has(forComponent(refused.events, "agents/routes/platformAccounts"), "platformAccounts.request_refused", "warn", {
        code: "FAILURE_COMMERCIAL_UNAUTHORIZED",
        status: 401,
      }),
    ).toBeDefined();
  });

  it("profile 401 keeps FAILURE_PROFILE_NOT_SIGNED_IN", async () => {
    const ctx = accountCtx(accountPorts());
    const res = await callAccounts(ctx, accountReq("GET", "/platform/accounts/profile"));
    expect(res?.status).toBe(401);
    expect(res?.body.code).toBe("FAILURE_PROFILE_NOT_SIGNED_IN");
  });

  it("lookup 403 / self 503 / onboarding 503 are coded with statuses unchanged", async () => {
    const ports = accountPorts();
    await ports.commercial!.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const stranger = await callAccounts(
      accountCtx(ports),
      accountReq("GET", "/platform/accounts/lookup?userId=alice", "mallory"),
    );
    expect(stranger?.status).toBe(403);
    expect(stranger?.body.code).toBe("FAILURE_COMMERCIAL_OPERATOR_REQUIRED");
    expect(stranger?.body.message).toBe(
      getOutcome("FAILURE_COMMERCIAL_OPERATOR_REQUIRED")!.businessMessage,
    );

    const unboundSelf = await callAccounts(
      accountCtx(accountPorts({ commercial: null, subscriptions: null })),
      accountReq("GET", "/platform/accounts/self", "alice"),
    );
    expect(unboundSelf?.status).toBe(503);
    expect(unboundSelf?.body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");

    const unboundOnboarding = await callAccounts(
      accountCtx(accountPorts({ onboarding: null })),
      accountReq("GET", "/platform/onboarding/state", "alice"),
    );
    expect(unboundOnboarding?.status).toBe(503);
    expect(unboundOnboarding?.body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");

    const unboundLookup = await callAccounts(
      accountCtx(accountPorts({ commercial: null, subscriptions: null }), {
        COMMERCIAL_STORE_OPERATORS: "op",
      }),
      accountReq("GET", "/platform/accounts/lookup?userId=alice", "op"),
    );
    expect(unboundLookup?.status).toBe(503);
    expect(unboundLookup?.body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");
  });

  it("lookup / onboarding / setup log their outcome events", async () => {
    const ports = accountPorts();
    await ports.commercial!.upsertAccount({ userId: "alice", tenantId: "tenant-a", tier: "Free" });
    const opCtx = accountCtx(ports, { COMMERCIAL_STORE_OPERATORS: "op" });
    const lookup = await captureInfo(() =>
      callAccounts(opCtx, accountReq("GET", "/platform/accounts/lookup?userId=alice", "op")),
    );
    expect(lookup.result?.status).toBe(200);
    expect(
      has(
        forComponent(lookup.events, "agents/routes/platformAccounts"),
        "platformAccounts.account_lookup_succeeded",
        "info",
      ),
    ).toBeDefined();

    const aliceCtx = accountCtx(ports);
    const onboardingGet = await captureInfo(() =>
      callAccounts(aliceCtx, accountReq("GET", "/platform/onboarding/state", "alice")),
    );
    expect(onboardingGet.result?.status).toBe(200);
    expect(
      has(
        forComponent(onboardingGet.events, "agents/routes/platformAccounts"),
        "platformAccounts.onboarding_state_read",
        "info",
      ),
    ).toBeDefined();
    const onboardingSave = await captureInfo(() =>
      callAccounts(
        aliceCtx,
        accountReq("POST", "/platform/onboarding/state", "alice", { currentStep: 2 }),
      ),
    );
    expect(onboardingSave.result?.status).toBe(200);
    expect(
      has(
        forComponent(onboardingSave.events, "agents/routes/platformAccounts"),
        "platformAccounts.onboarding_state_saved",
        "info",
      ),
    ).toBeDefined();

    const setupExisting = await captureInfo(() =>
      callAccounts(aliceCtx, accountReq("POST", "/platform/accounts/setup", "alice", {})),
    );
    expect(setupExisting.result?.status).toBe(200);
    expect(setupExisting.result?.body.created).toBe(false);
    expect(
      has(
        forComponent(setupExisting.events, "agents/routes/platformAccounts"),
        "platformAccounts.account_setup_succeeded",
        "info",
        { created: false },
      ),
    ).toBeDefined();
    const setupCreated = await captureInfo(() =>
      callAccounts(aliceCtx, accountReq("POST", "/platform/accounts/setup", "carol", {})),
    );
    expect(setupCreated.result?.status).toBe(200);
    expect(setupCreated.result?.body.created).toBe(true);
    expect(
      has(
        forComponent(setupCreated.events, "agents/routes/platformAccounts"),
        "platformAccounts.account_setup_succeeded",
        "info",
        { created: true },
      ),
    ).toBeDefined();
  });

  it("operator-list and catalogue degrades log warns and never fail the call", async () => {
    const throwingOperators = accountPorts({
      operators: {
        listOperators: async () => {
          throw new Error("store list boom");
        },
      } as never,
    });
    await throwingOperators.commercial!.upsertAccount({
      userId: "alice",
      tenantId: "tenant-a",
      tier: "Free",
    });
    const refused = await captureInfo(() =>
      callAccounts(
        accountCtx(throwingOperators),
        accountReq("GET", "/platform/accounts/lookup?userId=alice", "mallory"),
      ),
    );
    expect(refused.result?.status).toBe(403);
    expect(
      has(
        forComponent(refused.events, "agents/routes/platformAccounts"),
        "platformAccounts.operator_list_degraded",
        "warn",
      ),
    ).toBeDefined();

    const throwingCatalogue = accountPorts({
      prices: {
        getAllPrices: async () => {
          throw new Error("catalogue boom");
        },
      } as never,
    });
    await throwingCatalogue.commercial!.upsertAccount({
      userId: "alice",
      tenantId: "tenant-a",
      tier: "Free",
    });
    const self = await captureInfo(() =>
      callAccounts(
        accountCtx(throwingCatalogue),
        accountReq("GET", "/platform/accounts/self", "alice"),
      ),
    );
    expect(self.result?.status).toBe(200);
    expect(self.result?.body.catalogueAvailable).toBe(false);
    expect(
      has(
        forComponent(self.events, "agents/routes/platformAccounts"),
        "platformAccounts.catalogue_read_failed",
        "warn",
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// G9 — paymentAssuranceLive
// ---------------------------------------------------------------------------

type AssuranceBinding = {
  created: Array<{ id: string; params: unknown }>;
  events: Array<{ id: string; event: unknown }>;
  binding: {
    create: (options: { id: string; params: unknown }) => Promise<{ id: string }>;
    get: (id: string) => Promise<{
      sendEvent: (event: unknown) => Promise<void>;
      status: () => Promise<string>;
    }>;
  };
};

function makeAssuranceBinding(): AssuranceBinding {
  const created: AssuranceBinding["created"] = [];
  const events: AssuranceBinding["events"] = [];
  return {
    created,
    events,
    binding: {
      create: async (options) => {
        created.push(options);
        return { id: options.id };
      },
      get: async (id: string) => ({
        sendEvent: async (event: unknown) => {
          events.push({ id, event });
        },
        status: async () => "running",
      }),
    },
  };
}

function assuranceEnv(overrides: Record<string, unknown>, binding: unknown) {
  return {
    FEATURE_PAYMENT_ASSURANCE: "1",
    PAYMENT_ASSURANCE_LIVE_LOGINS: "tester",
    PAYMENT_WORKFLOW: binding,
    ...overrides,
  };
}

function assuranceReq(path: string, method: string, body?: unknown, login = "tester"): Request {
  return new Request(`https://worker.local${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callAssurance(
  req: Request,
  env: unknown,
  checkoutPorts?: CheckoutPorts | null,
) {
  const url = new URL(req.url);
  const res = await handlePaymentAssuranceLiveRoutes(req, url, url.pathname, undefined, {
    env,
    ...(checkoutPorts !== undefined ? { checkoutPorts } : {}),
  });
  if (!res) return { res, body: null as unknown };
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function fakeCardPort(evidenceByKey: Record<string, CardSessionEvidence>): CheckoutPort {
  return {
    rail: "stripe",
    createCheckout: async () => {
      throw new Error("not used by the assurance routes");
    },
    retrieveCardSession: async (input) => {
      const evidence = evidenceByKey[input.sessionId];
      if (!evidence) throw new Error(`No session for ${input.sessionId}`);
      return evidence;
    },
    verifyCryptoPayment: async () => {
      throw new Error("StripeCheckoutAdapter cannot verify x402 payments");
    },
  };
}

function cardPorts(evidenceByKey: Record<string, CardSessionEvidence>): CheckoutPorts {
  return { card: fakeCardPort(evidenceByKey), x402: null };
}

function paidEvidence(sessionId: string, reference: string): CardSessionEvidence {
  return {
    sessionId,
    status: "complete",
    paymentStatus: "paid",
    amountTotalCents: 1000,
    clientReferenceId: reference,
    paymentIntentId: "pi_test_123",
  };
}

function unpaidEvidence(sessionId: string, reference: string): CardSessionEvidence {
  return {
    sessionId,
    status: "open",
    paymentStatus: "unpaid",
    amountTotalCents: 1000,
    clientReferenceId: reference,
  };
}

describe("module logging #5607: payment assurance (G9)", () => {
  it("start logs entry + the existing run-started outcome", async () => {
    const b = makeAssuranceBinding();
    const { result, events } = await captureInfo(() =>
      callAssurance(
        assuranceReq("/api/assurance/payment-workflow/start", "POST", {
          mode: "coverage",
          scheduleKind: "one_off",
          authorizedAtSubmission: false,
        }),
        assuranceEnv({}, b.binding),
      ),
    );
    expect(result.res?.status).toBe(200);
    const ev = forComponent(events, "agents/routes/paymentAssuranceLive");
    expect(
      has(ev, "paymentAssuranceLive.request_started", "info", { route: "start" }),
    ).toBeDefined();
    expect(has(ev, "paymentAssuranceLive.live_test_run_started", "info")).toBeDefined();
  });

  it("guard refusals are coded with a refusal warn (403 disabled, 401, 403 not-allowed)", async () => {
    const b = makeAssuranceBinding();
    const disabled = await captureInfo(() =>
      callAssurance(
        assuranceReq("/api/assurance/payment-workflow/start", "POST", { mode: "coverage" }),
        assuranceEnv({ FEATURE_PAYMENT_ASSURANCE: "0" }, b.binding),
      ),
    );
    expect(disabled.result.res?.status).toBe(403);
    expect(disabled.result.body).toEqual({
      code: "FAILURE_PAYMENT_ASSURANCE_DISABLED",
      error: codedMessage("FAILURE_PAYMENT_ASSURANCE_DISABLED"),
    });
    expect(
      has(
        forComponent(disabled.events, "agents/routes/paymentAssuranceLive"),
        "paymentAssuranceLive.request_refused",
        "warn",
        { code: "FAILURE_PAYMENT_ASSURANCE_DISABLED", status: 403 },
      ),
    ).toBeDefined();

    const noLogin = await callAssurance(
      new Request("https://worker.local/api/assurance/payment-workflow/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "coverage" }),
      }),
      assuranceEnv({}, b.binding),
    );
    expect(noLogin.res?.status).toBe(401);
    expect(noLogin.body.code).toBe("FAILURE_COMMERCIAL_UNAUTHORIZED");

    const outsider = await callAssurance(
      assuranceReq("/api/assurance/payment-workflow/start", "POST", { mode: "coverage" }, "mallory"),
      assuranceEnv({}, b.binding),
    );
    expect(outsider.res?.status).toBe(403);
    expect(outsider.body.code).toBe("FAILURE_PAYMENT_ASSURANCE_NOT_ALLOWED");
  });

  it("checkout 409, live-test-only 403, and the 500 are coded with statuses unchanged", async () => {
    const b = makeAssuranceBinding();
    const refused = await callAssurance(
      assuranceReq("/api/assurance/payment-workflow/start", "POST", { mode: "checkout" }),
      assuranceEnv({}, b.binding),
    );
    expect(refused.res?.status).toBe(409);
    expect(refused.body.code).toBe("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE");
    expect(refused.body.error).toBe(codedMessage("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE"));

    const prodEvent = await callAssurance(
      assuranceReq("/api/assurance/payment-workflow/event", "POST", {
        workflowId: "run-123",
        type: "approval",
        approved: true,
      }),
      assuranceEnv({}, b.binding),
    );
    expect(prodEvent.res?.status).toBe(403);
    expect(prodEvent.body.code).toBe("FAILURE_PAYMENT_ASSURANCE_LIVE_TEST_ONLY");

    const throwing = {
      create: async () => {
        throw new Error("SECRET-INTERNAL-DETAIL");
      },
      get: async () => ({
        sendEvent: async () => {},
        status: async () => {
          throw new Error("instance not found");
        },
      }),
    };
    const failed = await callAssurance(
      assuranceReq("/api/assurance/payment-workflow/start", "POST", {
        mode: "coverage",
        scheduleKind: "one_off",
        authorizedAtSubmission: false,
      }),
      assuranceEnv({}, throwing),
    );
    expect(failed.res?.status).toBe(500);
    expect(failed.body.code).toBe("FAILURE_UNEXPECTED_ERROR");
    expect(JSON.stringify(failed.body)).not.toContain("SECRET-INTERNAL-DETAIL");
  });

  it("status read logs its outcome; a throwing instance status degrades with a warn", async () => {
    const b = makeAssuranceBinding();
    const { result, events } = await captureInfo(() =>
      callAssurance(
        assuranceReq("/api/assurance/payment-workflow/status?workflowId=live-test-9", "GET"),
        assuranceEnv({}, b.binding),
      ),
    );
    expect(result.res?.status).toBe(200);
    expect(result.body.instanceStatus).toBe("running");
    expect(
      has(
        forComponent(events, "agents/routes/paymentAssuranceLive"),
        "paymentAssuranceLive.status_read",
        "info",
      ),
    ).toBeDefined();

    const throwingStatus = {
      create: async (options: { id: string; params: unknown }) => ({ id: options.id }),
      get: async () => ({
        sendEvent: async () => {},
        status: async () => {
          throw new Error("status boom");
        },
      }),
    };
    const degraded = await captureInfo(() =>
      callAssurance(
        assuranceReq("/api/assurance/payment-workflow/status?workflowId=live-test-9", "GET"),
        assuranceEnv({}, throwingStatus),
        null,
      ),
    );
    expect(degraded.result.res?.status).toBe(200);
    expect(degraded.result.body.instanceStatus).toBe("unknown");
    expect(
      has(
        forComponent(degraded.events, "agents/routes/paymentAssuranceLive"),
        "paymentAssuranceLive.instance_status_degraded",
        "warn",
      ),
    ).toBeDefined();
  });

  it("check-payment logs delivered / not-fulfilled outcomes", async () => {
    const b = makeAssuranceBinding();
    const delivered = await captureInfo(() =>
      callAssurance(
        assuranceReq("/api/assurance/payment-workflow/check-payment", "POST", {
          workflowId: "live-test-2",
        }),
        assuranceEnv({}, b.binding),
        cardPorts({ "live-test-2": paidEvidence("live-test-2", "live-test-2") }),
      ),
    );
    expect(delivered.result.res?.status).toBe(200);
    expect(delivered.result.body.delivered).toBe(true);
    expect(
      has(
        forComponent(delivered.events, "agents/routes/paymentAssuranceLive"),
        "paymentAssuranceLive.check_payment_delivered",
        "info",
        { delivered: true },
      ),
    ).toBeDefined();

    const unfulfilled = await captureInfo(() =>
      callAssurance(
        assuranceReq("/api/assurance/payment-workflow/check-payment", "POST", {
          workflowId: "live-test-3",
        }),
        assuranceEnv({}, b.binding),
        cardPorts({ "live-test-3": unpaidEvidence("live-test-3", "live-test-3") }),
      ),
    );
    expect(unfulfilled.result.res?.status).toBe(200);
    expect(unfulfilled.result.body.delivered).toBe(false);
    expect(
      has(
        forComponent(unfulfilled.events, "agents/routes/paymentAssuranceLive"),
        "paymentAssuranceLive.check_payment_not_fulfilled",
        "info",
        { delivered: false },
      ),
    ).toBeDefined();
  });

  it("the nested 200-payload fields stay untouched (checkout.error, reason)", async () => {
    const b = makeAssuranceBinding();
    const status = await callAssurance(
      assuranceReq("/api/assurance/payment-workflow/status?workflowId=live-test-9", "GET"),
      assuranceEnv({}, b.binding),
      cardPorts({}),
    );
    expect(status.res?.status).toBe(200);
    expect((status.body.checkout as Record<string, unknown>).error).toBe(
      "Stripe session retrieve failed",
    );

    const unfulfilled = await callAssurance(
      assuranceReq("/api/assurance/payment-workflow/check-payment", "POST", {
        workflowId: "live-test-3",
      }),
      assuranceEnv({}, b.binding),
      cardPorts({ "live-test-3": unpaidEvidence("live-test-3", "live-test-3") }),
    );
    expect(unfulfilled.res?.status).toBe(200);
    expect(unfulfilled.body.reason).toBe(
      "Checkout session is not fulfilled for this run; no payment_verified event was delivered.",
    );
  });
});
