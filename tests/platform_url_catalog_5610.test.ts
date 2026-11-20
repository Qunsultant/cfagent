// @vitest-environment node
/**
 * Issue #5610 (G-8) — platform URL catalog: the platform routes match
 * through ONE catalog (src/data/platformUrlCatalog.ts), never through
 * duplicated path literals.
 *
 * Pins:
 * - unique ids, 14 entries, 21 per-method operations (the inventory's
 *   "19 routes" counts the slack/webhook branches once each; the catalog
 *   expands them to per-method operations), canonical == /api + bare;
 * - the params builders fill templates (encoding once) and throw on a
 *   missing param; the template builders throw on parameterized entries;
 * - no hardcoded platform path literal survives outside the catalog
 *   module (comments stripped before scanning);
 * - the suffix-form set (accounts 7 ops + users 2 ops) equals the
 *   handlers' endsWith sets;
 * - every entry is referenced by its handler file;
 * - the handlers route catalog-built paths (accounts, tenants, channels).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PLATFORM_ROUTES,
  PLATFORM_ROUTE_INCLUDES,
  PLATFORM_ROUTE_SUFFIXES,
  PLATFORM_ROUTE_TAILS,
  platformBarePath,
  platformBarePathParams,
  platformPath,
  platformPathParams,
  platformRouteById,
  segmentsAfterMarker,
} from "../src/data/platformUrlCatalog";
import { extractCatalogParams, matchCatalogRoute } from "../src/data/commercialUrlCatalog";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountPorts,
  type PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import { handlePlatformTenantRoutes } from "../src/agents/routes/platformTenants";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryProfileAdapter } from "../src/data/inMemoryProfileAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Strip comments (string-aware); the no-literal pin scans code only. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe("platform url catalog (#5610)", () => {
  it("has unique ids, 14 entries, 21 operations, canonical == /api + bare", () => {
    const ids = PLATFORM_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PLATFORM_ROUTES.length).toBe(14);
    const ops = PLATFORM_ROUTES.reduce((n, r) => n + r.methods.length, 0);
    expect(ops).toBe(21);
    for (const r of PLATFORM_ROUTES) {
      expect(r.methods.length).toBeGreaterThan(0);
      for (const m of r.methods) expect(["GET", "POST", "PATCH", "PUT"]).toContain(m);
      expect(PLATFORM_ROUTE_SUFFIXES[r.id]).toBe(r.matchSuffix);
      if (r.params?.length) {
        // Parameterized (#5610): the template builders throw — a `:param`
        // template is not a URL; the params builders fill it.
        expect(() => platformPath(r.id)).toThrow(/parameterized/);
        expect(() => platformBarePath(r.id)).toThrow(/parameterized/);
        expect(r.matchSuffix).toBe("");
        expect(r.matchIncludes?.length).toBeGreaterThan(0);
        expect(PLATFORM_ROUTE_INCLUDES[r.id]).toEqual(r.matchIncludes);
        for (const p of r.params) {
          expect(r.bare, `${r.id} param ${p.name}`).toContain(`:${p.name}`);
          expect(p.after.length).toBeGreaterThan(0);
        }
      } else {
        expect(platformPath(r.id)).toBe(`/api${r.bare}`);
        expect(platformBarePath(r.id)).toBe(r.bare);
        expect(r.matchSuffix.length).toBeGreaterThan(0);
      }
      if (r.segmentTail) {
        expect(PLATFORM_ROUTE_TAILS[r.id]).toBe(r.segmentTail);
      }
    }
    // Merged entries keep per-method operations: the collection suffix
    // serves list (GET) + create (POST); slack/webhook serve GET + PUT + PATCH.
    expect(platformRouteById("tenants").methods).toEqual(["GET", "POST"]);
    expect(platformRouteById("channelSlackChannel").methods).toEqual(["GET", "PUT", "PATCH"]);
    expect(platformRouteById("channelWebhookUrl").methods).toEqual(["GET", "PUT", "PATCH"]);
  });

  it("the params builders fill templates, encode once, throw on a missing param", () => {
    expect(platformPathParams("tenantDetail", { tenantId: "acme" })).toBe("/api/platform-tenants/acme");
    expect(platformBarePathParams("tenantSettings", { tenantId: "acme" })).toBe(
      "/platform-tenants/acme/settings",
    );
    expect(platformPathParams("channelSlackChannel", { tenantId: "a b/c" })).toBe(
      "/api/platform-channels/a%20b%2Fc/slack-channel",
    );
    expect(() => platformPathParams("tenantDetail", {})).toThrow(/Missing path param tenantId/);
    expect(() => platformPathParams("nope", {})).toThrow(/Unknown platform route id/);
    expect(() => platformBarePath("channelRead")).toThrow(/parameterized/);
  });

  it("no hardcoded platform path literal survives outside the catalog module", () => {
    const needles = [
      "/platform/accounts",
      "/platform/onboarding",
      "/platform-tenants",
      "/platform-channels",
      "/admin/platform-users",
    ];
    const offenders: string[] = [];
    for (const file of walkTs(join(ROOT, "src"))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === "src/data/platformUrlCatalog.ts") continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const needle of needles) {
        if (code.includes(needle)) offenders.push(`${rel}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the suffix-form (method, suffix) set equals the handlers' endsWith sets", () => {
    // Accounts (7 ops) + users (2 ops) match by suffix with the method
    // literal on the same line; tenants/channels dispatch on segments and
    // are covered by the reference pin + routing tests below.
    const suffixEntries = PLATFORM_ROUTES.filter((r) => r.matchSuffix.length > 0);
    const fromCatalog = new Set<string>();
    for (const r of suffixEntries) {
      for (const method of r.methods) fromCatalog.add(`${method} ${r.matchSuffix}`);
    }
    const fromHandlers = new Set<string>();
    for (const rel of [
      "src/agents/routes/platformAccounts.ts",
      "src/agents/routes/platformTenants.ts",
      "src/agents/routes/platformUsers.ts",
    ]) {
      for (const line of readSrc(rel).split("\n")) {
        const m = line.match(/path\.endsWith\(PLATFORM_ROUTE_SUFFIXES\.([A-Za-z]+)\)/);
        if (!m) continue;
        const suffix = PLATFORM_ROUTE_SUFFIXES[m[1]];
        expect(suffix, `unknown catalog id on endsWith line: ${line.trim()}`).toBeTruthy();
        const methods = [...line.matchAll(/request\.method === "(GET|POST|PATCH|PUT)"/g)].map((x) => x[1]);
        if (methods.length === 0) {
          // Only the users file and the tenants collection dispatch on
          // suffix alone and answer 405 inside the branch — their
          // entries' catalog methods are the set, and the 405s are
          // pinned by the users route tests + the tenants routing test.
          expect(
            ["src/agents/routes/platformUsers.ts", "src/agents/routes/platformTenants.ts"],
            `no method on endsWith line: ${line.trim()}`,
          ).toContain(rel);
          const entry = PLATFORM_ROUTES.find((r) => r.id === m[1]);
          for (const method of entry!.methods) fromHandlers.add(`${method} ${suffix}`);
          continue;
        }
        for (const method of methods) fromHandlers.add(`${method} ${suffix}`);
      }
    }
    expect([...fromCatalog].sort()).toEqual([...fromHandlers].sort());
  });

  it("every entry is referenced by its handler file", () => {
    const handlerFor = (id: string): string => {
      if (id.startsWith("account") || id === "onboardingState") return "src/agents/routes/platformAccounts.ts";
      if (id.startsWith("tenant") || id === "tenants") return "src/agents/routes/platformTenants.ts";
      if (id.startsWith("channel")) return "src/agents/routes/platformChannels.ts";
      return "src/agents/routes/platformUsers.ts";
    };
    for (const r of PLATFORM_ROUTES) {
      const src = readSrc(handlerFor(r.id));
      const referenced =
        src.includes(`PLATFORM_ROUTE_SUFFIXES.${r.id}`) ||
        src.includes(`platformRouteById("${r.id}")`) ||
        src.includes(`PLATFORM_ROUTE_TAILS.${r.id}`) ||
        src.includes(`PLATFORM_ROUTE_INCLUDES.${r.id}`);
      expect(referenced, `${r.id} is not referenced by ${handlerFor(r.id)}`).toBe(true);
    }
  });

  it("segmentsAfterMarker splits on the route's own marker, returning raw segments", () => {
    const settings = platformRouteById("tenantSettings");
    expect(segmentsAfterMarker("/api/platform-tenants/acme/settings", settings)).toEqual([
      "acme",
      "settings",
    ]);
    expect(segmentsAfterMarker("/platform-tenants/acme", platformRouteById("tenantDetail"))).toEqual([
      "acme",
    ]);
    // The helper returns RAW segments — decoding is the branch's job
    // (strict decodeURIComponent without try/catch, preserved exactly).
    // A percent-encoded id stays encoded here; a malformed one throws
    // only when the branch decodes it.
    expect(segmentsAfterMarker("/platform-tenants/a%20b/settings", settings)).toEqual([
      "a%20b",
      "settings",
    ]);
    expect(segmentsAfterMarker("/platform-tenants/%E0%A4%A/settings", settings)).toEqual([
      "%E0%A4%A",
      "settings",
    ]);
    expect(() => decodeURIComponent("%E0%A4%A")).toThrow(URIError);
  });

  it("the parameterized platform routes match their real paths and extract params", () => {
    const cases: Array<{ id: string; path: string; params: Record<string, string> }> = [
      { id: "tenantDetail", path: "/api/platform-tenants/acme", params: { tenantId: "acme" } },
      {
        id: "tenantSettings",
        path: "/api/platform-tenants/acme/settings",
        params: { tenantId: "acme" },
      },
      { id: "channelRead", path: "/api/platform-channels/tenant-a", params: { tenantId: "tenant-a" } },
      {
        id: "channelPatch",
        path: "/api/platform-channels/tenant-a/channels",
        params: { tenantId: "tenant-a" },
      },
      {
        id: "channelSlackChannel",
        path: "/api/platform-channels/tenant-a/slack-channel",
        params: { tenantId: "tenant-a" },
      },
      {
        id: "channelWebhookUrl",
        path: "/api/platform-channels/tenant-a/webhook-url",
        params: { tenantId: "tenant-a" },
      },
    ];
    for (const c of cases) {
      const route = platformRouteById(c.id);
      expect(matchCatalogRoute(route, c.path)).toBe(true);
      expect(extractCatalogParams(route, c.path)).toEqual(c.params);
      expect(platformPathParams(c.id, c.params)).toBe(c.path);
    }
    // Includes-only matching is a FAMILY gate, not a route gate: the
    // read path matches the patch entry's includes, and the settings
    // path matches the detail entry's includes. The disambiguation
    // lives in the segment dispatch — one segment after the tenant
    // id is a read, two segments with the tail are the tailed route.
    expect(
      matchCatalogRoute(platformRouteById("channelPatch"), "/api/platform-channels/tenant-a"),
    ).toBe(true);
    expect(
      segmentsAfterMarker(
        "/api/platform-channels/tenant-a",
        platformRouteById("channelPatch"),
      ),
    ).toEqual(["tenant-a"]);
    expect(
      segmentsAfterMarker(
        "/api/platform-channels/tenant-a/channels",
        platformRouteById("channelPatch"),
      ),
    ).toEqual(["tenant-a", "channels"]);
    expect(
      matchCatalogRoute(platformRouteById("tenantDetail"), "/api/platform-tenants/acme/settings"),
    ).toBe(true);
    expect(
      segmentsAfterMarker(
        "/api/platform-tenants/acme/settings",
        platformRouteById("tenantDetail"),
      ),
    ).toEqual(["acme", "settings"]);
    // True negatives are cross-family paths.
    expect(
      matchCatalogRoute(platformRouteById("channelPatch"), "/api/platform-tenants/acme"),
    ).toBe(false);
    expect(
      matchCatalogRoute(platformRouteById("tenantDetail"), "/api/platform-channels/tenant-a"),
    ).toBe(false);
  });
});

/** --- Routing: the handlers answer catalog-built paths. --- */

