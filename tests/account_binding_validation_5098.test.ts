import { describe, it, expect } from "vitest";
import {
  isAccountBindingScope,
  isAccountBindingTuple,
  migrateLegacyBrokerSelectionToTuple,
  normalizeAccountBindingScope,
  toAccountBindingTuple,
  validateAccountAgainstBroker,
  validateAccountBindingInput,
  type AccountBinding,
  type AccountBindingScope,
  type AccountBindingTuple,
  type BrokerAccountRecordLike,
} from "../src/trading";
import {
  getTenantAccountBinding,
  listAccountBindings,
  migrateTenantAccountBinding,
  resolveExecutionAccountContext,
  resolveExecutionAccountTuple,
  resolveUserAccountBinding,
  validateAndUpsertAccountBinding,
} from "../src/services/accountBindings";
import { handleAccountBindingRoutes } from "../src/agents/routes/accountBindings";
import { BrokerAccountBindingCommand } from "../src/mcps/openaimp/accountBindingCommands";
import { maskAccountId } from "../src/config/accountBindings";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

describe("Issue #5098 (Slice F1 of #5094) — Tuple model, persistence & validation", () => {
  const dummyAccounts: BrokerAccountRecordLike[] = [
    {
      accountId: "ALP-LIVE-001",
      accountKey: "KEY-001",
      accountDesc: "Alpaca Main Stock",
      accountName: "Alpaca Primary",
      accountType: "stock",
      broker: "alpaca",
      status: "ACTIVE",
      owned: true,
      supportedAssetTypes: ["stock", "margin"],
      isDefault: true,
    },
    {
      accountId: "ALP-OPT-002",
      accountKey: "KEY-002",
      accountDesc: "Alpaca Options Desk",
      accountName: "Alpaca Options",
      accountType: "options",
      broker: "alpaca",
      status: "ACTIVE",
      owned: true,
      supportedAssetTypes: ["options"],
    },
    {
      accountId: "ALP-CLOSED-003",
      accountKey: "KEY-003",
      accountDesc: "Old Closed Account",
      accountType: "stock",
      broker: "alpaca",
      status: "closed",
      isClosed: true,
      owned: true,
    },
    {
      accountId: "ALP-UNOWNED-004",
      accountKey: "KEY-004",
      accountDesc: "Foreign Account",
      accountType: "stock",
      broker: "alpaca",
      status: "ACTIVE",
      owned: false,
    },
    {
      accountId: "ET-STOCK-555",
      accountKey: "ET-KEY-555",
      accountDesc: "E*TRADE Taxable",
      accountType: "stock",
      broker: "etrade",
      status: "ACTIVE",
      owned: true,
    },
  ];

  it("5098-P01: tuple model { broker, mode, accountType, accountId } and scope normalization", () => {
    const raw = validateAccountBindingInput({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      accountId: "ALP-PAPER-123",
      accountName: "Paper Desk",
    });
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;

    const tuple: AccountBindingTuple = toAccountBindingTuple(raw.binding);
    expect(tuple).toEqual({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "ALP-PAPER-123",
      accountName: "Paper Desk",
    });
    expect(isAccountBindingTuple(tuple)).toBe(true);
    expect(isAccountBindingTuple({ broker: "alpaca", mode: "invalid", accountType: "stock" })).toBe(false);

    // Scopes include tenant, autopilot, copilot, schedule, ux, audit
    expect(isAccountBindingScope("tenant")).toBe(true);
    expect(isAccountBindingScope("autopilot")).toBe(true);
    expect(isAccountBindingScope("copilot")).toBe(true);
    expect(isAccountBindingScope("schedule")).toBe(true);
    expect(isAccountBindingScope("ux")).toBe(true);
    expect(isAccountBindingScope("audit")).toBe(true);
    expect(isAccountBindingScope("records")).toBe(true);

    expect(normalizeAccountBindingScope("ux")).toBe("ux");
    expect(normalizeAccountBindingScope("audit")).toBe("audit");
    expect(normalizeAccountBindingScope("records")).toBe("audit");
  });

  it("5098-P02: validation seam fails loud on unknown account (FAILURE_ACCOUNT_UNKNOWN)", () => {
    const res = validateAccountAgainstBroker({
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      accountId: "DOES-NOT-EXIST",
      availableAccounts: dummyAccounts,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_UNKNOWN");
    expect(res.error).toContain("[FAILURE_ACCOUNT_UNKNOWN]");
    expect(res.error).toContain("DOES-NOT-EXIST");
  });

  it("5098-P03: validation seam fails loud on unowned or closed account (FAILURE_ACCOUNT_UNOWNED)", () => {
    const closedRes = validateAccountAgainstBroker({
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      accountId: "ALP-CLOSED-003",
      availableAccounts: dummyAccounts,
    });
    expect(closedRes.ok).toBe(false);
    if (!closedRes.ok) {
      expect(closedRes.code).toBe("FAILURE_ACCOUNT_UNOWNED");
      expect(closedRes.error).toContain("[FAILURE_ACCOUNT_UNOWNED]");
      expect(closedRes.error).toContain("closed");
    }

    const unownedRes = validateAccountAgainstBroker({
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      accountId: "ALP-UNOWNED-004",
      availableAccounts: dummyAccounts,
    });
    expect(unownedRes.ok).toBe(false);
    if (!unownedRes.ok) {
      expect(unownedRes.code).toBe("FAILURE_ACCOUNT_UNOWNED");
      expect(unownedRes.error).toContain("[FAILURE_ACCOUNT_UNOWNED]");
      expect(unownedRes.error).toContain("not owned");
    }
  });

  it("5098-P04: validation seam fails loud on asset type mismatch (FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH)", () => {
    // Attempting to bind stock account for crypto or unsupported asset class
    const mismatchRes = validateAccountAgainstBroker({
      broker: "alpaca",
      mode: "live",
      accountType: "options",
      accountId: "ALP-LIVE-001", // Supports only stock and margin, not options
      availableAccounts: dummyAccounts,
    });
    expect(mismatchRes.ok).toBe(false);
    if (mismatchRes.ok) return;
    expect(mismatchRes.code).toBe("FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH");
    expect(mismatchRes.error).toContain("[FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH]");
  });

  it("5098-P05: validation seam fails loud on cross-broker substitution (FAILURE_ACCOUNT_BROKER_MISMATCH)", () => {
    // Attempting to bind an E*TRADE account under Alpaca broker
    const crossRes = validateAccountAgainstBroker({
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      accountId: "ET-STOCK-555",
      availableAccounts: dummyAccounts,
    });
    expect(crossRes.ok).toBe(false);
    if (crossRes.ok) return;
    expect(crossRes.code).toBe("FAILURE_ACCOUNT_BROKER_MISMATCH");
    expect(crossRes.error).toContain("[FAILURE_ACCOUNT_BROKER_MISMATCH]");
    expect(crossRes.error).toContain("Cross-broker substitution is disallowed");
  });

  it("5098-P06: validation seam succeeds on valid active matching account", () => {
    const validRes = validateAccountAgainstBroker({
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      scope: "autopilot",
      accountId: "ALP-LIVE-001",
      availableAccounts: dummyAccounts,
    });
    expect(validRes.ok).toBe(true);
    if (!validRes.ok) return;
    expect(validRes.tuple.accountId).toBe("ALP-LIVE-001");
    expect(validRes.tuple.accountType).toBe("stock");
    expect(validRes.binding.scope).toBe("autopilot");
  });

  it("5098-P07: migration seam migrates unambiguous single account or single default cleanly", () => {
    const singleAccount: BrokerAccountRecordLike[] = [
      {
        accountId: "SINGLE-ACCT-999",
        accountDesc: "Sole Account",
        accountType: "stock",
        broker: "alpaca",
        status: "ACTIVE",
        owned: true,
      },
    ];

    const mig = migrateLegacyBrokerSelectionToTuple({
      broker: "alpaca",
      mode: "paper",
      availableAccounts: singleAccount,
    });
    expect(mig.ok).toBe(true);
    if (!mig.ok) return;
    expect(mig.tuple.accountId).toBe("SINGLE-ACCT-999");
    expect(mig.tuple.accountType).toBe("stock");
    expect(mig.migrated).toBe(true);

    // Multi-account with explicit isDefault
    const withDefault = migrateLegacyBrokerSelectionToTuple({
      broker: "alpaca",
      mode: "live",
      availableAccounts: dummyAccounts,
    });
    expect(withDefault.ok).toBe(true);
    if (!withDefault.ok) return;
    expect(withDefault.tuple.accountId).toBe("ALP-LIVE-001");
  });

  it("5098-P08: migration seam fails loud on ambiguous accounts without guessing (FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS)", () => {
    const ambiguousAccounts: BrokerAccountRecordLike[] = [
      {
        accountId: "ACCT-A",
        accountDesc: "Account Alpha",
        accountType: "stock",
        broker: "alpaca",
        status: "ACTIVE",
        owned: true,
      },
      {
        accountId: "ACCT-B",
        accountDesc: "Account Beta",
        accountType: "stock",
        broker: "alpaca",
        status: "ACTIVE",
        owned: true,
      },
    ];

    const res = migrateLegacyBrokerSelectionToTuple({
      broker: "alpaca",
      mode: "live",
      availableAccounts: ambiguousAccounts,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS");
    expect(res.candidateAccountIds).toEqual(["ACCT-A", "ACCT-B"]);
    expect(res.error).toContain("[FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS]");
  });

  it("5098-P09: migration seam fails loud when zero accounts exist (FAILURE_ACCOUNT_UNKNOWN)", () => {
    const res = migrateLegacyBrokerSelectionToTuple({
      broker: "alpaca",
      mode: "live",
      availableAccounts: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_UNKNOWN");
    expect(res.error).toContain("[FAILURE_ACCOUNT_UNKNOWN]");
  });

  it("5098-P10: persistence seam verifies validateAndUpsertAccountBinding, migration, and resolveExecutionAccountTuple", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const user = "trader-f1@example.com";

    // 1. validateAndUpsert with actual accounts verifies and stores tuple
    const upsertRes = await validateAndUpsertAccountBinding(env, user, {
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      scope: "tenant",
      accountId: "ALP-LIVE-001",
      availableAccounts: dummyAccounts,
    });
    expect(upsertRes.ok).toBe(true);
    if (!upsertRes.ok) return;
    expect(upsertRes.tuple.accountId).toBe("ALP-LIVE-001");

    // 2. getTenantAccountBinding retrieves tenant tuple
    const tenantTuple = await getTenantAccountBinding(env, user, {
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
    });
    expect(tenantTuple).not.toBeNull();
    expect(tenantTuple?.accountId).toBe("ALP-LIVE-001");

    // 3. resolveExecutionAccountTuple resolves copilot inheriting from tenant
    const resolvedCopilot = await resolveExecutionAccountTuple(env, user, {
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      scope: "copilot",
    });
    expect(resolvedCopilot.found).toBe(true);
    if (resolvedCopilot.found) {
      expect(resolvedCopilot.tuple.accountId).toBe("ALP-LIVE-001");
      expect(resolvedCopilot.resolvedFromScope).toBe("tenant");
    }

    // 4. Per-surface binding for ux scope overrides tenant
    const uxUpsert = await validateAndUpsertAccountBinding(env, user, {
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      scope: "ux",
      accountId: "ALP-OPT-002",
      availableAccounts: [
        {
          accountId: "ALP-OPT-002",
          accountType: "stock",
          broker: "alpaca",
          status: "ACTIVE",
          owned: true,
        },
      ],
    });
    expect(uxUpsert.ok).toBe(true);

    const resolvedUx = await resolveExecutionAccountTuple(env, user, {
      broker: "alpaca",
      mode: "live",
      accountType: "stock",
      scope: "ux",
    });
    expect(resolvedUx.found).toBe(true);
    if (resolvedUx.found) {
      expect(resolvedUx.tuple.accountId).toBe("ALP-OPT-002");
      expect(resolvedUx.resolvedFromScope).toBe("ux");
    }

    // 5. Unbound slot fails loud with FAILURE_ACCOUNT_BINDING_MISSING
    const unbound = await resolveExecutionAccountTuple(env, user, {
      broker: "alpaca",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
    });
    expect(unbound.found).toBe(false);
    if (!unbound.found) {
      expect(unbound.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
      expect(unbound.error).toContain("[FAILURE_ACCOUNT_BINDING_MISSING]");
    }
  });

  it("5098-P11: HTTP route /broker/account-binding serves validate and migrate actions", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const url = new URL("https://app.example.com/api/broker/account-binding");

    // Action: validate
    const validateReq = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "validate",
        broker: "alpaca",
        mode: "live",
        accountType: "stock",
        accountId: "ALP-LIVE-001",
        availableAccounts: dummyAccounts,
      }),
    });
    const valResp = await handleAccountBindingRoutes(validateReq, url, "/broker/account-binding", "user-web", { env });
    expect(valResp?.status).toBe(200);
    const valData = await valResp?.json() as { ok: boolean; tuple: AccountBindingTuple };
    expect(valData.ok).toBe(true);
    expect(valData.tuple.accountId).toBe("ALP-LIVE-001");

    // Action: validate with unknown account -> 404
    const unknownReq = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "validate",
        broker: "alpaca",
        mode: "live",
        accountType: "stock",
        accountId: "NO-SUCH-ACCOUNT",
        availableAccounts: dummyAccounts,
      }),
    });
    const unkResp = await handleAccountBindingRoutes(unknownReq, url, "/broker/account-binding", "user-web", { env });
    expect(unkResp?.status).toBe(404);
    const unkData = await unkResp?.json() as { ok: boolean; code: string };
    expect(unkData.ok).toBe(false);
    expect(unkData.code).toBe("FAILURE_ACCOUNT_UNKNOWN");

    // Action: migrate ambiguous -> 409
    const ambigReq = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "migrate",
        broker: "alpaca",
        mode: "live",
        availableAccounts: [
          { accountId: "A1", broker: "alpaca", status: "ACTIVE", owned: true, accountType: "stock" },
          { accountId: "A2", broker: "alpaca", status: "ACTIVE", owned: true, accountType: "stock" },
        ],
      }),
    });
    const ambigResp = await handleAccountBindingRoutes(ambigReq, url, "/broker/account-binding", "user-web", { env });
    expect(ambigResp?.status).toBe(409);
    const ambigData = await ambigResp?.json() as { ok: boolean; code: string; candidateAccountIds: string[] };
    expect(ambigData.ok).toBe(false);
    expect(ambigData.code).toBe("FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS");
    expect(ambigData.candidateAccountIds).toEqual(["A1", "A2"]);
  });

  it("5098-P12: MCP tool broker_account_binding executes validate and migrate actions", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const cmd = new BrokerAccountBindingCommand();

    // Validate valid account
    const valRes = await cmd.execute(
      {
        action: "validate",
        broker: "alpaca",
        mode: "live",
        accountType: "stock",
        accountId: "ALP-LIVE-001",
        availableAccounts: dummyAccounts,
      },
      { env, sessionId: "trader-mcp" },
    ) as { ok: boolean; tuple: AccountBindingTuple };
    expect(valRes.ok).toBe(true);
    // Issue #5101 (F4 of #5094): the MCP tool masks every id it
    // returns — the tuple carries the masked id, never the full id.
    expect(valRes.tuple.accountId).toBe(maskAccountId("ALP-LIVE-001"));
    expect(JSON.stringify(valRes)).not.toContain("ALP-LIVE-001");

    // Migrate unambiguous
    const migRes = await cmd.execute(
      {
        action: "migrate",
        broker: "alpaca",
        mode: "live",
        availableAccounts: [
          { accountId: "SOLO-1", broker: "alpaca", status: "ACTIVE", owned: true, accountType: "stock" },
        ],
      },
      { env, sessionId: "trader-mcp" },
    ) as { ok: boolean; migrated: boolean; tuple: AccountBindingTuple };
    expect(migRes.ok).toBe(true);
    expect(migRes.migrated).toBe(true);
    // Issue #5101 (F4 of #5094): the MCP tool masks every id it returns.
    expect(migRes.tuple.accountId).toBe(maskAccountId("SOLO-1"));
    expect(JSON.stringify(migRes)).not.toContain("SOLO-1");
  });
});
