import { describe, it, expect, vi, afterEach } from "vitest";
import { actorGateway, createActorGateway } from "../src/services/cloudflareActorGateway";
import type {
  ActorGateway,
  PaymentsAgentStub,
} from "../src/services/actorGatewayPorts";
import { resolveScreenerAgentName } from "../src/agents/screenerAgentName";
import { fetchScreenerPdf } from "../src/events/screenerPublishers";
import type { Env } from "../src/types";

/**
 * #1779 (Adapter S5, program #1717): one ActorGateway port — DO
 * dispatch + RPC behind one interface. Before S5, route/service code
 * called `namespace.idFromName` / `idFromString` + `get` (+ `fetch`
 * or an RPC method) inline at 35+ sites. After S5 every such site
 * goes through this port and the Cloudflare implementation here is
 * the ONLY module that calls `idFromName`/`idFromString`/`get` for
 * actor dispatch. Behavior is preserved exactly: dispatch still
 * resolves the same instance name through the same namespace object
 * (so existing namespace mocks keep working), and a missing binding
 * still fails loud — with a named ActorGateway error instead of a
 * bare TypeError.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeNamespace() {
  const calls: string[] = [];
  const stub = {
    fetch: vi.fn(async (req: Request) => new Response("dispatched", { status: 200 })),
    budgetCheck: vi.fn(async (req: { operation: string; amountCents: number; agentId: string }) => ({
      allowed: req.amountCents <= 1000,
      reason: req.amountCents <= 1000 ? "ok" : "over",
    })),
    getPdfByKey: vi.fn(async (key: string) => ({ bytes: new Uint8Array([1, 2]), fileName: `${key}.pdf` })),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => {
      calls.push(`idFromName:${name}`);
      return `id:${name}`;
    }),
    idFromString: vi.fn((id: string) => {
      calls.push(`idFromString:${id}`);
      return `sid:${id}`;
    }),
    get: vi.fn((id: unknown) => {
      calls.push(`get:${String(id)}`);
      return stub;
    }),
  };
  return { calls, stub, namespace };
}

describe("ActorGateway port (S5)", () => {
  it("createActorGateway returns a gateway; the shared actorGateway is one", () => {
    const gateway: ActorGateway = createActorGateway();
    expect(gateway).not.toBeNull();
    expect(actorGateway).not.toBeNull();
    expect(typeof actorGateway.dispatch).toBe("function");
    expect(typeof actorGateway.stub).toBe("function");
    expect(typeof actorGateway.address).toBe("function");
    expect(typeof actorGateway.paymentsStub).toBe("function");
  });

  it("address resolves through idFromName on the same namespace object", () => {
    const fake = fakeNamespace();
    const gateway = createActorGateway();
    expect(gateway.address(fake.namespace, "alice")).toBe("id:alice");
    expect(fake.calls).toEqual(["idFromName:alice"]);
  });

  it("addressFromId resolves through idFromString", () => {
    const fake = fakeNamespace();
    const gateway = createActorGateway();
    expect(gateway.addressFromId(fake.namespace, "owner-1")).toBe("sid:owner-1");
    expect(fake.calls).toEqual(["idFromString:owner-1"]);
  });

  it("dispatch fetches through the stub for the named instance, request unchanged", async () => {
    const fake = fakeNamespace();
    const gateway = createActorGateway();
    const req = new Request("https://agent.internal/nlq", { method: "POST", body: "{}" });
    const res = await gateway.dispatch(fake.namespace, "alice", req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dispatched");
    expect(fake.calls).toEqual(["idFromName:alice", "get:id:alice"]);
    expect(fake.stub.fetch).toHaveBeenCalledTimes(1);
    expect(fake.stub.fetch.mock.calls[0][0]).toBe(req);
  });

  it("dispatchFromId fetches through the idFromString-resolved stub", async () => {
    const fake = fakeNamespace();
    const gateway = createActorGateway();
    const req = new Request("https://agent.internal/payments/webhook", { method: "POST" });
    const res = await gateway.dispatchFromId(fake.namespace, "owner-1", req);
    expect(res.status).toBe(200);
    expect(fake.calls).toEqual(["idFromString:owner-1", "get:sid:owner-1"]);
  });

  it("stub returns the namespace stub for typed RPC access", () => {
    const fake = fakeNamespace();
    const gateway = createActorGateway();
    const stub = gateway.stub<{ marker: number }>(fake.namespace, "bob");
    expect(stub).toBe(fake.stub);
    expect(fake.calls).toEqual(["idFromName:bob", "get:id:bob"]);
  });

  it("paymentsStub resolves the default instance and passes budgetCheck through", async () => {
    const fake = fakeNamespace();
    const gateway = createActorGateway();
    const payments: PaymentsAgentStub = gateway.paymentsStub(fake.namespace);
    const ok = await payments.budgetCheck({ operation: "run", amountCents: 500, agentId: "orchestrator" });
    expect(ok).toEqual({ allowed: true, reason: "ok" });
    const denied = await payments.budgetCheck({ operation: "run", amountCents: 5000, agentId: "orchestrator" });
    expect(denied.allowed).toBe(false);
    expect(fake.calls).toEqual(["idFromName:default", "get:id:default"]);
  });

  it("a missing namespace fails loud with a named ActorGateway error", () => {
    const gateway = createActorGateway();
    expect(() => gateway.address(undefined as never, "alice")).toThrow(/ActorGateway/);
    expect(() => gateway.stub(undefined as never, "alice")).toThrow(/ActorGateway/);
    expect(() => gateway.address({} as never, "alice")).toThrow(/ActorGateway/);
  });

  it("addressFromId fails loud when the namespace has no idFromString", () => {
    const gateway = createActorGateway();
    const noString = { idFromName: (n: string) => n, get: (id: unknown) => ({}) };
    expect(() => gateway.addressFromId(noString as never, "owner-1")).toThrow(/ActorGateway/);
  });
});

describe("getScreenerAgent dedup (S5): one shared naming rule", () => {
  it("service login maps to default, any other login to screener:<login>", () => {
    const env = { SERVICE_USER_LOGIN: "svc" } as unknown as Env;
    expect(resolveScreenerAgentName(env, "svc")).toBe("default");
    expect(resolveScreenerAgentName(env, "alice")).toBe("screener:alice");
    expect(resolveScreenerAgentName(env, undefined)).toBe("default");
  });

  it("fails closed when neither a login nor a service identity exists", () => {
    const env = {} as unknown as Env;
    expect(() => resolveScreenerAgentName(env, undefined)).toThrow(/1185/);
  });
});

describe("fetchScreenerPdf through the gateway (S5)", () => {
  it("fetches the PDF from the per-owner screener instance", async () => {
    const fake = fakeNamespace();
    const env = { SCREENER_AGENT: fake.namespace } as unknown as Env;
    const pdf = await fetchScreenerPdf({ env, userLogin: "alice" }, "run-1", "generated");
    expect(pdf).toEqual({ bytes: new Uint8Array([1, 2]), fileName: "run-1.pdf" });
    expect(fake.calls).toContain("idFromName:screener:alice");
    expect(fake.stub.getPdfByKey).toHaveBeenCalledWith("run-1");
  });

  it("routes the service identity to the default instance", async () => {
    const fake = fakeNamespace();
    const env = { SERVICE_USER_LOGIN: "svc", SCREENER_AGENT: fake.namespace } as unknown as Env;
    const pdf = await fetchScreenerPdf({ env, userLogin: "svc" }, "run-2", "generated");
    expect(pdf).not.toBeNull();
    expect(fake.calls).toContain("idFromName:default");
  });

  it("missing SCREENER_AGENT binding still returns null, never throws", async () => {
    const env = {} as unknown as Env;
    const pdf = await fetchScreenerPdf({ env, userLogin: "alice" }, "run-1", "generated");
    expect(pdf).toBeNull();
  });
});
