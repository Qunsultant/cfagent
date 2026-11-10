/**
 * Issue #3923 (follow-on of #3741) — state-off enforcement at
 * consumers: the requires-edge refusals #3741 modelled on the
 * capability manifest (`capability_requires_state:<id>`) are now
 * ACTED on at the shared composition choke points of the PortThink
 * base, so every subclass inherits the enforcement:
 *
 *  - scheduler arming funnels through the base's `schedule` /
 *    `scheduleEvery` overrides (the ActorSchedulePort facets, the
 *    classes' inline facets and direct calls, and Think's own
 *    declared-task arming all delegate to these two methods);
 *  - workspace work funnels through the base's `workspacePort`
 *    (the turn tool builder, the /workspace HTTP channel, and the
 *    actor-port facet all consume that one port), and the HTTP
 *    channel refuses in its own idiom (403 JSON naming the refusal);
 *  - the payments work-start on PaymentsAgent
 *    (`processPaidRequest`, which the A2A surface also funnels
 *    through) asserts servability in its own throw idiom.
 *
 * State OFF therefore means fully ephemeral on the enforced paths:
 * a state-refused work-start refuses BY NAME before any storage is
 * touched, and stateless work (web tools, turns) runs with zero
 * Durable Object storage contact. Production posture
 * (AGENT_CAPABILITIES_DISABLED empty) carries no refusals and every
 * path delegates unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PortThink } from "../src/actors/thinkAdapter";
import { PaymentsAgent as RealPaymentsAgent } from "../src/agents/payments-agent";

/**
 * The test stub for the Think base (tests/stubs/cloudflareThink.ts)
 * records every schedule/scheduleEvery call that reaches the SDK
 * base in `scheduleCalls` — the seam at which delegation (or its
 * absence) is proven, exactly like its `stateBroadcasts` seam.
 */
interface ScheduleCall {
  kind: "once" | "every";
  when: unknown;
  callback: unknown;
  payload: unknown;
}
function scheduleCallsOf(agent: PortThink): ScheduleCall[] {
  return ((agent as unknown as { scheduleCalls?: ScheduleCall[] }).scheduleCalls ?? []).slice();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const STATE_OFF_ENV = { AGENT_CAPABILITIES_DISABLED: "*:state" };
const PRODUCTION_ENV = { AGENT_CAPABILITIES_DISABLED: "" };

/** A DO-storage spy: every contact is counted, writes doubly so. */
function spyCtx() {
  const calls = { get: 0, put: 0, delete: 0, sql: 0 };
  const storage = {
    get: async () => {
      calls.get++;
      return null;
    },
    put: async () => {
      calls.put++;
    },
    delete: async () => {
      calls.delete++;
      return true;
    },
    sql: {
      exec: () => {
        calls.sql++;
        return [];
      },
    },
  };
  return { ctx: { storage }, calls };
}

function totalCalls(calls: { get: number; put: number; delete: number; sql: number }) {
  return calls.get + calls.put + calls.delete + calls.sql;
}

/** Fleet-default posture: scheduler + workspace enabled, both require state. */
class ResearchAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
  }
}

/**
 * The posture whose payments entry is enabled (and requires
 * state). The manifest posture is keyed by class NAME, so this
 * local double — literally named PaymentsAgent — carries the real
 * class's capability record without its domain surface. (The real
 * class is imported above as RealPaymentsAgent.)
 */
class PaymentsAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
  }
}

