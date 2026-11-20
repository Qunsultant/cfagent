import { describe, it, expect } from "vitest";
import { buildOpenApiSpec, STOCK_SPEC_PATHS } from "../src/security/openapiSpec";
import { API_ENDPOINT_CATALOG } from "../src/client/iaaaEndpointCatalog";
import { COMMERCIAL_ROUTES } from "../src/data/commercialUrlCatalog";
import { PLATFORM_ROUTES } from "../src/data/platformUrlCatalog";

/**
 * #1024 Phase 1 — OpenAPI + Swagger spike (no framework change).
 * The spec is generated from the IAAA-UI API catalog, not hand-written
 * per route. Hand-written schemas exist for the pilot set and, since
 * #2860 Factor 13, for the stock set; every other path carries an
 * explicit not-yet-specified marker — never an invented schema.
 */
const NOT_SPECIFIED = "schema: not yet specified (spike pilot coverage)";

const HTTP_METHODS = ["get", "post", "delete"] as const;

/** The spec path for a catalog bare path: `/api` + `:param` as `{param}`. */
const specPathFor = (bare: string): string => `/api${bare.replace(/:([A-Za-z]+)/g, "{$1}")}`;

/** Every CBO spec path (#5610), with its catalog entry's methods. */
function cboExpectedPaths(): Map<string, { catalog: string; methods: string[] }> {
  const expected = new Map<string, { catalog: string; methods: string[] }>();
  for (const r of COMMERCIAL_ROUTES) {
    expected.set(specPathFor(r.bare), {
      catalog: "commercial",
      methods: r.methods.map((m) => m.toLowerCase()),
    });
  }
  for (const r of PLATFORM_ROUTES) {
    expected.set(specPathFor(r.bare), {
      catalog: "platform",
      methods: r.methods.map((m) => m.toLowerCase()),
    });
  }
  return expected;
}

function operationKeys(pathItem: Record<string, unknown>): string[] {
  return Object.keys(pathItem).filter((k) => (HTTP_METHODS as readonly string[]).includes(k));
}

