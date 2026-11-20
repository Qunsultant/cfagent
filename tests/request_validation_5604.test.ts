/**
 * Issue #5604 — hardening slice 3 (G-4 validation): one shared
 * request-validation helper on zod schemas.
 *
 * Pins, per the filed body:
 * - The helper is the only validation entry point for the
 *   converted routes (no second catalog): the four route files
 *   and the two validator modules import no zod directly; zod
 *   lives only in `src/api/requestValidation.ts`.
 * - Previously-valid inputs produce identical outcomes: the
 *   validator regression pins below extend (never replace) the
 *   existing suites (`tests/user_profile_3261.test.ts`,
 *   `tests/rest_twins_modes_1733.test.ts`); every route-level
 *   valid request succeeds exactly as before.
 * - Malformed requests get coded 400s naming the invalid shape:
 *   `{code: FAILURE_COMMERCIAL_REQUEST_INVALID, error}` with the
 *   existing message (the agenticPayments precedent), or the
 *   existing profile coded body for profile saves. Client
 *   `.error` handling is untouched.
 * - One enumerated behavior repair (#1768 precedent): a JSON body
 *   that is not an object (scalar, or array) previously threw on
 *   the `in` operator and surfaced as a 500; it now fails as the
 *   coded 400. Enumerated attribution changes (status + code
 *   unchanged, field only): a null profile-save body reports
 *   field `body` (was: the missing key), and a profile-save body
 *   with an ABSENT key and an invalid profile field reports the
 *   profile field (was: the missing key).
 * Tests inject every port: no DO, no D1, no network.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getOutcome } from "../src/outcomes/outcomeAspects";
import {
  REQUEST_INVALID_CODE,
  accountLookupQuerySchema,
  channelPatchBodySchema,
  isRecord,
  isTenantIdShaped,
  onboardingSaveBodySchema,
  profileInputSchema,
  profileSaveBodySchema,
  requestInvalidResponse,
  slackChannelBodySchema,
  strictAuditWriteSchema,
  tenantCreateBodySchema,
  tenantSettingsBodySchema,
  validateRequestShape,
  webhookUrlBodySchema,
} from "../src/api/requestValidation";
import {
  extractIdempotencyKey,
  validateProfileInput,
} from "../src/services/userProfile";
import { validateStrictAuditWrite } from "../src/config/restTwinsModes";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountPorts,
  type PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import { handlePlatformTenantRoutes } from "../src/agents/routes/platformTenants";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { handleAuditRoutes } from "../src/agents/routes/audit";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryProfileAdapter } from "../src/data/inMemoryProfileAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";

// Shared helper -------------------------------------------------------------

describe("validateRequestShape (#5604)", () => {
  it("passes a valid shape and strips unknown fields (ignored, as before)", () => {
    expect(
      validateRequestShape(profileInputSchema, {
        displayName: "Ada",
        userLogin: "mallory",
        tenantId: "evil-tenant",
      }),
    ).toEqual({ ok: true, value: { displayName: "Ada" } });
  });

  it("names the failing field and kind for a wrong-typed field", () => {
    expect(validateRequestShape(profileInputSchema, { email: 42 })).toEqual({
      ok: false,
      issues: [{ field: "email", kind: "wrongType", path: ["email"] }],
    });
  });

  it("names a missing required field", () => {
    expect(validateRequestShape(onboardingSaveBodySchema, {})).toEqual({
      ok: false,
      issues: [{ field: "currentStep", kind: "missing", path: ["currentStep"] }],
    });
  });

  it("names a non-object body as field `body`", () => {
    expect(validateRequestShape(onboardingSaveBodySchema, "x")).toEqual({
      ok: false,
      issues: [{ field: "body", kind: "wrongType", path: [] }],
    });
    expect(validateRequestShape(onboardingSaveBodySchema, 42).ok).toBe(false);
    expect(validateRequestShape(onboardingSaveBodySchema, []).ok).toBe(false);
    expect(validateRequestShape(onboardingSaveBodySchema, null).ok).toBe(false);
  });

  it("carries the nested path so a caller can name the nested field", () => {
    expect(
      validateRequestShape(channelPatchBodySchema, { channels: { slack: "yes" } }),
    ).toEqual({
      ok: false,
      issues: [{ field: "channels", kind: "wrongType", path: ["channels", "slack"] }],
    });
  });

  it("reports issues in schema order, never throws", () => {
    const multi = validateRequestShape(profileSaveBodySchema, {
      email: 42,
      idempotencyKey: 42,
      displayName: 42,
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.issues.map((i) => i.field)).toEqual([
        "idempotencyKey",
        "displayName",
        "email",
      ]);
    }
    expect(() => validateRequestShape(profileInputSchema, "x")).not.toThrow();
    expect(() => validateRequestShape(profileInputSchema, null)).not.toThrow();
  });
});

describe("requestInvalidResponse (#5604)", () => {
  it("renders the coded 400 with the caller's message", async () => {
    const res = requestInvalidResponse("userId is required.");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: "FAILURE_COMMERCIAL_REQUEST_INVALID",
      error: "userId is required.",
    });
  });

  it("the code resolves in the outcome catalog as a 400", () => {
    expect(REQUEST_INVALID_CODE).toBe("FAILURE_COMMERCIAL_REQUEST_INVALID");
    const entry = getOutcome(REQUEST_INVALID_CODE);
    expect(entry).toBeDefined();
    expect(entry!.httpStatus).toBe(400);
  });
});

describe("shared shape predicates (#5604)", () => {
  it("isTenantIdShaped matches the tenantQueueMapping rule", () => {
    expect(isTenantIdShaped("tenant-a")).toBe(true);
    expect(isTenantIdShaped("")).toBe(false);
    expect(isTenantIdShaped("   ")).toBe(false);
    expect(isTenantIdShaped("has space")).toBe(false);
    expect(isTenantIdShaped("x".repeat(513))).toBe(false);
    expect(isTenantIdShaped(42)).toBe(false);
    expect(isTenantIdShaped(null)).toBe(false);
  });

  it("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("no second catalog (#5604)", () => {
  const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");
  const sliceFiles = [
    "agents/routes/platformAccounts.ts",
    "agents/routes/platformTenants.ts",
    "agents/routes/platformChannels.ts",
    "agents/routes/audit.ts",
    "services/userProfile.ts",
    "config/restTwinsModes.ts",
  ];

  it("no converted file imports zod directly — zod lives only in the helper", () => {
    for (const file of sliceFiles) {
      expect(src(file)).not.toContain('from "zod"');
    }
    expect(src("api/requestValidation.ts")).toContain('from "zod"');
  });

  it("every converted file validates through the shared helper", () => {
    for (const file of sliceFiles) {
      expect(src(file)).toContain("api/requestValidation");
    }
  });
});

// Validator regression pins (new cases; the existing suites pin the rest) ---

describe("validateProfileInput on zod schemas (#5604)", () => {
  it("fails a scalar or array body as field `body` (was a throw → 500)", () => {
    expect(validateProfileInput("x")).toEqual({
      ok: false,
      failure: { field: "body", kind: "wrongType" },
    });
    expect(validateProfileInput(42)).toEqual({
      ok: false,
      failure: { field: "body", kind: "wrongType" },
    });
    expect(validateProfileInput([])).toEqual({
      ok: false,
      failure: { field: "body", kind: "wrongType" },
    });
  });

  it("keeps absent input as no update (null/undefined stay ok)", () => {
    expect(validateProfileInput(null)).toEqual({ ok: true, value: {} });
    expect(validateProfileInput(undefined)).toEqual({ ok: true, value: {} });
  });

  it("keeps an explicit-undefined field as wrongType (business rules run on the raw input)", () => {
    expect(validateProfileInput({ displayName: undefined })).toEqual({
      ok: false,
      failure: { field: "displayName", kind: "wrongType" },
    });
  });

  it("keeps previously-valid inputs identical through the zod gate", () => {
    expect(validateProfileInput({ displayName: "  Ada  ", phone: null })).toEqual({
      ok: true,
      value: { displayName: "Ada", phone: null },
    });
    expect(validateProfileInput({ email: 42 })).toEqual({
      ok: false,
      failure: { field: "email", kind: "wrongType" },
    });
  });
});

describe("extractIdempotencyKey on non-object bodies (#5604)", () => {
  it("reads a scalar or array body as a missing key, never a throw", () => {
    expect(extractIdempotencyKey("x")).toEqual({ ok: false, kind: "missing" });
    expect(extractIdempotencyKey(42)).toEqual({ ok: false, kind: "missing" });
    expect(extractIdempotencyKey([])).toEqual({ ok: false, kind: "missing" });
    expect(extractIdempotencyKey(null)).toEqual({ ok: false, kind: "missing" });
  });
});

describe("validateStrictAuditWrite on zod schemas (#5604)", () => {
  it("keeps the non-string-type message through the shape gate", () => {
    expect(validateStrictAuditWrite({ type: 42 }, "trading")).toEqual({
      ok: false,
      error: "type (non-empty string) is required",
    });
    expect(validateStrictAuditWrite(null, "trading")).toEqual({
      ok: false,
      error: "A JSON object body is required",
    });
    expect(validateStrictAuditWrite("x" as never, "trading")).toEqual({
      ok: false,
      error: "A JSON object body is required",
    });
  });

  it("keeps the agent default and the payload coercion the schema deliberately leaves unknown", () => {
    const defaulted = validateStrictAuditWrite({ type: "t", agent: 42 }, "trading");
    expect(defaulted.ok && defaulted.value.agent).toBe("trading");
    const coerced = validateStrictAuditWrite({ type: "t", payload: "nope" }, "trading");
    expect(coerced.ok && coerced.value.payload).toEqual({});
    const ok = validateStrictAuditWrite(
      { type: "t", mode: "strict", extra: "ignored" } as never,
      "orchestrator",
    );
    expect(ok.ok && ok.value.type).toBe("t");
  });
});

// Route-level pins -----------------------------------------------------------

function jsonReq(path: string, method: string, login: string | null, body?: unknown): Request {
  // Every defined body is JSON-encoded (a string body is the JSON
  // string `"x"`, not raw `x`, which would be malformed JSON).
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(raw !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(raw !== undefined ? { body: raw } : {}),
  });
}

async function jsonBody(res: Response | null): Promise<Record<string, unknown>> {
  return (await res?.json().catch(() => ({}))) as Record<string, unknown>;
}

// Accounts family -----------------------------------------------------------

function accountPorts(overrides: Partial<PlatformAccountPorts> = {}): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
    profile: new InMemoryProfileAdapter(),
    ...overrides,
  };
}

function accountCtx(
  ports: PlatformAccountPorts,
  env: Record<string, unknown> = { COMMERCIAL_STORE_OPERATORS: "op" },
): PlatformAccountRouteContext {
  return { env: env as never, audit: vi.fn(), ports } as PlatformAccountRouteContext;
}

async function callAccounts(ctx: PlatformAccountRouteContext, request: Request) {
  const url = new URL(request.url);
  const res = await handlePlatformAccountRoutes(request, url, url.pathname, "session-1", ctx);
  if (!res) return null;
  return { status: res.status, body: await jsonBody(res) };
}

describe("accounts family on the helper (#5604)", () => {
  it("lookup: a missing userId is a coded 400; a present one still reads", async () => {
    const ctx = accountCtx(accountPorts());
    const missing = await callAccounts(ctx, jsonReq("/platform/accounts/lookup", "GET", "op"));
    expect(missing?.status).toBe(400);
    expect(missing?.body).toEqual({ code: REQUEST_INVALID_CODE, error: "userId is required." });
    const empty = await callAccounts(
      ctx,
      jsonReq("/platform/accounts/lookup?userId=", "GET", "op"),
    );
    expect(empty?.status).toBe(400);
    const found = await callAccounts(
      ctx,
      jsonReq("/platform/accounts/lookup?userId=bob", "GET", "op"),
    );
    expect(found?.status).toBe(200);
  });

  it("onboarding save: a valid step saves; a malformed step is a coded 400 with the existing message", async () => {
    const ctx = accountCtx(accountPorts());
    const ok = await callAccounts(
      ctx,
      jsonReq("/platform/onboarding/state", "POST", "alice", { currentStep: 2 }),
    );
    expect(ok?.status).toBe(200);
    for (const bad of [{ currentStep: "2" }, { currentStep: 9 }, { currentStep: 2.5 }, {}, "x", []]) {
      const res = await callAccounts(
        ctx,
        jsonReq("/platform/onboarding/state", "POST", "alice", bad),
      );
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({
        code: REQUEST_INVALID_CODE,
        error: "currentStep must be an integer between 1 and 5.",
      });
    }
  });

  it("profile save: a valid save succeeds exactly as before", async () => {
    const ctx = accountCtx(accountPorts());
    const res = await callAccounts(
      ctx,
      jsonReq("/platform/accounts/profile", "POST", "alice", {
        displayName: "Ada",
        idempotencyKey: "key-5604-1",
      }),
    );
    expect(res?.status).toBe(200);
    expect(res?.body.code).toBe("SUCCESS_PROFILE_UPDATED");
    expect(res?.body.displayName).toBe("Ada");
  });

  it("profile save: a bad field is the coded 400 with the failing field", async () => {
    const ctx = accountCtx(accountPorts());
    const res = await callAccounts(
      ctx,
      jsonReq("/platform/accounts/profile", "POST", "alice", {
        displayName: 42,
        idempotencyKey: "key-5604-2",
      }),
    );
    expect(res?.status).toBe(400);
    expect(res?.body.code).toBe("FAILURE_PROFILE_VALIDATION");
    expect(res?.body.field).toBe("displayName");
  });

  it("profile save: a bad key still reports before a bad field (schema order)", async () => {
    const ctx = accountCtx(accountPorts());
    const res = await callAccounts(
      ctx,
      jsonReq("/platform/accounts/profile", "POST", "alice", {
        displayName: 42,
        idempotencyKey: 42,
      }),
    );
    expect(res?.status).toBe(400);
    expect(res?.body.field).toBe("idempotencyKey");
  });

  it("profile save: a non-object body is a coded 400, field `body` (was a 500)", async () => {
    const ctx = accountCtx(accountPorts());
    for (const bad of ["x", 42, [], null]) {
      const res = await callAccounts(
        ctx,
        jsonReq("/platform/accounts/profile", "POST", "alice", bad),
      );
      expect(res?.status).toBe(400);
      expect(res?.body.code).toBe("FAILURE_PROFILE_VALIDATION");
      expect(res?.body.field).toBe("body");
    }
  });

  it("profile save: an absent key with an invalid field now reports the field (enumerated; status and code unchanged)", async () => {
    const ctx = accountCtx(accountPorts());
    const res = await callAccounts(
      ctx,
      jsonReq("/platform/accounts/profile", "POST", "alice", { displayName: 42 }),
    );
    expect(res?.status).toBe(400);
    expect(res?.body.code).toBe("FAILURE_PROFILE_VALIDATION");
    expect(res?.body.field).toBe("displayName");
  });
});

// Tenants family ------------------------------------------------------------

function tenantCtx() {
  const commercial = new InMemoryCommercialAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  return {
    commercial,
    directory,
    operators: {
      listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }],
    },
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
  c.directory.seedTenant("tenant-a", ["alice"]);
  c.directory.seedTenant("tenant-b", []);
}

async function callTenants(
  c: ReturnType<typeof tenantCtx>,
  path: string,
  method: string,
  body?: unknown,
) {
  const res = await handlePlatformTenantRoutes(
    jsonReq(path, method, "op", body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    {
      env: { COMMERCIAL_STORE_OPERATORS: "" } as never,
      commercial: c.commercial as never,
      directory: c.directory as never,
      operators: c.operators as never,
    },
  );
  if (!res) return null;
  return { status: res.status, body: await jsonBody(res) };
}

describe("tenants family on the helper (#5604)", () => {
  it("create: a valid tenant is created; malformed ids are coded 400s with the existing message", async () => {
    const c = tenantCtx();
    await seedTenants(c);
    const created = await callTenants(c, "/platform-tenants", "POST", { tenantId: "tenant-c" });
    expect(created?.status).toBe(201);
    for (const bad of [{ tenantId: "bad id" }, {}, { tenantId: 42 }, "x", []]) {
      const res = await callTenants(c, "/platform-tenants", "POST", bad);
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({
        code: REQUEST_INVALID_CODE,
        error: "tenantId is required and must be a non-empty id without whitespace.",
      });
    }
    const reserved = await callTenants(c, "/platform-tenants", "POST", {
      tenantId: "login:alice",
    });
    expect(reserved?.status).toBe(400);
    expect(reserved?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "tenantId cannot use the reserved 'login:' personal-scope prefix.",
    });
  });

  it("settings: valid patches apply; malformed patches are coded 400s with the existing messages", async () => {
    const c = tenantCtx();
    await seedTenants(c);
    const ok = await callTenants(c, "/platform-tenants/tenant-a/settings", "PATCH", {
      adsEnabled: false,
    });
    expect(ok?.status).toBe(200);
    expect(ok?.body.tenant).toMatchObject({ tenantId: "tenant-a", adsEnabled: false });
    const cases: [unknown, string][] = [
      [{ adsEnabled: "yes" }, "adsEnabled must be a boolean."],
      [{ autoRefresh: { enabled: true, intervalS: 0 } }, "autoRefresh must be { enabled: boolean, intervalS: positive integer }."],
      [{ autoRefresh: { enabled: true, intervalS: "30" } }, "autoRefresh must be { enabled: boolean, intervalS: positive integer }."],
      [{ autoRefresh: { enabled: true } }, "autoRefresh must be { enabled: boolean, intervalS: positive integer }."],
      [{ providers: { dataProviderId: "", brokerId: "etrade" } }, "providers must be { dataProviderId: string, brokerId: string }."],
      [{ providers: { dataProviderId: 42, brokerId: "etrade" } }, "providers must be { dataProviderId: string, brokerId: string }."],
      [{}, "No settings field supplied."],
      ["x", "No settings field supplied."],
      [[], "No settings field supplied."],
    ];
    for (const [bad, message] of cases) {
      const res = await callTenants(c, "/platform-tenants/tenant-a/settings", "PATCH", bad);
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({ code: REQUEST_INVALID_CODE, error: message });
    }
    const applied = await callTenants(c, "/platform-tenants/tenant-a/settings", "PATCH", {
      autoRefresh: { enabled: true, intervalS: 30 },
      providers: { dataProviderId: "etrade", brokerId: "etrade" },
    });
    expect(applied?.status).toBe(200);
  });
});

// Channels family -----------------------------------------------------------

function channelCtx() {
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
  };
}

async function callChannels(
  c: ReturnType<typeof channelCtx>,
  path: string,
  method: string,
  body?: unknown,
) {
  const res = await handlePlatformChannelRoutes(
    jsonReq(path, method, "op", body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    { env: { COMMERCIAL_STORE_OPERATORS: "" }, ...c } as never,
  );
  if (!res) return null;
  return { status: res.status, body: await jsonBody(res) };
}

describe("channels family on the helper (#5604)", () => {
  it("patch: a valid patch applies; malformed patches are coded 400s with the existing messages", async () => {
    const c = channelCtx();
    const ok = await callChannels(c, "/platform-channels/tenant-a/channels", "PATCH", {
      channels: { slack: false },
    });
    expect(ok?.status).toBe(200);
    const cases: [unknown, string][] = [
      [{ channels: { slack: "no" } }, "Channel flag slack must be a boolean."],
      [{ channels: { smoke: true } }, "Unknown channel: smoke."],
      [{ channels: {} }, "No channel flag supplied."],
      [{}, "channels must be an object of channel flags."],
      [{ channels: "x" }, "channels must be an object of channel flags."],
      [{ channels: [] }, "channels must be an object of channel flags."],
      ["x", "channels must be an object of channel flags."],
    ];
    for (const [bad, message] of cases) {
      const res = await callChannels(c, "/platform-channels/tenant-a/channels", "PATCH", bad);
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({ code: REQUEST_INVALID_CODE, error: message });
    }
  });

  it("slack-channel write: a valid write still succeeds", async () => {
    const c = channelCtx();
    const res = await callChannels(c, "/platform-channels/tenant-a/slack-channel", "PUT", {
      slackChannel: "#general",
    });
    expect(res?.status).toBe(200);
    expect(res?.body.slackChannel).toBe("#general");
  });

  it("slack-channel write: a missing field and a scalar body are coded 400s; the normalizer still owns value rules", async () => {
    const c = channelCtx();
    for (const bad of [{}, "x", []]) {
      const res = await callChannels(c, "/platform-channels/tenant-a/slack-channel", "PUT", bad);
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({
        code: REQUEST_INVALID_CODE,
        error: "slackChannel is required (non-empty string or null).",
      });
    }
    const wrongType = await callChannels(c, "/platform-channels/tenant-a/slack-channel", "PUT", {
      slackChannel: 42,
    });
    expect(wrongType?.status).toBe(400);
    expect(wrongType?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "slackChannel must be a non-empty string or null.",
    });
  });

  it("webhook-url write: a missing field and a scalar body are coded 400s; the normalizer still owns value rules", async () => {
    const c = channelCtx();
    for (const bad of [{}, "x", []]) {
      const res = await callChannels(c, "/platform-channels/tenant-a/webhook-url", "PUT", bad);
      expect(res?.status).toBe(400);
      expect(res?.body).toEqual({
        code: REQUEST_INVALID_CODE,
        error: "webhookUrl is required (non-empty HTTPS/HTTP URL string or null).",
      });
    }
    const wrongType = await callChannels(c, "/platform-channels/tenant-a/webhook-url", "PUT", {
      webhookUrl: 42,
    });
    expect(wrongType?.status).toBe(400);
    expect(wrongType?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "webhookUrl must be a non-empty HTTPS/HTTP URL string or null.",
    });
  });
});

// Audit strict writes -------------------------------------------------------

function auditTestCtx() {
  const audited: { type: string; agent: string; payload: Record<string, unknown> }[] = [];
  const ctx = {
    ensureTables: () => {
      throw new Error("unused");
    },
    audit: (type: string, agent: string, payload: Record<string, unknown>) => {
      audited.push({ type, agent, payload });
    },
    recordAudit: (type: string, agent: string, payload: Record<string, unknown>) => ({
      id: "evt-1",
      type,
      agent,
      payload,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
    env: {},
  };
  return { ctx, audited };
}

async function callAudit(
  ctx: ReturnType<typeof auditTestCtx>["ctx"],
  path: string,
  rawBody: string,
) {
  const res = await handleAuditRoutes(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    }),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    ctx as never,
  );
  if (!res) return null;
  return { status: res.status, body: await jsonBody(res) };
}

describe("audit strict writes on the helper (#5604)", () => {
  it("POST /audit/event: a valid write is 201; malformed writes are coded 400s with the existing messages", async () => {
    const { ctx } = auditTestCtx();
    const ok = await callAudit(ctx, "/audit/event", JSON.stringify({ type: "ui.check", agent: "nlq", payload: { a: 1 } }));
    expect(ok?.status).toBe(201);
    const missingType = await callAudit(ctx, "/audit/event", JSON.stringify({ agent: "nlq" }));
    expect(missingType?.status).toBe(400);
    expect(missingType?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "type (non-empty string) is required",
    });
    const scalar = await callAudit(ctx, "/audit/event", JSON.stringify("x"));
    expect(scalar?.status).toBe(400);
    expect(scalar?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "A JSON object body is required",
    });
    const malformed = await callAudit(ctx, "/audit/event", "not-json{");
    expect(malformed?.status).toBe(400);
    expect(malformed?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "A JSON object body is required",
    });
  });

  it("POST /audit strict: a valid write keeps the 200 shape; a bad type is a coded 400; legacy stays unvalidated", async () => {
    const { ctx, audited } = auditTestCtx();
    const ok = await callAudit(
      ctx,
      "/audit",
      JSON.stringify({ mode: "strict", type: "t", payload: { a: 1 } }),
    );
    expect(ok?.status).toBe(200);
    expect(ok?.body).toEqual({ success: true, message: "Audit event recorded" });
    expect(audited[0]).toMatchObject({ type: "t", agent: "trading" });
    const bad = await callAudit(ctx, "/audit", JSON.stringify({ mode: "strict", type: "" }));
    expect(bad?.status).toBe(400);
    expect(bad?.body).toEqual({
      code: REQUEST_INVALID_CODE,
      error: "type (non-empty string) is required",
    });
    const legacy = await callAudit(ctx, "/audit", JSON.stringify({ type: "x".repeat(200) }));
    expect(legacy?.status).toBe(200);
  });
});
