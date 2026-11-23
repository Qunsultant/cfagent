// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { bindingPromptLine } from "../src/agents/chatPrompt";
import { maskAccountId } from "../src/config/accountBindings";
import {
  listAccountBindings,
  listBrokerAccountsForMode,
  upsertAccountBinding,
} from "../src/services/accountBindings";
import {
  maskAccountBinding,
  maskBrokerAccount,
  resolveAccountByLabel,
  type BrokerAccountRecordLike,
} from "../src/trading/accountBindings";
import { planWithRules } from "../src/agents/nlq/planning";
import { executeNLQQuery, executeNLQQueryAsync, type NLQPlan } from "../src/agents/nlq";
import { ToolResultView } from "../src/client/chat/ToolResultView";
import { messageHasBindingSwitch } from "../src/client/chat/bindingBridge";
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

// Issue #5101: the broker's enumerated accounts for the F4 tests.
const ENUMERATED: BrokerAccountRecordLike[] = [
  { accountId: "PA-123", accountKey: "PA-123", accountDesc: "Alpaca Stock", accountName: "Alpaca Stock", accountType: "stock", broker: "alpaca" },
  { accountId: "PA-456", accountKey: "PA-456", accountDesc: "Alpaca Options", accountName: "Alpaca Options", accountType: "margin", broker: "alpaca" },
  { accountId: "PA-789", accountKey: "PA-789", accountDesc: "Alpaca Second Stock", accountName: "Alpaca Second Stock", accountType: "stock", broker: "alpaca" },
  { accountId: "ET-777", accountKey: "ET-777", accountDesc: "E*TRADE Brokerage", accountName: "E*TRADE Brokerage", accountType: "stock", broker: "etrade" },
];

const FULL_IDS = ["PA-123", "PA-456", "PA-789", "ET-777"];

function assertNoFullIds(value: unknown) {
  const json = JSON.stringify(value);
  for (const id of FULL_IDS) expect(json).not.toContain(id);
}

let mountedContainer: HTMLDivElement | null = null;

afterEach(() => {
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
});

function renderToolCard(toolType: string, data: any): string {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  const root = createRoot(mountedContainer);
  act(() => {
    root.render(React.createElement(ToolResultView, { toolType, data }));
  });
  return mountedContainer.innerHTML;
}

