// @vitest-environment node
/**
 * Issue #5610 (G-8) — shared request/response schemas registry
 * (`src/api/commercialSchemas.ts`).
 *
 * Pins:
 * - completeness: every (catalog entry x method) operation in both
 *   catalogs has request + response schemas (120 operations); the
 *   registry carries nothing outside the catalogs;
 * - shape: every schema converts to a JSON Schema with no `$schema` key
 *   and no `additionalProperties: false` anywhere; every schema is an
 *   object except the documented exceptions (the raw-body webhook, the
 *   raw policy record, the two union shapes);
 * - reuse: the platform entries reference the #5604 shape schemas, not
 *   redefinitions;
 * - acceptance: `validateRequestShape` accepts/rejects representative
 *   request shapes through the registry schemas;
 * - success statuses: only tenant create + channel checkout return 201.
 */
import { describe, expect, it } from "vitest";
import { COMMERCIAL_ROUTES } from "../src/data/commercialUrlCatalog";
import { PLATFORM_ROUTES } from "../src/data/platformUrlCatalog";
import {
  COMMERCIAL_SCHEMAS,
  PLATFORM_SCHEMAS,
  cboSchemasFor,
  zodSchemaToJsonSchema,
} from "../src/api/commercialSchemas";
import {
  accountLookupQuerySchema,
  channelPatchBodySchema,
  onboardingSaveBodySchema,
  profileSaveBodySchema,
  slackChannelBodySchema,
  tenantCreateBodySchema,
  tenantSettingsBodySchema,
  validateRequestShape,
  webhookUrlBodySchema,
} from "../src/api/requestValidation";

/** Walk a JSON value; the callback sees every object node. */
function walkJson(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visit(record);
  for (const value of Object.values(record)) walkJson(value, visit);
}