describe("#3923 state-off enforcement — scheduler arming refuses by name", () => {
  it("schedule() and scheduleEvery() throw capability_requires_state:scheduler before delegating", async () => {
    const { ctx, calls } = spyCtx();
    const agent = new ResearchAgent(ctx, STATE_OFF_ENV);
    const baseline = totalCalls(calls);

    await expect(
      (async () => agent.schedule(60, "tick" as never))(),
    ).rejects.toMatchObject({
      code: "capability_requires_state:scheduler",
    });
    await expect(
      (async () => agent.scheduleEvery(60, "tick" as never))(),
    ).rejects.toMatchObject({
      code: "capability_requires_state:scheduler",
    });
    // The refusal fires before the SDK arming (and its DO writes):
    // the base recorded no arming, and storage was never touched.
    expect(scheduleCallsOf(agent)).toEqual([]);
    expect(totalCalls(calls)).toBe(baseline);
  });

  it("the ActorSchedulePort facet inherits the refusal (it delegates to agent.schedule)", async () => {
    const { createCfActorSchedule } = await import("../src/actors/cfAgentsAdapter");
    const { ctx } = spyCtx();
    const agent = new ResearchAgent(ctx, STATE_OFF_ENV);
    const port = createCfActorSchedule(
      agent as unknown as Parameters<typeof createCfActorSchedule>[0],
    );
    await expect(port.schedule(60, "tick", undefined)).rejects.toMatchObject({
      code: "capability_requires_state:scheduler",
    });
    await expect(port.scheduleEvery(60, "tick", undefined)).rejects.toMatchObject({
      code: "capability_requires_state:scheduler",
    });
  });
});

describe("#3923 state-off enforcement — workspace refuses by name, zero storage contact", () => {
  it("every workspacePort method refuses before touching storage", async () => {
    const { ctx, calls } = spyCtx();
    const agent = new ResearchAgent(ctx, STATE_OFF_ENV);
    const baseline = totalCalls(calls);

    await expect(agent.workspacePort.writeFile("/workspace/a.md", "x")).rejects.toMatchObject({
      code: "capability_requires_state:workspace",
    });
    await expect(agent.workspacePort.readFile("/workspace/a.md")).rejects.toMatchObject({
      code: "capability_requires_state:workspace",
    });
    await expect(agent.workspacePort.listFiles("/workspace")).rejects.toMatchObject({
      code: "capability_requires_state:workspace",
    });
    await expect(agent.workspacePort.deleteFile("/workspace/a.md")).rejects.toMatchObject({
      code: "capability_requires_state:workspace",
    });
    expect(totalCalls(calls)).toBe(baseline);
  });

  it("the workspace turn tools still compose, and their executes refuse by name", async () => {
    const { ctx, calls } = spyCtx();
    const agent = new ResearchAgent(ctx, STATE_OFF_ENV);
    const baseline = totalCalls(calls);
    const tools = agent.getPortWorkspaceTools() as Record<string, any>;
    // workspace is ENABLED for the class — composition does not
    // silently withdraw it; the refusal lands at the work-start.
    expect(Object.keys(tools).sort()).toEqual([
      "workspace_delete_file",
      "workspace_list_files",
      "workspace_read_file",
      "workspace_write_file",
    ]);
    await expect(
      tools.workspace_write_file.execute({ path: "/workspace/a.md", content: "x" }),
    ).rejects.toMatchObject({ code: "capability_requires_state:workspace" });
    await expect(
      tools.workspace_read_file.execute({ path: "/workspace/a.md" }),
    ).rejects.toMatchObject({ code: "capability_requires_state:workspace" });
    expect(totalCalls(calls)).toBe(baseline);
  });

  it("the /workspace HTTP channel refuses 403 naming the refusal", async () => {
    const { ctx, calls } = spyCtx();
    const agent = new ResearchAgent(ctx, STATE_OFF_ENV);
    const baseline = totalCalls(calls);
    const res = await agent.fetch(
      new Request("https://agent.openaimp.com/agents/research-agent/i1/workspace/file", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "someone" },
        body: JSON.stringify({ path: "/workspace/a.md", content: "x" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("capability_requires_state:workspace");
    expect(totalCalls(calls)).toBe(baseline);
  });
});

describe("#3923 state-off enforcement — payments work-start refuses by name", () => {
  it("the base primitive names the payments refusal for a payments-enabled class", () => {
    const { ctx } = spyCtx();
    const agent = new PaymentsAgent(ctx, STATE_OFF_ENV);
    expect(agent.portCapabilityRefusal("payments")).toBe("capability_requires_state:payments");
    expect(() => agent.assertPortCapabilityServable("payments")).toThrowError(
      expect.objectContaining({ code: "capability_requires_state:payments" }),
    );
    // A capability the class does not serve carries no refusal.
    expect(agent.portCapabilityRefusal("browser")).toBeUndefined();
  });

  it("PaymentsAgent.processPaidRequest refuses before any guard/ledger work", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network must not be reached");
    });
    const { ctx } = spyCtx();
    const agent = new RealPaymentsAgent(ctx as never, STATE_OFF_ENV as never);
    await expect(
      agent.processPaidRequest({
        agentId: "agent-1",
        operation: "search.query",
        amountCents: 10,
        idempotencyKey: "k-1",
        paymentProof: "proof",
      }),
    ).rejects.toMatchObject({ code: "capability_requires_state:payments" });
  });
});

