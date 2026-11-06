/**
 * #1185 Phase A — explicit service identity for unattended work (#1066).
 *
 * Pins:
 *  - getServiceUserLogin resolves the owner-configured SERVICE_USER_LOGIN
 *    (trimmed, login-shaped) and returns null when unset / blank / invalid
 *    — absence fails closed, never a hardcoded fallback.
 *  - The worker scheduled() handler dispatches its identity-bearing ticks
 *    (research / reflection / adaptation) under the service identity,
 *    addressed to the shared Orchestrator instance (an address, not an
 *    identity), and skips those dispatches entirely when no service
 *    identity is configured. #2331 slice 2 adds the second half of
 *    that gate: configuration alone is not enough — the tick and the
 *    dispatches run only while the service user holds a live
 *    platform-tier member binding.
 *  - The worker queue() handler dispatches options-analysis work under
 *    the queue payload's stored owner when present, else the service
 *    identity, and retries (never acks, never dispatches) when neither
 *    exists.
 *  - Source pin: src/server.ts contains no `default_trader` literal.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import {
  getServiceUserLogin,
  SHARED_ORCHESTRATOR_INSTANCE,
} from "../src/security/serviceIdentity";
import type { Env } from "../src/types";
import { makeFakeSessionStore } from "./fake-session-store";

const SERVICE_LOGIN = "svc-background";

function fakeAgentNamespace() {
  const addressedTo: string[] = [];
  const requests: Request[] = [];
  const stub = {
    fetch: async (req: Request) => {
      requests.push(req);
      return new Response("ok");
    },
  };
  const ns = {
    idFromName: (name: string) => {
      addressedTo.push(name);
      return name;
    },
    get: (_id: unknown) => stub,
  };
  return { ns, addressedTo, requests };
}

function fakeEnv(serviceLogin?: string, opts: { provisioned?: boolean } = {}) {
  const search = fakeAgentNamespace();
  const scheduledAgent = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({ onCron: async () => ({}) }),
  };
  const { namespace, seed } = makeFakeSessionStore();
  // #2331 slice 2: Worker dispatches run only while the service user
  // holds a live platform-tier member binding. The dispatch tests seed
  // one; the denial tests opt out with provisioned: false.
  if (serviceLogin !== undefined && opts.provisioned !== false) {
    seed("sessions", "iaaa-membership:m-svc-1", {
      membershipId: "m-svc-1",
      internalUserId: `service:${serviceLogin}`,
      tenantId: "primary",
      roleBindings: [{ role: "member", scope: "platform", grantedBy: "test" }],
      createdBy: "test",
      createdAtMs: Date.now() - 1000,
    });
    seed("sessions", `iaaa-membership:user:service:${serviceLogin}`, ["m-svc-1"]);
  }
  const env = {
    ORCHESTRATOR_AGENT: search.ns,
    SCHEDULED_AGENT: scheduledAgent,
    SESSION_STORE: namespace,
    ...(serviceLogin !== undefined ? { SERVICE_USER_LOGIN: serviceLogin } : {}),
  } as unknown as Env;
  return { env, search };
}

describe("getServiceUserLogin (#1185)", () => {
  it("returns the configured service identity, trimmed", () => {
    expect(getServiceUserLogin({ SERVICE_USER_LOGIN: "  svc-background  " } as Env)).toBe(SERVICE_LOGIN);
  });

  it("returns null when unset, blank, or not login-shaped (fail closed)", () => {
    expect(getServiceUserLogin({} as Env)).toBeNull();
    expect(getServiceUserLogin({ SERVICE_USER_LOGIN: "   " } as Env)).toBeNull();
    expect(getServiceUserLogin({ SERVICE_USER_LOGIN: "not a login!" } as Env)).toBeNull();
  });
});

describe("worker scheduled() (#1185)", () => {
  it("dispatches the 30-minute ticks under the service identity, addressed to the shared instance", async () => {
    const { env, search } = fakeEnv(SERVICE_LOGIN);
    await (worker as any).scheduled({ cron: "*/30 * * * *" }, env, undefined);
    expect(search.addressedTo).toEqual([SHARED_ORCHESTRATOR_INSTANCE]);
    expect(search.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/research/scheduled-tick",
      "/reflection/run",
      "/adaptation/weights/run",
      // Issue #1169 (S4-4): the weekly corpus sync rides this tick.
      "/knowledge/corpus-sync",
      // Issue #2659 (Phase 2.4): the scheduled digest pass rides this tick.
      "/payments/agentic/commercial/lifecycle/digest/run-due",
    ]);
    for (const req of search.requests) {
      expect(req.headers.get("x-user-login")).toBe(SERVICE_LOGIN);
    }
  });

  it("skips the tick and the identity-bearing dispatches when the service user is unprovisioned (#2331 slice 2)", async () => {
    const { env, search } = fakeEnv(SERVICE_LOGIN, { provisioned: false });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await (worker as any).scheduled({ cron: "*/30 * * * *" }, env, undefined);
      expect(search.requests).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("skips the identity-bearing dispatches when no service identity is configured", async () => {
    const { env, search } = fakeEnv(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await (worker as any).scheduled({ cron: "*/30 * * * *" }, env, undefined);
      expect(search.requests).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("worker queue() (#1185)", () => {
  function batchWith(payload: unknown) {
    const state = { acked: 0, retried: 0 };
    const batch = {
      messages: [
        {
          body: { taskType: "options_analysis", payload },
          ack: () => { state.acked++; },
          retry: () => { state.retried++; },
        },
      ],
    };
    return { batch, state };
  }

  it("dispatches under the payload's stored owner when present", async () => {
    const { env, search } = fakeEnv(SERVICE_LOGIN);
    const { batch, state } = batchWith({ userLogin: "owner-a", symbol: "AAPL" });
    await (worker as any).queue(batch, env, undefined);
    expect(state.acked).toBe(1);
    expect(search.requests).toHaveLength(1);
    expect(search.requests[0].headers.get("x-user-login")).toBe("owner-a");
  });

  it("falls back to the service identity when the payload carries no owner", async () => {
    const { env, search } = fakeEnv(SERVICE_LOGIN);
    const { batch, state } = batchWith({ symbol: "AAPL" });
    await (worker as any).queue(batch, env, undefined);
    expect(state.acked).toBe(1);
    expect(search.requests[0].headers.get("x-user-login")).toBe(SERVICE_LOGIN);
  });

  it("drops (acks, never retries) an ownerless message when the service user is unprovisioned (#2331 slice 2)", async () => {
    const { env, search } = fakeEnv(SERVICE_LOGIN, { provisioned: false });
    const { batch, state } = batchWith({ symbol: "AAPL" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (worker as any).queue(batch, env, undefined);
      expect(search.requests).toHaveLength(0);
      expect(state.acked).toBe(1);
      expect(state.retried).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("retries without dispatching when neither owner nor service identity exists", async () => {
    const { env, search } = fakeEnv(undefined);
    const { batch, state } = batchWith({ symbol: "AAPL" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (worker as any).queue(batch, env, undefined);
      expect(search.requests).toHaveLength(0);
      expect(state.acked).toBe(0);
      expect(state.retried).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("source pin (#1185)", () => {
  it("src/server.ts contains no default_trader literal", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "../src/server.ts"), "utf8");
    expect(source).not.toContain("default_trader");
  });
});