describe("shared schemas registry (#5610)", () => {
  it("covers every catalog operation and nothing outside the catalogs", () => {
    let count = 0;
    for (const r of COMMERCIAL_ROUTES) {
      for (const method of r.methods) {
        const schemas = cboSchemasFor("commercial", r.id, method);
        expect(schemas.request, `${r.id} ${method} request`).toBeTruthy();
        expect(schemas.response, `${r.id} ${method} response`).toBeTruthy();
        count++;
      }
      // No method outside the catalog entry's methods.
      for (const method of Object.keys(COMMERCIAL_SCHEMAS[r.id] ?? {})) {
        expect(r.methods, `${r.id} extra method ${method}`).toContain(method);
      }
    }
    for (const r of PLATFORM_ROUTES) {
      for (const method of r.methods) {
        const schemas = cboSchemasFor("platform", r.id, method);
        expect(schemas.request, `${r.id} ${method} request`).toBeTruthy();
        expect(schemas.response, `${r.id} ${method} response`).toBeTruthy();
        count++;
      }
      for (const method of Object.keys(PLATFORM_SCHEMAS[r.id] ?? {})) {
        expect(r.methods, `${r.id} extra method ${method}`).toContain(method);
      }
    }
    // 99 commercial + 21 platform operations.
    expect(count).toBe(120);
    const commercialIds = new Set(COMMERCIAL_ROUTES.map((r) => r.id));
    for (const id of Object.keys(COMMERCIAL_SCHEMAS)) {
      expect(commercialIds.has(id), `registry id outside the catalog: ${id}`).toBe(true);
    }
    const platformIds = new Set(PLATFORM_ROUTES.map((r) => r.id));
    for (const id of Object.keys(PLATFORM_SCHEMAS)) {
      expect(platformIds.has(id), `registry id outside the catalog: ${id}`).toBe(true);
    }
  });

  it("cboSchemasFor throws on an unknown id or method", () => {
    expect(() => cboSchemasFor("commercial", "nope", "GET")).toThrow(/No shared schemas/);
    expect(() => cboSchemasFor("platform", "tenants", "DELETE")).toThrow(/No shared schemas/);
    expect(() => cboSchemasFor("commercial", "account", "PATCH")).toThrow(/No shared schemas/);
  });

  it("every schema converts with no $schema and no additionalProperties: false", () => {
    // Documented non-object shapes: the raw-body webhook (z.unknown())
    // and the two union shapes. The raw policy record IS an object
    // (with typed additionalProperties — pinned separately below).
    const nonObjectRequests = new Set(["commercial:billingWebhook:POST", "commercial:productVersions:POST"]);
    const nonObjectResponses = new Set(["commercial:approvedFreeQuota:POST"]);
    const tables = [
      ["commercial", COMMERCIAL_ROUTES, COMMERCIAL_SCHEMAS],
      ["platform", PLATFORM_ROUTES, PLATFORM_SCHEMAS],
    ] as const;
    for (const [catalog, routes] of tables) {
      for (const r of routes) {
        for (const method of r.methods) {
          const schemas = cboSchemasFor(catalog, r.id, method);
          for (const [kind, schema] of [
            ["request", schemas.request],
            ["response", schemas.response],
          ] as const) {
            const converted = zodSchemaToJsonSchema(schema);
            walkJson(converted, (record) => {
              expect(record.$schema, `${r.id} ${method} ${kind} carries $schema`).toBeUndefined();
              expect(
                record.additionalProperties,
                `${r.id} ${method} ${kind} claims additionalProperties: false`,
              ).not.toBe(false);
            });
            const key = `${catalog}:${r.id}:${method}`;
            const nonObject =
              kind === "request" ? nonObjectRequests.has(key) : nonObjectResponses.has(key);
            if (nonObject) {
              expect(converted.type, `${key} ${kind} is an object after all`).not.toBe("object");
            } else {
              expect(converted.type, `${key} ${kind} is not an object`).toBe("object");
              // An object schema carries fixed properties — except a
              // record, which carries typed additionalProperties instead.
              const hasProperties = converted.properties !== undefined;
              const hasTypedAdditional =
                converted.additionalProperties !== undefined &&
                typeof converted.additionalProperties === "object";
              expect(
                hasProperties || hasTypedAdditional,
                `${key} ${kind} has neither properties nor typed additionalProperties`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it("the record-valued schema keeps its typed additionalProperties", () => {
    const converted = zodSchemaToJsonSchema(cboSchemasFor("commercial", "refundPolicy", "POST").request);
    expect(converted.type).toBe("object");
    // The record's values are unconstrained (`z.unknown()`), so the
    // converter emits the empty value-schema `{}` — preserved as-is,
    // neither rewritten to `true` nor left as `false`.
    expect(converted.additionalProperties).toEqual({});
  });

  it("reuses the #5604 shape schemas instead of redefining them", () => {
    expect(PLATFORM_SCHEMAS.accountProfile!.POST!.request).toBe(profileSaveBodySchema);
    expect(PLATFORM_SCHEMAS.onboardingState!.POST!.request).toBe(onboardingSaveBodySchema);
    expect(PLATFORM_SCHEMAS.tenants!.POST!.request).toBe(tenantCreateBodySchema);
    expect(PLATFORM_SCHEMAS.tenantSettings!.PATCH!.request).toBe(tenantSettingsBodySchema);
    expect(PLATFORM_SCHEMAS.channelPatch!.PATCH!.request).toBe(channelPatchBodySchema);
    expect(PLATFORM_SCHEMAS.channelSlackChannel!.PUT!.request).toBe(slackChannelBodySchema);
    expect(PLATFORM_SCHEMAS.channelSlackChannel!.PATCH!.request).toBe(slackChannelBodySchema);
    expect(PLATFORM_SCHEMAS.channelWebhookUrl!.PUT!.request).toBe(webhookUrlBodySchema);
    expect(PLATFORM_SCHEMAS.channelWebhookUrl!.PATCH!.request).toBe(webhookUrlBodySchema);
    expect(PLATFORM_SCHEMAS.accountLookup!.GET!.request).toBe(accountLookupQuerySchema);
  });

  it("only tenant create and channel checkout return 201", () => {
    const withStatus: string[] = [];
    for (const [catalog, routes, table] of [
      ["commercial", COMMERCIAL_ROUTES, COMMERCIAL_SCHEMAS],
      ["platform", PLATFORM_ROUTES, PLATFORM_SCHEMAS],
    ] as const) {
      for (const r of routes) {
        for (const method of r.methods) {
          const schemas = cboSchemasFor(catalog, r.id, method);
          if (schemas.successStatus !== undefined) {
            withStatus.push(`${catalog}:${r.id}:${method}:${schemas.successStatus}`);
          }
        }
      }
    }
    expect(withStatus.sort()).toEqual([
      "commercial:channelCheckout:POST:201",
      "platform:tenants:POST:201",
    ]);
  });

  it("response schemas enumerate the top-level fields the inventory names", () => {
    const tenantsGet = zodSchemaToJsonSchema(cboSchemasFor("platform", "tenants", "GET").response);
    expect(Object.keys(tenantsGet.properties as Record<string, unknown>)).toContain("tenants");
    const accountGet = zodSchemaToJsonSchema(cboSchemasFor("commercial", "account", "GET").response);
    const accountProps = Object.keys(accountGet.properties as Record<string, unknown>);
    expect(accountProps).toContain("code");
    expect(accountProps).toContain("record");
    const detailGet = zodSchemaToJsonSchema(
      cboSchemasFor("platform", "tenantDetail", "GET").response,
    );
    expect(Object.keys(detailGet.properties as Record<string, unknown>)).toContain("tenant");
  });

  it("accepts and rejects representative request shapes through the registry", () => {
    const cases: Array<{
      catalog: "commercial" | "platform";
      id: string;
      method: string;
      valid: unknown;
      invalid: unknown;
    }> = [
      { catalog: "commercial", id: "account", method: "POST", valid: { userId: "alice" }, invalid: { userId: 42 } },
      { catalog: "commercial", id: "subscriptionMove", method: "POST", valid: { toVersionId: "v2" }, invalid: {} },
      { catalog: "commercial", id: "accountSegment", method: "POST", valid: { segment: "beta" }, invalid: { segment: 1 } },
      { catalog: "commercial", id: "productRank", method: "POST", valid: { rank: 3 }, invalid: {} },
      { catalog: "commercial", id: "productVersions", method: "POST", valid: { periodDays: 30, includedRuns: 10, priceUSD: 4999 }, invalid: {} },
      { catalog: "commercial", id: "refundPolicy", method: "POST", valid: { any: "thing" }, invalid: "not-an-object" },
      { catalog: "commercial", id: "billingWebhook", method: "POST", valid: { type: "invoice.paid" }, invalid: undefined },
      { catalog: "platform", id: "accountProfile", method: "POST", valid: { idempotencyKey: "k", displayName: "Al" }, invalid: { displayName: 1 } },
      { catalog: "platform", id: "onboardingState", method: "POST", valid: { currentStep: 3 }, invalid: { currentStep: "3" } },
      { catalog: "platform", id: "tenants", method: "POST", valid: { tenantId: "acme" }, invalid: {} },
      { catalog: "platform", id: "tenantSettings", method: "PATCH", valid: { adsEnabled: false }, invalid: { adsEnabled: "no" } },
      { catalog: "platform", id: "channelPatch", method: "PATCH", valid: { channels: { slack: false } }, invalid: { channels: "x" } },
      { catalog: "platform", id: "channelSlackChannel", method: "PUT", valid: { slackChannel: "#g" }, invalid: {} },
      { catalog: "platform", id: "channelWebhookUrl", method: "PUT", valid: { webhookUrl: "https://x" }, invalid: {} },
      { catalog: "platform", id: "accountLookup", method: "GET", valid: { userId: "bob" }, invalid: { userId: 42 } },
    ];
    for (const c of cases) {
      const { request } = cboSchemasFor(c.catalog, c.id, c.method);
      // The webhook takes a raw body: every input is a valid shape.
      if (c.id === "billingWebhook") {
        expect(validateRequestShape(request, c.valid).ok, `${c.id} valid`).toBe(true);
        continue;
      }
      expect(validateRequestShape(request, c.valid).ok, `${c.id} ${c.method} valid`).toBe(true);
      expect(validateRequestShape(request, c.invalid).ok, `${c.id} ${c.method} invalid`).toBe(false);
    }
  });
});