describe("OpenAPI spec document", () => {
  it("is a valid OpenAPI 3.x document with the worker identity", () => {
    const spec = buildOpenApiSpec();
    const roundTripped = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
    expect(typeof roundTripped.openapi).toBe("string");
    expect((roundTripped.openapi as string).startsWith("3.")).toBe(true);
    const info = roundTripped.info as Record<string, unknown>;
    expect(info.title).toBe("ai-search-agent");
    expect(info.version).toBe("1.0.0");
    const servers = roundTripped.servers as Array<Record<string, unknown>>;
    expect(servers[0].url).toBe("https://agent.openaimp.com");
  });

  it("covers every catalog HTTP endpoint path and alias, with its methods", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    for (const entry of API_ENDPOINT_CATALOG) {
      if (entry.kind !== "http") continue;
      // Issue #5610: the payments-agentic wildcard is gone — its
      // per-route items (generated from the schemas registry) replace
      // it. The premium wildcard stays (out of scope).
      if (entry.id === "payments-agentic") continue;
      for (const p of [entry.path, ...entry.aliases]) {
        expect(paths[p], `missing path item for ${p}`).toBeDefined();
        const ops = operationKeys(paths[p]);
        // Each operation keeps its own entry's gating note (paths shared
        // by two entries, e.g. GET + POST /api/schedule/goals, merge).
        const expected =
          entry.method === "GET|POST"
            ? ["get", "post"]
            : entry.method === "ANY"
              ? []
              : [entry.method.toLowerCase()];
        for (const m of expected) {
          expect(ops, `${p} missing ${m}`).toContain(m);
          expect(paths[p][m].description as string).toContain(entry.authNote.slice(0, 24));
        }
      }
    }
  });

  it("excludes the catch-all forwarder and static pre-route from paths", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, unknown>;
    for (const entry of API_ENDPOINT_CATALOG) {
      if (entry.kind === "catchall" || entry.kind === "static") {
        expect(paths[entry.path]).toBeUndefined();
      }
    }
  });

  it("lists WebSocket routes as transport-marked items with no invented operation", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    for (const entry of API_ENDPOINT_CATALOG) {
      if (entry.kind !== "websocket") continue;
      for (const p of [entry.path, ...entry.aliases]) {
        expect(paths[p]).toBeDefined();
        expect(paths[p]["x-transport"]).toBe("websocket");
        expect(operationKeys(paths[p])).toEqual([]);
      }
    }
  });

  it("carries hand-written schemas for the pilot set only", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const me = paths["/api/me"].get;
    expect(me.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/MeResponse",
    );
    for (const p of ["/health", "/api/health"]) {
      expect(paths[p].get.responses["200"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/HealthResponse",
      );
    }
    const overview = paths["/api/iaaa/overview"].get;
    expect(overview.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/IaaaOverviewResponse",
    );
    expect(overview.responses["401"]).toBeDefined();
    expect(overview.responses["403"]).toBeDefined();
    expect(overview.responses["405"]).toBeDefined();

    const components = spec.components as Record<string, Record<string, any>>;
    const meSchema = components.schemas.MeResponse;
    expect(meSchema.required).toEqual(["authenticated"]);
    for (const prop of ["login", "name", "avatar", "internalUserId"]) {
      expect(meSchema.properties[prop]).toBeDefined();
    }
    const healthSchema = components.schemas.HealthResponse;
    expect(healthSchema.required).toContain("status");
    expect(healthSchema.properties.telemetry).toBeDefined();
    const overviewSchema = components.schemas.IaaaOverviewResponse;
    for (const prop of ["tenantId", "callerInternalUserId", "memberships", "genesis", "recentAuditEvents"]) {
      expect(overviewSchema.properties[prop]).toBeDefined();
    }
    const membership = components.schemas.Membership;
    expect(membership.properties.roleBindings).toBeDefined();
    const auditView = components.schemas.AdminAuditEventView;
    expect(auditView.required).toContain("action");
  });

  it("marks every non-pilot, non-stock, non-CBO path as not yet specified, and no pilot, stock, or CBO path as such", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const pilot = new Set(["/api/me", "/health", "/api/health", "/api/iaaa/overview"]);
    const spikeMeta = new Set(["/openapi.json", "/api/docs"]);
    const cbo = new Set(cboExpectedPaths().keys());
    for (const [p, item] of Object.entries(paths)) {
      const text = (item.description as string) || "";
      if (pilot.has(p) || spikeMeta.has(p) || STOCK_SPEC_PATHS.has(p) || cbo.has(p)) {
        expect(text).not.toContain(NOT_SPECIFIED);
      } else {
        expect(text, `missing marker on ${p}`).toContain(NOT_SPECIFIED);
      }
    }
    // A concrete non-pilot endpoint keeps its gating note alongside the marker.
    expect(paths["/api/api-keys"].get.description).toContain(NOT_SPECIFIED);
  });

  it("documents the spike routes themselves, session-gated", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    for (const p of ["/openapi.json", "/api/docs"]) {
      expect(paths[p].get).toBeDefined();
      expect(paths[p].get.description).toContain("authenticated session");
      expect(paths[p].get.responses["401"]).toBeDefined();
    }
    expect(paths["/openapi.json"].get.responses["200"].content["application/json"]).toBeDefined();
    expect(paths["/api/docs"].get.responses["200"].content["text/html"]).toBeDefined();
  });

  it("carries hand-written schemas for the stock set (#2860 Factor 13)", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const components = spec.components as Record<string, Record<string, any>>;
    const schemas = components.schemas as Record<string, any>;
    // Every stock path is present, carries no not-yet-specified marker,
    // and every $ref its operations use resolves to a component schema.
    const refs = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const v of node) collect(v);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "$ref" && typeof v === "string") refs.add(v);
          else collect(v);
        }
      }
    };
    const expectedOps: Record<string, string[]> = {
      "/api/market-data/screen": ["get", "post"],
      "/api/reports": ["get"],
      "/api/reports/{id}": ["get"],
      "/api/reports/replay": ["post"],
      "/api/screener/presets": ["get", "post"],
      "/api/screener/presets/{id}": ["delete"],
      "/api/screener/report.pdf": ["get"],
      "/api/screener/report.xlsx": ["get"],
      "/api/screener/report.csv": ["get"],
      "/api/screener/report/regenerate": ["post"],
    };
    expect([...STOCK_SPEC_PATHS].sort()).toEqual(Object.keys(expectedOps).sort());
    for (const [p, methods] of Object.entries(expectedOps)) {
      const item = paths[p];
      expect(item, `missing stock path ${p}`).toBeDefined();
      expect(item.description as string).not.toContain(NOT_SPECIFIED);
      for (const m of methods) {
        const op = item[m];
        expect(op, `${p} missing ${m}`).toBeDefined();
        expect(JSON.stringify(op)).not.toContain(NOT_SPECIFIED);
        expect(op.responses["200"] ?? op.responses["201"] ?? op.responses["202"]).toBeDefined();
        collect(op);
      }
    }
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(schemas[name], `unresolved $ref ${ref}`).toBeDefined();
    }
    // Spot-checks against the handlers the schemas were read from.
    const screen = paths["/api/market-data/screen"];
    expect(screen.post.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/StockScreenRequest",
    );
    expect(screen.post.responses["202"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/WorkflowAcceptedResponse",
    );
    expect(screen.post.responses["429"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/AlreadyRunningResponse",
    );
    const replay = paths["/api/reports/replay"].post;
    expect(replay.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ReplayRequest",
    );
    expect(replay.responses["404"]).toBeDefined();
    expect(replay.responses["422"]).toBeDefined();
    expect(schemas.StockReplayEnvelope.required).toContain("originalRunId");
    expect(schemas.StockReplayEnvelope.properties.charged.example).toBe(false);
    expect(schemas.StockReplayEnvelope.properties.liveFetch.example).toBe(false);
    expect(schemas.ResearchReplayEnvelope.required).toContain("body");
    const presets = paths["/api/screener/presets"];
    expect(presets.post.responses["201"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/PresetCreateResponse",
    );
    expect(schemas.ScreenerPreset.properties.assetClass.enum).toEqual(["stocks", "options"]);
    expect(schemas.ScreenerPreset.properties.name.maxLength).toBe(100);
    for (const p of ["/api/screener/report.pdf", "/api/screener/report.xlsx", "/api/screener/report.csv"]) {
      expect(paths[p].get.responses["200"].content).toBeDefined();
      expect(paths[p].get.responses["404"]).toBeDefined();
    }
    expect(paths["/api/screener/report/regenerate"].post.responses["502"]).toBeDefined();
    // The stock set does not leak into the catalog-driven marker rule:
    // the projection read and the operator seed stay not-yet-specified.
    expect(paths["/api/reports/list"].get.description).toContain(NOT_SPECIFIED);
    expect(paths["/api/reports/seed-canonical"].post.description).toContain(NOT_SPECIFIED);
  });
});

