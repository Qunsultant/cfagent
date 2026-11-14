// @vitest-environment node
/**
 * Issue #2846 (Monetization Phase 2.16) — AOP externalization.
 *
 * Pins, in the order of the issue's three sections:
 * 1. One commercial URL catalog is the single source of truth: the route
 *    table's (method, matchSuffix) set equals the handler's endsWith set;
 *    no hardcoded commercial path literal survives outside the catalog
 *    module (comments stripped before scanning); the IAAA explorer entry
 *    derives its prefixes + source from the catalog.
 * 2. Commercial defaults live in the config port with values UNCHANGED
 *    (receipts 50/100, transactions 50, ledger payments 50) — pinned by
 *    value and by behavior through the real receipts route.
 * 3. Commercial success/failure responses carry a stable outcome-catalog
 *    code resolvable through the single resolver; no raw store/technical
 *    error text reaches a commercial client.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  COMMERCIAL_API_BASE,
  COMMERCIAL_BARE_BASE,
  COMMERCIAL_BARE_PREFIX,
  COMMERCIAL_ROUTES,
  COMMERCIAL_ROUTE_SUFFIXES,
  PAYMENTS_API_PREFIX,
  commercialPath,
  commercialBarePath,
} from "../src/data/commercialUrlCatalog";
import { COMMERCIAL_DEFAULTS } from "../src/config/commercialDefaults";
import { codedMessage, resolveOutcome } from "../src/outcomes/outcomeAspects";
import { API_ENDPOINT_CATALOG } from "../src/client/iaaaEndpointCatalog";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1JournalDb,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import {
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1BillingCustomerDb,
  ensureBillingCustomerSchema,
} from "../src/data/d1BillingCustomerAdapter";
import {
  createD1RefundDb,
  D1RefundAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import type { DatabaseORM } from "../src/orm";
import { DatabaseORM as ReceiptORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handlePaymentsRoutes } from "../src/agents/routes/payments";
import { ensureSharedTable } from "../src/data/ormSchema";
import { createCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import { ensureMasRetentionIndexes } from "../src/data/masRetentionIndexSchema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** String-aware comment stripper: `//` inside a string is not a comment. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
      } else {
        if (c === "\n") out += c;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(p, out);
    else if (entry.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) out.push(p);
  }
  return out;
}

describe("commercial URL catalog (#2846 §1)", () => {
  it("has unique ids and canonical == /api + bare", () => {
    const ids = COMMERCIAL_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMMERCIAL_ROUTES.length).toBeGreaterThan(40);
    for (const r of COMMERCIAL_ROUTES) {
      expect(r.methods.length).toBeGreaterThan(0);
      for (const m of r.methods) expect(["GET", "POST"]).toContain(m);
      expect(r.bare.startsWith(COMMERCIAL_BARE_BASE), `${r.id} bare`).toBe(true);
      expect(commercialPath(r.id)).toBe(`/api${r.bare}`);
      expect(commercialBarePath(r.id)).toBe(r.bare);
      expect(r.matchSuffix.length).toBeGreaterThan(0);
      expect(COMMERCIAL_ROUTE_SUFFIXES[r.id]).toBe(r.matchSuffix);
    }
    expect(COMMERCIAL_API_BASE).toBe("/api/payments/agentic/commercial");
    expect(COMMERCIAL_BARE_BASE).toBe("/payments/agentic/commercial");
    expect(COMMERCIAL_BARE_PREFIX).toBe("/payments/agentic/commercial/");
    expect(PAYMENTS_API_PREFIX).toBe("/api/payments/agentic/");
  });

  it("spot-checks the paths the clients and dispatcher use", () => {
    expect(commercialPath("account")).toBe("/api/payments/agentic/commercial/account");
    expect(commercialPath("channelCheckout")).toBe(
      "/api/payments/agentic/commercial/channel/checkout",
    );
    expect(commercialBarePath("plans")).toBe("/payments/agentic/commercial/plans");
    expect(commercialBarePath("lifecycleDigestRunDue")).toBe(
      "/payments/agentic/commercial/lifecycle/digest/run-due",
    );
    expect(COMMERCIAL_ROUTE_SUFFIXES.channelCheckout).toBe("/commercial/channel/checkout");
    expect(COMMERCIAL_ROUTE_SUFFIXES.account).toBe("/payments/agentic/commercial/account");
  });

  it("the route table's (method, matchSuffix) set equals the handler's endsWith set", () => {
    const handler = readSrc("src/agents/routes/agenticPayments.ts");
    const fromHandler = new Set<string>();
    for (const line of handler.split("\n")) {
      // The handler must match through the catalog, never a literal path:
      // a literal commercial endsWith here would fail the no-literal pin.
      const literal = line.match(/path\.endsWith\("([^"]+)"\)/);
      if (
        literal &&
        (literal[1].startsWith("/payments/agentic/commercial") || literal[1].startsWith("/commercial/"))
      ) {
        throw new Error(`handler matches a literal commercial suffix: ${line.trim()}`);
      }
      const m = line.match(/path\.endsWith\(COMMERCIAL_ROUTE_SUFFIXES\.([A-Za-z]+)\)/);
      if (!m) continue;
      const suffix = COMMERCIAL_ROUTE_SUFFIXES[m[1] as keyof typeof COMMERCIAL_ROUTE_SUFFIXES];
      expect(suffix, `unknown catalog id on endsWith line: ${line.trim()}`).toBeTruthy();
      const methods = [...line.matchAll(/request\.method === "(GET|POST)"/g)].map((x) => x[1]);
      expect(methods.length, `no method on endsWith line: ${line.trim()}`).toBeGreaterThan(0);
      for (const method of methods) fromHandler.add(`${method} ${suffix}`);
    }
    const fromCatalog = new Set<string>();
    for (const r of COMMERCIAL_ROUTES) {
      for (const method of r.methods) fromCatalog.add(`${method} ${r.matchSuffix}`);
    }
    expect([...fromCatalog].sort()).toEqual([...fromHandler].sort());
  });

  it("no hardcoded commercial path literal survives outside the catalog module", () => {
    const offenders: string[] = [];
    for (const file of walkTs(join(ROOT, "src"))) {
      if (file.endsWith("src/data/commercialUrlCatalog.ts")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (code.includes("payments/agentic/commercial") || code.includes("/commercial/channel")) {
        offenders.push(file.replace(ROOT + "/", ""));
      }
    }
    expect(offenders, "files with hardcoded commercial path literals").toEqual([]);
  });

  it("the IAAA explorer payments-agentic entry derives from the catalog", () => {
    const entry = API_ENDPOINT_CATALOG.find((e) => e.id === "payments-agentic");
    expect(entry).toBeTruthy();
    expect(entry!.prefixes).toEqual([PAYMENTS_API_PREFIX, COMMERCIAL_BARE_PREFIX]);
    expect(entry!.source).toContain("commercialUrlCatalog");
  });
});

describe("commercial defaults (#2846 §2)", () => {
  it("pins the inventoried values unchanged", () => {
    expect(COMMERCIAL_DEFAULTS.receiptsDefaultLimit).toBe(50);
    expect(COMMERCIAL_DEFAULTS.receiptsMaxLimit).toBe(100);
    expect(COMMERCIAL_DEFAULTS.transactionsDefaultLimit).toBe(50);
    expect(COMMERCIAL_DEFAULTS.ledgerPaymentsDefaultLimit).toBe(50);
  });

  it("the receipts route reads the default limit and cap from the config port", async () => {
    const sql = new MockSqlStorage() as any;
    const orm = new ReceiptORM(sql);
    ensureSharedTable(sql, "mas_events");
    ensureSharedTable(sql, "mas_transactions");
    createCanonicalReportStorePorts(sql).usage.ensureSchema();
    ensureMasRetentionIndexes(sql);
    const OWNER = "owner-login";
    // 120 rows: enough to observe the 100 cap (60 would cap the result at 60).
    for (let i = 0; i < 120; i++) {
      sql.exec(
        "INSERT INTO usage_events (id, user_login, run_id, category, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
        `m${i}`,
        OWNER,
        `run-${i}`,
        "screen",
        `2026-11-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
        JSON.stringify({ price: 0.02, tier: "Free", protocol: "verified" }),
      );
    }
    const callReceipts = async (query = "") => {
      const url = new URL(`https://worker.test/api/payments/receipts${query}`);
      const req = new Request(url, { headers: { "x-user-login": OWNER } });
      return handlePaymentsRoutes(req, url, url.pathname, "session-1", {
        env: {},
        ensureTables: () => sql,
        getOrm: () => orm,
        audit: () => {},
      } as any);
    };
    const def = (await (await callReceipts("?kind=meter"))!.json()) as any;
    expect(def.receipts.length).toBe(COMMERCIAL_DEFAULTS.receiptsDefaultLimit);
    const capped = (await (await callReceipts("?kind=meter&limit=500"))!.json()) as any;
    expect(capped.receipts.length).toBe(COMMERCIAL_DEFAULTS.receiptsMaxLimit);
    const five = (await (await callReceipts("?kind=meter&limit=5"))!.json()) as any;
    expect(five.receipts.length).toBe(5);
  });
});

const NEW_CODES = [
  "FAILURE_COMMERCIAL_STORE_UNAVAILABLE",
  "FAILURE_COMMERCIAL_REQUEST_INVALID",
  "FAILURE_COMMERCIAL_FORBIDDEN",
  "FAILURE_DEACTIVATION_BLOCKED_BY_SUBSCRIPTION",
  "FAILURE_RECEIPTS_UNAVAILABLE",
  "SUCCESS_ACCOUNT_READ",
  "SUCCESS_IDENTITY_READ",
  "SUCCESS_PLANS_LISTED",
  "SUCCESS_OPERATORS_LISTED",
  "SUCCESS_BILLING_POLICY_READ",
  "SUCCESS_SUBSCRIPTION_READ",
  "SUCCESS_REFUNDS_LISTED",
];

describe("commercial outcome codes (#2846 §3)", () => {
  it("every new commercial code resolves through the single resolver", () => {
    for (const code of NEW_CODES) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved, `${code} resolves`).toBe(true);
      expect(resolved.entry?.category).toBe("commercial");
      expect(resolved.businessMessage).toBeTruthy();
      expect(codedMessage(code)).toBe(`[${code}] ${resolved.entry!.businessMessage}`);
    }
  });

  it("the legacy deactivation code still resolves to the new code", () => {
    expect(resolveOutcome("DeactivationBlockedByActiveSubscription").code).toBe(
      "FAILURE_DEACTIVATION_BLOCKED_BY_SUBSCRIPTION",
    );
  });

  it("no raw store error text reaches a commercial client (grep pin)", () => {
    const handler = readSrc("src/agents/routes/agenticPayments.ts");
    const bad: string[] = [];
    handler.split("\n").forEach((line, idx) => {
      if (/Response\.json\(.*err\.message/.test(line) || /error: `[^`]*\$\{err\.message/.test(line)) {
        bad.push(`${idx + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
    expect(bad, "Response.json sites leaking err.message").toEqual([]);
  });

  it("every commercial Response.json body carries a resolving code (shape pin)", () => {
    const handler = readSrc("src/agents/routes/agenticPayments.ts");
    const start = handler.indexOf('path.endsWith("/payments/agentic/commercial/account")');
    const region = handler.slice(start);
    const missing: string[] = [];
    const re = /Response\.json\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(region)) !== null) {
      let depth = 0;
      let i = m.index + "Response.json({".length - 1;
      for (; i < region.length; i++) {
        if (region[i] === "{") depth++;
        else if (region[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      const obj = region.slice(m.index, i + 1);
      const codeMatch = obj.match(/\bcode:\s*"([A-Z_]+)"/);
      if (!codeMatch) {
        missing.push(obj.slice(0, 100).replace(/\n/g, " "));
        continue;
      }
      expect(resolveOutcome(codeMatch[1]).resolved, `${codeMatch[1]} resolves`).toBe(true);
    }
    expect(missing, "Response.json bodies without a code").toEqual([]);
  });
});

class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  throwOnCommercialSelect = false;
  prepare(sql: string) {
    const db = this.sqlite;
    if (
      this.throwOnCommercialSelect &&
      /^\s*select/i.test(sql) &&
      sql.includes("commercial_account")
    ) {
      throw new Error("boom-store-failure");
    }
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
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
}

async function setupCommercial(opts: { withDb?: boolean; throwOnSelect?: boolean } = {}) {
  const mock = new MockD1Database();
  if (opts.throwOnSelect) mock.throwOnCommercialSelect = true;
  const env: Record<string, unknown> = { COMMERCIAL_STORE_OPERATORS: "op1" };
  if (opts.withDb !== false) {
    env.AGENT_DB = mock;
    await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
    await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
    await ensureJournalSchema(createD1JournalDb(mock as unknown as D1Database));
    await ensureBillingPolicySchema(createD1BillingPolicyDb(mock as unknown as D1Database));
    await ensureBillingCustomerSchema(createD1BillingCustomerDb(mock as unknown as D1Database));
    await ensureRefundSchema(createD1RefundDb(mock as unknown as D1Database));
  }
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, mock };
}

const commercialCall = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) => {
  const url = new URL(`https://agent.internal${path}`);
  const req = new Request(url, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return handleAgenticPaymentsRoutes(req, url, url.pathname, "sess-1", ctx);
};

describe("commercial routes carry coded outcomes (behavioral, #2846 §3)", () => {
  it("GET account returns a coded success", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/account?userId=alice", "alice");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("SUCCESS_ACCOUNT_READ");
    expect(resolveOutcome(body.code).resolved).toBe(true);
  });

  it("GET plans returns a coded success", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/plans", "alice");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("SUCCESS_PLANS_LISTED");
    expect(body.plans).toEqual([]);
  });

  it("GET operators returns a coded success", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/operators", "op1");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("SUCCESS_OPERATORS_LISTED");
  });

  it("GET billing-policy returns a coded success", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/billing-policy", "op1");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("SUCCESS_BILLING_POLICY_READ");
  });

  it("GET subscription returns a coded success", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/subscription?userId=alice", "alice");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("SUCCESS_SUBSCRIPTION_READ");
  });

  it("GET refunds returns a coded success", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/refunds?userId=alice", "alice");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("SUCCESS_REFUNDS_LISTED");
  });

  it("an unbound store fails closed with the coded store-unavailable outcome", async () => {
    const { ctx } = await setupCommercial({ withDb: false });
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/account?userId=alice", "alice");
    expect(res!.status).toBe(503);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");
    expect(body.error).toBe(codedMessage("FAILURE_COMMERCIAL_STORE_UNAVAILABLE"));
  });

  it("a throwing store fails with the coded unexpected-error outcome and no raw text", async () => {
    const { ctx } = await setupCommercial({ throwOnSelect: true });
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/account?userId=alice", "alice");
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_UNEXPECTED_ERROR");
    expect(body.error).toBe(codedMessage("FAILURE_UNEXPECTED_ERROR"));
    expect(JSON.stringify(body)).not.toContain("boom-store-failure");
  });

  it("an invalid billing-policy update fails with the coded request-invalid outcome", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(
      ctx,
      "POST",
      "/api/payments/agentic/commercial/billing-policy",
      "op1",
      { bogus: true },
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_COMMERCIAL_REQUEST_INVALID");
    expect(body.error).toBe(codedMessage("FAILURE_COMMERCIAL_REQUEST_INVALID"));
  });

  it("a forbidden account read fails with the coded forbidden outcome", async () => {
    const { ctx } = await setupCommercial();
    const res = await commercialCall(ctx, "GET", "/api/payments/agentic/commercial/account?userId=bob", "alice");
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_COMMERCIAL_FORBIDDEN");
  });

  it("receipts failures carry codes while keeping their typed error strings", async () => {
    const sql = new MockSqlStorage() as any;
    const orm = new ReceiptORM(sql);
    ensureSharedTable(sql, "mas_events");
    ensureSharedTable(sql, "mas_transactions");
    createCanonicalReportStorePorts(sql).usage.ensureSchema();
    ensureMasRetentionIndexes(sql);
    const callReceipts = async (headers: Record<string, string>, query = "") => {
      const url = new URL(`https://worker.test/api/payments/receipts${query}`);
      const req = new Request(url, { headers });
      return handlePaymentsRoutes(req, url, url.pathname, "session-1", {
        env: {},
        ensureTables: () => sql,
        getOrm: () => orm,
        audit: () => {},
      } as any);
    };
    const noLogin = (await (await callReceipts({}))!.json()) as any;
    expect(noLogin.error).toBe("ReceiptsLoginRequired");
    expect(noLogin.code).toBe("FAILURE_AUTH_NO_SESSION");
    const badLimit = (await (await callReceipts({ "x-user-login": "owner-login" }, "?limit=0"))!.json()) as any;
    expect(badLimit.error).toBe("ReceiptsInvalidLimit");
    expect(badLimit.code).toBe("FAILURE_COMMERCIAL_REQUEST_INVALID");
  });
});
