import { describe, expect, it } from "vitest";
import { getTenantAccountBinding, upsertAccountBinding } from "../src/services/accountBindings";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") return Response.json({ ok: true, value: store.get(payload.key) ?? null });
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

describe("Issue #5983 — OODA account binding context", () => {
  it("resolves only the exact tenant broker, mode, and account type tuple", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await upsertAccountBinding(env, "trader@example.com", {
      broker: "alpaca", mode: "paper", accountType: "options", scope: "tenant", accountId: "PAPER-1234",
    });
    await upsertAccountBinding(env, "trader@example.com", {
      broker: "etrade", mode: "paper", accountType: "options", scope: "tenant", accountId: "ETRADE-9999",
    });

    expect(await getTenantAccountBinding(env, "trader@example.com", {
      broker: "alpaca", mode: "paper", accountType: "options",
    })).toMatchObject({ accountId: "PAPER-1234", broker: "alpaca", mode: "paper" });
    expect(await getTenantAccountBinding(env, "trader@example.com", {
      broker: "alpaca", mode: "live", accountType: "options",
    })).toBeNull();
    expect(await getTenantAccountBinding(env, "trader@example.com", {
      broker: "public", mode: "paper", accountType: "options",
    })).toBeNull();
    expect(await getTenantAccountBinding(env, "trader@example.com", {
      broker: "alpaca", mode: "paper", accountType: "stock",
    })).toBeNull();
  });
});