function accountPorts(): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
    profile: new InMemoryProfileAdapter(),
  };
}

function accountCtx(ports: PlatformAccountPorts, env: Record<string, unknown> = {}): PlatformAccountRouteContext {
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

describe("platform accounts routes route catalog-built paths (#5610)", () => {
  it("self read: 401 without a login, 200 with one, no account invented", async () => {
    const ctx = accountCtx(accountPorts());
    expect((await callAccounts(ctx, accountReq("GET", platformPath("accountSelf"))))?.status).toBe(401);
    const res = await callAccounts(ctx, accountReq("GET", platformPath("accountSelf"), "alice"));
    expect(res?.status).toBe(200);
    expect((res?.body.identity as Record<string, unknown>).hasAccount).toBe(false);
  });

  it("setup: POST the catalog path, created is a boolean", async () => {
    const ctx = accountCtx(accountPorts());
    const res = await callAccounts(ctx, accountReq("POST", platformPath("accountSetup"), "alice", {}));
    expect(res?.status).toBe(200);
    expect(typeof res?.body.created).toBe("boolean");
  });

  it("lookup: operator-gated on the catalog path", async () => {
    const ctx = accountCtx(accountPorts(), { COMMERCIAL_STORE_OPERATORS: "op-env" });
    const res = await callAccounts(
      ctx,
      accountReq("GET", `${platformPath("accountLookup")}?userId=ghost`, "op-env"),
    );
    expect(res?.status).toBe(200);
    expect((res?.body.identity as Record<string, unknown>).hasAccount).toBe(false);
  });

  it("onboarding state: GET null, POST saves, GET rereads", async () => {
    const ctx = accountCtx(accountPorts());
    const empty = await callAccounts(ctx, accountReq("GET", platformPath("onboardingState"), "onb-a"));
    expect(empty?.status).toBe(200);
    expect(empty?.body.state).toBeNull();
    const saved = await callAccounts(
      ctx,
      accountReq("POST", platformPath("onboardingState"), "onb-a", { currentStep: 3 }),
    );
    expect(saved?.status).toBe(200);
    const reread = await callAccounts(ctx, accountReq("GET", platformPath("onboardingState"), "onb-a"));
    expect((reread?.body.state as Record<string, unknown>).currentStep).toBe(3);
  });

  it("profile: GET then POST then GET round-trips the display name", async () => {
    const ctx = accountCtx(accountPorts());
    const first = await callAccounts(ctx, accountReq("GET", platformPath("accountProfile"), "alice"));
    expect(first?.status).toBe(200);
    // The profile fields spread at the top level of the coded body.
    expect("code" in (first?.body ?? {})).toBe(true);
    const saved = await callAccounts(
      ctx,
      accountReq("POST", platformPath("accountProfile"), "alice", {
        idempotencyKey: "catalog-test-1",
        displayName: "Al",
      }),
    );
    expect(saved?.status).toBe(200);
    const reread = await callAccounts(ctx, accountReq("GET", platformPath("accountProfile"), "alice"));
    expect(reread?.body.displayName).toBe("Al");
  });

  it("an unknown platform path returns null", async () => {
    const ctx = accountCtx(accountPorts());
    expect(await callAccounts(ctx, accountReq("GET", "/platform/accounts/nope", "alice"))).toBeNull();
  });
});

const OPERATOR = "op";

function tenantWorld() {
  const commercial = new InMemoryCommercialAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("acme", [OPERATOR]);
  const operators = {
    listOperators: async () => [{ login: OPERATOR, addedBy: "seed", addedAtMs: 1 }],
  };
  return { commercial, directory, operators };
}

async function callTenants(
  w: ReturnType<typeof tenantWorld>,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ res: Response | null; body: Record<string, unknown> }> {
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: {
      "x-user-login": OPERATOR,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handlePlatformTenantRoutes(req, new URL(`https://worker.test${path}`), path, "session-1", {
    env: { COMMERCIAL_STORE_OPERATORS: "" },
    audit: vi.fn(),
    commercial: w.commercial,
    directory: w.directory,
    operators: w.operators,
  } as never);
  return { res, body: (await res?.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("platform tenants routes route catalog-built paths (#5610)", () => {
  it("list + create on the collection suffix, detail + settings on catalog params", async () => {
    const w = tenantWorld();
    const list = await callTenants(w, platformPath("tenants"), "GET");
    expect(list.res?.status).toBe(200);
    expect((list.body.tenants as Array<Record<string, unknown>>).map((t) => t.tenantId)).toContain("acme");
    const created = await callTenants(w, platformPath("tenants"), "POST", { tenantId: "newco" });
    expect(created.res?.status).toBe(201);
    const detail = await callTenants(
      w,
      platformPathParams("tenantDetail", { tenantId: "acme" }),
      "GET",
    );
    expect(detail.res?.status).toBe(200);
    expect(((detail.body.tenant ?? {}) as Record<string, unknown>).tenantId).toBe("acme");
    const settings = await callTenants(
      w,
      platformPathParams("tenantSettings", { tenantId: "acme" }),
      "PATCH",
      { adsEnabled: false },
    );
    expect(settings.res?.status).toBe(200);
  });

  it("a non-GET on the detail path answers 405; an unknown path returns null", async () => {
    const w = tenantWorld();
    const wrong = await callTenants(
      w,
      platformPathParams("tenantDetail", { tenantId: "acme" }),
      "POST",
      {},
    );
    expect(wrong.res?.status).toBe(405);
    const unknown = await callTenants(w, "/platform/other", "GET");
    expect(unknown.res).toBeNull();
  });
});

function channelWorld() {
  const channels = new InMemoryTenantChannelAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("tenant-a", ["alice"]);
  const audit = vi.fn();
  const auditStore = createMemoryAuditStore();
  const operators = {
    listOperators: async () => [{ login: OPERATOR, addedBy: "seed", addedAtMs: 1 }],
  };
  return { channels, directory, audit, auditStore, operators };
}

async function callChannels(
  w: ReturnType<typeof channelWorld>,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ res: Response | null; body: Record<string, unknown> }> {
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: {
      "x-user-login": OPERATOR,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handlePlatformChannelRoutes(req, new URL(`https://worker.test${path}`), path, "session-1", {
    env: { COMMERCIAL_STORE_OPERATORS: "" },
    audit: w.audit,
    auditStore: w.auditStore,
    channels: w.channels,
    directory: w.directory,
    operators: w.operators,
  } as never);
  return { res, body: (await res?.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("platform channels routes route catalog-built paths (#5610)", () => {
  it("read, patch, slack-channel and webhook-url answer their catalog paths", async () => {
    const w = channelWorld();
    const read = await callChannels(
      w,
      platformPathParams("channelRead", { tenantId: "tenant-a" }),
      "GET",
    );
    expect(read.res?.status).toBe(200);
    const patch = await callChannels(
      w,
      platformPathParams("channelPatch", { tenantId: "tenant-a" }),
      "PATCH",
      { channels: { slack: false } },
    );
    expect(patch.res?.status).toBe(200);
    const slackGet = await callChannels(
      w,
      platformPathParams("channelSlackChannel", { tenantId: "tenant-a" }),
      "GET",
    );
    expect(slackGet.res?.status).toBe(200);
    const slackPut = await callChannels(
      w,
      platformPathParams("channelSlackChannel", { tenantId: "tenant-a" }),
      "PUT",
      { slackChannel: "#general" },
    );
    expect(slackPut.res?.status).toBe(200);
    expect(slackPut.body.slackChannel).toBe("#general");
    const hookGet = await callChannels(
      w,
      platformPathParams("channelWebhookUrl", { tenantId: "tenant-a" }),
      "GET",
    );
    expect(hookGet.res?.status).toBe(200);
    const hookPut = await callChannels(
      w,
      platformPathParams("channelWebhookUrl", { tenantId: "tenant-a" }),
      "PUT",
      { webhookUrl: "https://example.test/hook" },
    );
    expect(hookPut.res?.status).toBe(200);
    expect(hookPut.body.webhookUrl).toBe("https://example.test/hook");
  });

  it("a POST on the read path answers 405; an unknown path returns null", async () => {
    const w = channelWorld();
    const wrong = await callChannels(
      w,
      platformPathParams("channelRead", { tenantId: "tenant-a" }),
      "POST",
      {},
    );
    expect(wrong.res?.status).toBe(405);
    const unknown = await callChannels(w, "/platform-channels", "GET");
    expect(unknown.res).toBeNull();
  });
});