describe("OpenAPI CBO set (#5610 G-8)", () => {
  const CBO_METHODS = ["get", "post", "patch", "put"] as const;

  function cboOperationKeys(pathItem: Record<string, unknown>): string[] {
    return Object.keys(pathItem).filter((k) => (CBO_METHODS as readonly string[]).includes(k));
  }

  it("covers every catalog operation: 120 operations on 96 paths", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const expected = cboExpectedPaths();
    expect(expected.size).toBe(96);
    const ops = [...expected.values()].reduce((n, e) => n + e.methods.length, 0);
    expect(ops).toBe(120);
    for (const [p, { methods }] of expected) {
      const item = paths[p];
      expect(item, `missing CBO path ${p}`).toBeDefined();
      expect(cboOperationKeys(item).sort()).toEqual([...methods].sort());
    }
  });

  it("every spec CBO path maps to a catalog entry (drift check)", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const expected = cboExpectedPaths();
    const prefixes = [
      "/api/payments/agentic/commercial",
      "/api/platform-tenants",
      "/api/platform-channels",
      "/api/platform/accounts",
      "/api/platform/onboarding",
      "/api/admin/platform-users",
    ];
    const specCbo = Object.keys(paths).filter((p) => prefixes.some((prefix) => p.startsWith(prefix)));
    expect(specCbo.sort()).toEqual([...expected.keys()].sort());
  });

  it("carries no payments-agentic wildcard; the premium wildcard stays", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths["/api/payments/agentic/*"]).toBeUndefined();
    expect(paths["/api/premium/*"]).toBeDefined();
  });

  it("carries no not-yet-specified marker on CBO paths or operations", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    for (const p of cboExpectedPaths().keys()) {
      const item = paths[p];
      expect((item.description as string) || "").not.toContain(NOT_SPECIFIED);
      expect(JSON.stringify(item)).not.toContain(NOT_SPECIFIED);
    }
  });

  it("every operation carries its request/response shapes plus the coded errors", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    for (const [p, { methods }] of cboExpectedPaths()) {
      for (const m of methods) {
        const op = paths[p][m];
        expect(op, `${p} missing ${m}`).toBeDefined();
        expect(op.description as string).toContain("issue #5610");
        if (m === "get") {
          expect(op.requestBody, `${p} ${m} carries a requestBody`).toBeUndefined();
        } else {
          const body = op.requestBody;
          expect(body, `${p} ${m} missing requestBody`).toBeDefined();
          expect(body.content["application/json"].schema).toBeDefined();
        }
        const success = op.responses["201"] ?? op.responses["200"];
        expect(success, `${p} ${m} missing a success response`).toBeDefined();
        expect(success.content["application/json"].schema).toBeDefined();
        for (const code of ["400", "401", "403", "404", "405"]) {
          const err = op.responses[code];
          expect(err, `${p} ${m} missing ${code}`).toBeDefined();
          expect(err.content["application/json"].schema.$ref).toBe(
            "#/components/schemas/ErrorResponse",
          );
        }
      }
    }
  });

  it("declares path parameters for parameterized routes", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const cases: Array<{ path: string; params: string[] }> = [
      { path: "/api/payments/agentic/commercial/subscriptions/{subscriptionId}/move", params: ["subscriptionId"] },
      { path: "/api/payments/agentic/commercial/products/{productId}/versions/{versionId}/approve", params: ["productId", "versionId"] },
      { path: "/api/payments/agentic/commercial/products/{productId}/bulk-moves/{bulkMoveId}", params: ["productId", "bulkMoveId"] },
      { path: "/api/platform-tenants/{tenantId}", params: ["tenantId"] },
      { path: "/api/platform-tenants/{tenantId}/settings", params: ["tenantId"] },
      { path: "/api/platform-channels/{tenantId}/slack-channel", params: ["tenantId"] },
    ];
    for (const c of cases) {
      const item = paths[c.path];
      expect(item, `missing parameterized path ${c.path}`).toBeDefined();
      for (const m of cboOperationKeys(item)) {
        const params = (item[m].parameters ?? []) as Array<Record<string, unknown>>;
        for (const name of c.params) {
          const param = params.find((x) => x.name === name && x.in === "path");
          expect(param, `${c.path} ${m} missing path param ${name}`).toBeDefined();
          expect(param!.required).toBe(true);
        }
      }
    }
  });

  it("non-session operations carry no session security; session operations do", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const webhook = paths["/api/payments/agentic/commercial/billing/webhook"].post;
    expect(webhook.security).toBeUndefined();
    expect(webhook.description as string).toContain("Stripe-signature gated");
    const unsubscribe = paths["/api/payments/agentic/commercial/lifecycle/unsubscribe"].post;
    expect(unsubscribe.security).toBeUndefined();
    expect(unsubscribe.description as string).toContain("Token gated");
    const self = paths["/api/platform/accounts/self"].get;
    expect(self.security).toEqual([{ sessionCookie: [] }]);
  });

  it("only tenant create and channel checkout answer 201", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const with201: string[] = [];
    for (const [p, { methods }] of cboExpectedPaths()) {
      for (const m of methods) {
        if (paths[p][m].responses["201"]) with201.push(`${p} ${m}`);
      }
    }
    expect(with201.sort()).toEqual([
      "/api/payments/agentic/commercial/channel/checkout post",
      "/api/platform-tenants post",
    ]);
  });

  it("every $ref in CBO operations resolves to a component schema", () => {
    const spec = buildOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, any>>;
    const components = spec.components as Record<string, Record<string, any>>;
    const schemas = components.schemas as Record<string, unknown>;
    const refs = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const v of node) collect(v);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "$ref" && typeof v === "string") refs.add(v);
          else collect(v);
        }
      }
    };
    for (const p of cboExpectedPaths().keys()) collect(paths[p]);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(schemas[name], `unresolved $ref ${ref}`).toBeDefined();
    }
    expect(schemas.ErrorResponse).toBeDefined();
  });
});