describe("#3923 state-off — stateless work runs fully ephemeral", () => {
  it("web tools compose and run with zero storage contact under state-off", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("plain body", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const { ctx, calls } = spyCtx();
    // WEB_SEARCH_PROVIDERS: "" — since #3935 the default chain always
    // includes keyless DuckDuckGo, so an explicitly empty provider list
    // is the not-configured state this test asserts against.
    const agent = new ResearchAgent(ctx, { ...STATE_OFF_ENV, WEB_SEARCH_PROVIDERS: "" });
    const baseline = totalCalls(calls);

    const tools = agent.getPortWebTools() as Record<string, any>;
    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
    const fetched = await tools.web_fetch.execute({ url: "https://example.com/a" });
    expect(fetched.status).toBe(200);
    // web_search fails loud on its own named prerequisite — a
    // stateless refusal, not a state one — still zero storage.
    const searched = await tools.web_search.execute({ query: "aapl" });
    expect(searched).toMatchObject({ ok: false, error: "web_search_provider_not_configured" });
    expect(totalCalls(calls)).toBe(baseline);
  });
});

describe("#3923 production posture — no refusals, behavior unchanged", () => {
  it("schedule() and scheduleEvery() delegate to the SDK unchanged", async () => {
    const { ctx } = spyCtx();
    const agent = new ResearchAgent(ctx, PRODUCTION_ENV);

    await expect(agent.schedule(60, "tick" as never)).resolves.toMatchObject({
      id: "stub-schedule-1",
    });
    await expect(agent.scheduleEvery(30, "tick" as never)).resolves.toMatchObject({
      id: "stub-schedule-2",
    });
    // Both armings reached the SDK base with their arguments intact.
    const armed = scheduleCallsOf(agent);
    expect(armed).toHaveLength(2);
    expect(armed[0]).toMatchObject({ kind: "once", when: 60, callback: "tick" });
    expect(armed[1]).toMatchObject({ kind: "every", when: 30, callback: "tick" });
    expect(agent.portCapabilityRefusal("scheduler")).toBeUndefined();
  });

  it("workspace round-trips through the channel exactly as before", async () => {
    const { ctx } = spyCtx();
    const agent = new ResearchAgent(ctx, PRODUCTION_ENV);
    const writeRes = await agent.fetch(
      new Request("https://agent.openaimp.com/agents/research-agent/i1/workspace/file", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "someone" },
        body: JSON.stringify({ path: "/workspace/notes.md", content: "# hi\n" }),
      }),
    );
    expect(writeRes.status).toBe(200);
    const listRes = await agent.fetch(
      new Request("https://agent.openaimp.com/agents/research-agent/i1/workspace/files", {
        headers: { "x-user-login": "someone" },
      }),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { count: number };
    expect(list.count).toBe(1);
  });

  it("PaymentsAgent.processPaidRequest is not refused by the state gate in production posture", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ledger unreachable (expected in this harness)");
    });
    const { ctx } = spyCtx();
    const agent = new RealPaymentsAgent(ctx as never, PRODUCTION_ENV as never);
    const err = await agent
      .processPaidRequest({
        agentId: "agent-1",
        operation: "search.query",
        amountCents: 10,
        idempotencyKey: "k-1",
        paymentProof: "proof",
      })
      .catch((e: unknown) => e);
    // It proceeds past the state gate and fails on the (stubbed)
    // ledger reach — never with the state refusal.
    expect((err as { code?: string }).code).not.toBe("capability_requires_state:payments");
  });
});
