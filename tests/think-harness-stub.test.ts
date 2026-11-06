/**
 * Issue #2003 (tracker #1951) — proof for the test-only Node stub
 * alias that fully replaces bare "@cloudflare/think" in tests.
 *
 * Before this slice, importing src/actors/thinkAdapter.ts under Node
 * vitest failed at load with 0 tests: the real Think graph reaches
 * `cloudflare:` imports the Node ESM loader rejects. With the vite
 * test alias pointing at tests/stubs/cloudflareThink.ts, the adapter
 * loads, a PortThink subclass constructs with a fake ctx/env, and
 * non-turn code runs — while any real turn attempt throws loudly
 * instead of returning a faked result (turn proof stays workerd).
 */
import { describe, expect, it } from "vitest";
import { PortThink } from "../src/actors/thinkAdapter";
import { ThinkWorkflow } from "@cloudflare/think/workflows";

class ProbeThink extends PortThink {
  getCtx(): unknown {
    return (this as unknown as { ctx: unknown }).ctx;
  }
  getEnv(): unknown {
    return (this as unknown as { env: unknown }).env;
  }
}

describe("think harness stub (issue #2003)", () => {
  it("loads thinkAdapter under Node vitest (previously a 0-test load failure)", () => {
    expect(typeof PortThink).toBe("function");
  });

  it("constructs a PortThink subclass with the fake ctx/env preserved", () => {
    const fakeCtx = { storage: { get: async () => null } };
    const fakeEnv = { MARKER: "harness-env" };
    const probe = new ProbeThink(fakeCtx as never, fakeEnv as never);
    expect(probe.getCtx()).toBe(fakeCtx);
    expect(probe.getEnv()).toBe(fakeEnv);
  });

  it("lifecycle.start() is a no-op under the stub", async () => {
    const probe = new ProbeThink({} as never, {} as never);
    await expect(
      (probe as unknown as { lifecycle: { start: () => Promise<unknown> } }).lifecycle.start()
    ).resolves.toBeUndefined();
  });

  it("a turn attempt throws loudly instead of faking a result", async () => {
    const probe = new ProbeThink({} as never, {} as never);
    await expect(
      (probe as unknown as { runTurn: (input: unknown) => Promise<unknown> }).runTurn({
        input: [],
        mode: "wait",
      })
    ).rejects.toThrow(/Think stub: runTurn\(\) is not implemented under Node tests/);
  });

  it("the workflows subpath alias is not shadowed by the bare alias", () => {
    // If the bare alias swallowed "@cloudflare/think/workflows",
    // this import would resolve to the Think stub (no ThinkWorkflow).
    expect(typeof ThinkWorkflow).toBe("function");
  });
});

describe("think harness stub — request/state seams (issue #3474)", () => {
  // The PortThink webhook channel (#3474) is wired at fetch — the
  // Durable Object entry — and its hooks end in setState. To keep
  // that port behavior testable under Node, the stub mirrors the
  // base Agent's three seams faithfully but minimally: fetch
  // dispatches to onRequest (the SDK funnel), the default onRequest
  // answers 404 (the base Agent default), and setState stores the
  // state and records the broadcast the real Agent sends to its
  // connected clients. Turns still throw (see the suite above).
  it("fetch dispatches to the instance's onRequest, most-derived first", async () => {
    class Router extends PortThink {
      async onRequest(_request: Request): Promise<Response> {
        return new Response("routed", { status: 200 });
      }
    }
    const agent = new Router({} as never, {} as never);
    const res = await agent.fetch(new Request("https://agent.internal/anything"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("routed");
  });

  it("the default onRequest answers 404, like the base Agent", async () => {
    const probe = new ProbeThink({} as never, {} as never);
    const res = await probe.fetch(new Request("https://agent.internal/anything"));
    expect(res.status).toBe(404);
  });

  it("setState stores the state and records the broadcast", () => {
    const probe = new ProbeThink({} as never, {} as never) as unknown as {
      state: unknown;
      setState(next: unknown): void;
      stateBroadcasts: unknown[];
    };
    probe.setState({ ready: true });
    expect(probe.state).toEqual({ ready: true });
    expect(probe.stateBroadcasts).toEqual([{ ready: true }]);
    probe.setState({ ready: false });
    expect(probe.state).toEqual({ ready: false });
    expect(probe.stateBroadcasts).toEqual([{ ready: true }, { ready: false }]);
  });
});