describe("Issue #5101 (F4 of #5094) — Chat-side account binding", () => {
  describe("resolveAccountByLabel (switch-by-label)", () => {
    it("resolves an exact label, case-insensitively, and a single substring label", () => {
      expect(resolveAccountByLabel({ accountName: "Alpaca Stock", availableAccounts: ENUMERATED })).toMatchObject({
        ok: true,
        account: { accountId: "PA-123" },
      });
      expect(resolveAccountByLabel({ accountName: "alpaca stock", availableAccounts: ENUMERATED })).toMatchObject({
        ok: true,
        account: { accountId: "PA-123" },
      });
      expect(resolveAccountByLabel({ accountName: "Second", availableAccounts: ENUMERATED })).toMatchObject({
        ok: true,
        account: { accountId: "PA-789" },
      });
    });

    it("refuses an ambiguous label with candidate names, and an unknown label", () => {
      const ambiguous = resolveAccountByLabel({ accountName: "Alpaca", availableAccounts: ENUMERATED });
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) {
        expect(ambiguous.code).toBe("FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS");
        expect(ambiguous.candidateNames).toEqual(["Alpaca Stock", "Alpaca Options", "Alpaca Second Stock"]);
        expect(ambiguous.error).toContain("Alpaca Stock");
      }

      const unknown = resolveAccountByLabel({ accountName: "Nope", availableAccounts: ENUMERATED });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.code).toBe("FAILURE_ACCOUNT_UNKNOWN");

      const empty = resolveAccountByLabel({ accountName: "  ", availableAccounts: ENUMERATED });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    });
  });

  describe("listBrokerAccountsForMode (shared with B1)", () => {
    it("enumerates through the injected enumerator", async () => {
      const env = {} as Env;
      const res = await listBrokerAccountsForMode(env, "trader@example.com", "alpaca", "paper", undefined, {
        enumerate: async () => ENUMERATED,
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.accounts).toHaveLength(4);
    });

    it("refuses an unknown broker, a broker without an account list, and an invalid mode by name", async () => {
      const env = {} as Env;
      const enumerate = async () => ENUMERATED;
      const unknownBroker = await listBrokerAccountsForMode(env, "trader@example.com", "nope", "paper", undefined, { enumerate });
      expect(unknownBroker.ok).toBe(false);
      if (!unknownBroker.ok) {
        expect(unknownBroker.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
        expect(unknownBroker.error).toContain("nope");
      }
      const noCapability = await listBrokerAccountsForMode(env, "trader@example.com", "ibkr", "live", undefined, { enumerate });
      expect(noCapability.ok).toBe(false);
      if (!noCapability.ok) {
        expect(noCapability.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
        expect(noCapability.error).toContain("ibkr");
      }
      const badMode = await listBrokerAccountsForMode(env, "trader@example.com", "alpaca", "sandbox", undefined, { enumerate });
      expect(badMode.ok).toBe(false);
      if (!badMode.ok) expect(badMode.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    });
  });

  describe("masking helpers", () => {
    it("masks a binding and a broker account, including accountKey", () => {
      const masked = maskAccountBinding({
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        accountId: "PA-123",
        accountName: "Alpaca Stock",
      });
      expect(masked.accountId).toBe(maskAccountId("PA-123"));
      expect(masked.maskedAccountId).toBe(maskAccountId("PA-123"));
      expect(masked.accountName).toBe("Alpaca Stock");

      const maskedAccount = maskBrokerAccount({
        accountId: "PA-123",
        accountKey: "PA-123",
        accountIdKey: "KEY-9",
        accountType: "stock",
      } as BrokerAccountRecordLike);
      expect(maskedAccount.accountId).toBe(maskAccountId("PA-123"));
      expect((maskedAccount as any).accountKey).toBe(maskAccountId("PA-123"));
      expect((maskedAccount as any).accountIdKey).toBe(maskAccountId("KEY-9"));
      expect(maskedAccount.maskedAccountId).toBe(maskAccountId("PA-123"));
    });
  });

  describe("bindingPromptLine (F4 steering)", () => {
    it("stays empty when unresolved, steers when unbound, names the masked account when bound", () => {
      expect(bindingPromptLine(undefined)).toBe("");
      const unbound = bindingPromptLine(null);
      expect(unbound).toMatch(/No account bound/);
      expect(unbound).toContain("broker_account_binding");
      expect(unbound).toContain("never ask for or state a full account id");

      const bound = bindingPromptLine({
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        accountId: "PA-123",
        accountName: "Alpaca Stock",
      });
      expect(bound).toMatch(/Bound account: stock/);
      expect(bound).toContain(maskAccountId("PA-123"));
      expect(bound).toContain("(Alpaca Stock)");
      expect(bound).toContain("broker_account_binding");
      expect(bound).not.toContain("PA-123");
    });
  });

  describe("NLQ planning fastpaths", () => {
    it("plans binding_show / binding_list / binding_switch with slots", () => {
      expect(planWithRules("which account am I using").tradingData).toMatchObject({ action: "binding_show" });
      expect(planWithRules("list my accounts").tradingData).toMatchObject({ action: "binding_list" });
      expect(planWithRules("show my Alpaca accounts").tradingData).toMatchObject({ action: "binding_list", broker: "alpaca" });
      expect(planWithRules("what accounts do I have").tradingData).toMatchObject({ action: "binding_list" });
      expect(planWithRules("switch to my IRA account").tradingData).toMatchObject({
        action: "binding_switch",
        accountName: "IRA",
      });
      expect(planWithRules("switch to my Alpaca paper account").tradingData).toMatchObject({
        action: "binding_switch",
        broker: "alpaca",
        mode: "paper",
      });
      expect(planWithRules("switch to my Alpaca paper account").tradingData?.accountName).toBeUndefined();
      expect(planWithRules("switch to my options account").tradingData).toMatchObject({
        action: "binding_switch",
        accountType: "options",
      });
    });

    it("does not steal positions questions", () => {
      expect(planWithRules("show my account balance").tradingData).toMatchObject({ action: "positions" });
      expect(planWithRules("show my positions").tradingData).toMatchObject({ action: "positions" });
    });
  });

  describe("NLQ execution (async core + sync refusal)", () => {
    let orm: DatabaseORM;
    let env: Env;
    const sessionId = "f4_test_trader";

    beforeEach(async () => {
      const sql = new MockSqlStorage();
      orm = new DatabaseORM(sql);
      orm.initializeSchema(sessionId);
      env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    });

    const plan = (tradingData: Record<string, unknown>): NLQPlan =>
      ({
        domain: "trading",
        operation: "list",
        tradingData,
        terms: "binding",
        role: "any",
        since: null,
        limit: 25,
      }) as unknown as NLQPlan;

    const deps = { accountEnumerator: async () => ENUMERATED };

    it("shows the bound account masked, and answers 'no account bound' when unbound", async () => {
      await upsertAccountBinding(env, sessionId, {
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        scope: "copilot",
        accountId: "PA-123",
      });
      const found = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_show", broker: "alpaca", mode: "paper" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(found.status).toBe("matches_found");
      expect(found.count).toBe(1);
      expect(found.summary).toContain(maskAccountId("PA-123"));
      assertNoFullIds(found);

      const unbound = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_show", broker: "etrade", mode: "live" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(unbound.status).toBe("info");
      expect(unbound.summary).toContain("No account bound");
    });

    it("asks for broker/mode when show names neither and the selection cannot be read", async () => {
      const res = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_show" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(res.status).toBe("error");
      expect(res.summary).toContain("broker and mode");
    });

    it("lists enumerated accounts masked, and stored bindings when no broker is named", async () => {
      const enumerated = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_list", broker: "alpaca", mode: "paper" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(enumerated.status).toBe("matches_found");
      expect(enumerated.count).toBe(4);
      expect(enumerated.summary).toContain(maskAccountId("PA-123"));
      assertNoFullIds(enumerated);

      await upsertAccountBinding(env, sessionId, {
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        scope: "tenant",
        accountId: "PA-123",
      });
      const stored = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_list" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(stored.status).toBe("matches_found");
      expect(stored.count).toBe(1);
      assertNoFullIds(stored);
    });

    it("switches by label and persists the copilot-scope binding", async () => {
      const res = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_switch", broker: "alpaca", mode: "paper", accountName: "Alpaca Options" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(res.status).toBe("matches_found");
      expect(res.summary).toContain(maskAccountId("PA-456"));
      assertNoFullIds(res);
      const stored = await listAccountBindings(env, sessionId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ broker: "alpaca", mode: "paper", scope: "copilot", accountId: "PA-456" });
    });

    it("switches by single candidate with no label, and asks when several match", async () => {
      // No label + E*TRADE paper: exactly one compatible account, so the
      // F1 single-candidate rule switches to it.
      const single = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_switch", broker: "etrade", mode: "paper" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(single.status).toBe("matches_found");
      expect(single.summary).toContain(maskAccountId("ET-777"));
      assertNoFullIds(single);

      // No label + Alpaca paper (stock default): two compatible stock
      // accounts, so the switch asks instead of guessing.
      const ambiguous = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_switch", broker: "alpaca", mode: "paper" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(ambiguous.status).toBe("error");
      expect(ambiguous.summary).toContain("FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS");
      assertNoFullIds(ambiguous);
    });

    it("refuses an ambiguous label switch with candidate names", async () => {
      const res = await executeNLQQueryAsync(
        orm,
        sessionId,
        plan({ action: "binding_switch", broker: "alpaca", mode: "paper", accountName: "Alpaca" }),
        env,
        sessionId,
        undefined,
        deps,
      );
      expect(res.status).toBe("error");
      expect(res.summary).toContain("FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS");
      expect(res.rows).toEqual(
        expect.arrayContaining([{ accountName: "Alpaca Stock" }, { accountName: "Alpaca Options" }]),
      );
      assertNoFullIds(res);
    });

    it("refuses binding intents in the sync executor (#923 pattern)", () => {
      const res = executeNLQQuery(orm, sessionId, plan({ action: "binding_show", broker: "alpaca", mode: "paper" }), env);
      expect(res.status).toBe("error");
      expect(res.summary).toContain("asynchronous NLQ executor");
    });
  });

  describe("client bridge + binding card", () => {
    it("detects a broker_account_binding set-success part and nothing else", () => {
      const switched = {
        role: "assistant",
        id: "m1",
        parts: [
          {
            type: "tool",
            toolInvocation: {
              toolName: "tool_openaimp_broker_account_binding",
              result: { ok: true, action: "set", binding: { accountId: maskAccountId("PA-123") } },
            },
          },
        ],
      };
      expect(messageHasBindingSwitch(switched)).toBe(true);
      expect(
        messageHasBindingSwitch({
          role: "assistant",
          id: "m2",
          parts: [{ toolName: "broker_account_binding", result: { ok: false, action: "set" } }],
        }),
      ).toBe(false);
      expect(
        messageHasBindingSwitch({
          role: "assistant",
          id: "m3",
          parts: [{ toolName: "broker_account_binding", result: { ok: true, action: "list" } }],
        }),
      ).toBe(false);
      expect(messageHasBindingSwitch({ role: "user", id: "m4", parts: [] })).toBe(false);
      expect(
        messageHasBindingSwitch({
          role: "assistant",
          id: "m5",
          parts: [{ toolName: "tool_openaimp_etrade_get_quote", result: { ok: true } }],
        }),
      ).toBe(false);
    });

    it("renders a masked binding card, never a full id", () => {
      const html = renderToolCard("broker_account_binding", {
        ok: true,
        action: "set",
        binding: maskAccountBinding({
          broker: "alpaca",
          mode: "paper",
          accountType: "stock",
          accountId: "PA-123",
          accountName: "Alpaca Stock",
        }),
        maskedAccountId: maskAccountId("PA-123"),
      });
      expect(html).toContain("Account Binding Switched");
      expect(html).toContain("Alpaca Stock");
      expect(html).toContain(maskAccountId("PA-123"));
      expect(html).not.toContain("PA-123");

      const failed = renderToolCard("broker_account_binding", {
        ok: false,
        action: "set",
        code: "FAILURE_ACCOUNT_UNKNOWN",
        error: "[FAILURE_ACCOUNT_UNKNOWN] No account named \"Nope\" was found.",
      });
      expect(failed).toContain("Failed");
      expect(failed).toContain("FAILURE_ACCOUNT_UNKNOWN");
    });
  });
});
