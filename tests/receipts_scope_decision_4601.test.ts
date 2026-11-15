import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReceipts,
  RECEIPTS_SCOPE_BOUNDARY,
  readReceipts,
} from "../src/services/receiptSurface";
import { handlePaymentsRoutes } from "../src/agents/routes/payments";

function makeStore() {
  const usageRows = [
    {
      id: "use_1",
      user_login: "alice",
      run_id: "rcpt_1",
      category: "stock_signals",
      created_at: "2026-11-15T10:00:00Z",
      detail_json: JSON.stringify({ receiptId: "rcpt_1", priceUSD: 0.02, tier: "PayPerUse", protocol: "x402" }),
    },
  ];
  const sql = {
    exec(query: string) {
      if (query.includes("FROM usage_events")) return usageRows;
      return [];
    },
  };
  const orm = {
    transactions: {
      findById: () => null,
      findMany: () => [],
    },
  };
  return { sql, orm };
}

describe("Issue #4601 — receipts login-scope decision & boundary", () => {
  it("pins RECEIPTS_SCOPE_BOUNDARY to 'login' and includes scope: 'login' on buildReceipts + readReceipts", () => {
    expect(RECEIPTS_SCOPE_BOUNDARY).toBe("login");
    const built = buildReceipts({
      userLogin: "alice",
      meterRows: [],
      tierRows: [],
      gatewayRows: [],
      limit: 50,
    });
    expect(built.scope).toBe("login");

    const store = makeStore();
    const read = readReceipts(store, "alice", { limit: 50, kind: "all" });
    expect(read.scope).toBe("login");
    expect(read.userLogin).toBe("alice");
    expect(read.receipts).toHaveLength(1);
  });

  it("GET /api/payments/receipts ignores client tenantId query params and returns scope: 'login'", async () => {
    const store = makeStore();
    const url = new URL("https://worker.test/api/payments/receipts?tenantId=other-tenant");
    const req = new Request(url, { headers: { "x-user-login": "alice" } });
    const res = await handlePaymentsRoutes(req, url, url.pathname, "session-1", {
      env: {},
      ensureTables: () => store.sql,
      getOrm: () => store.orm,
      audit: () => {},
    } as never);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { userLogin: string; scope: string; receipts: unknown[] };
    expect(body.userLogin).toBe("alice");
    expect(body.scope).toBe("login");
    expect(body.receipts).toHaveLength(1);
  });

  it("capability map §7.7 records the decided login-scoped receipts boundary", () => {
    const doc = readFileSync(
      join(process.cwd(), "docs", "architecture", "business", "platform-entity-capability-map.md"),
      "utf8",
    );
    expect(doc).toContain("RECEIPTS_SCOPE_BOUNDARY");
    expect(doc).toContain("#4601");
  });
});
