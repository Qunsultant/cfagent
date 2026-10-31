/**
 * Issue #2041 S2 — journey-gate module: copy, Slack payload,
 * decision parsing, delivery, instance ids, audit-stub reads,
 * and Slack post/edit.
 *
 * Pure unit tests with fakes: no worker runtime, no Think
 * runtime, no network (Slack fetch is stubbed per test).
 *
 * Invariants pinned here:
 * - the gate copy states ENTERING the trading leg, NOT trade
 *   approval, and repeats the rail's compensation policy
 *   (G-DISCLOSURE gate copy);
 * - Slack buttons carry the saga id and the ruled action ids;
 * - parse validates every field (including sagaId — the flow
 *   refuses events without it) and returns the full decision;
 * - delivery sends the exact event payload (with sagaId), reports
 *   superseded for a complete instance, and throws fail-loud
 *   for a missing binding or a missing sendEvent;
 * - instance ids are deterministic, sanitized, and under the
 *   100-character ceiling (S4 entry-route contract);
 * - pending-gate reads are prompted-minus-decided, user-scoped,
 *   and skip malformed rows; decided reads name the winner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAGA_JOURNEY_APPROVE_ACTION,
  SAGA_JOURNEY_DENY_ACTION,
  buildJourneyGatePrompt,
  buildSlackJourneyPrompt,
  deliverJourneyDecision,
  editSlackJourneyPrompt,
  findDecidedJourneyGate,
  journeyGateCopy,
  listPendingJourneyGates,
  parseJourneyDecision,
  postSlackJourneyPrompt,
  sagaWorkflowInstanceId,
  type AuditOwnerStub,
} from "../src/workflows/sagaJourneyGate";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("journey gate copy (S2, #2041, G-DISCLOSURE)", () => {
  it("states leg entry, not trade approval, for every rail", () => {
    for (const rail of [undefined, "stripe", "x402"] as const) {
      const copy = journeyGateCopy(rail);
      expect(copy.title).toBe("Enter the trading leg?");
      expect(copy.body).toContain("ENTERING the trading leg");
      expect(copy.body).toContain("NOT approval of any trade");
      expect(copy.body).toContain("its own per-order approval");
    }
  });

  it("is unmistakable from per-order trade approval copy", () => {
    const copy = journeyGateCopy("stripe");
    const joined = `${copy.title} ${copy.body} ${copy.compensationLine}`;
    expect(joined).not.toContain("Approve & Submit");
    expect(joined).not.toContain("execute order");
    expect(joined).not.toContain("Approve & Execute");
  });

  it("repeats the rail compensation policy, and never promises a refund it cannot make", () => {
    const stripe = journeyGateCopy("stripe").compensationLine;
    expect(stripe).toContain("refund");
    expect(stripe).toContain("credit");
    // S3 corrected the stripe line to the request-first reality:
    // a refund is REQUESTED, operator approval still required
    // before money moves — never stated as already received.
    expect(stripe).toContain("requested");
    expect(stripe).toContain("operator approval");
    expect(stripe).not.toContain("you would have received a provider refund first");
    const x402 = journeyGateCopy("x402").compensationLine;
    expect(x402).toContain("credit");
    expect(x402).toContain("cannot be reversed");
    // The word appears only to deny it — never as a promise.
    expect(x402).toContain("no refund");
    const unknown = journeyGateCopy(undefined).compensationLine;
    expect(unknown).toContain("credit");
    expect(unknown).not.toContain("refund");
  });

  it("builds a prompt carrying saga, run, family, rail, and copy", () => {
    const prompt = buildJourneyGatePrompt("saga-1", "run-1", "goal", "x402");
    expect(prompt.sagaId).toBe("saga-1");
    expect(prompt.runRequestId).toBe("run-1");
    expect(prompt.family).toBe("goal");
    expect(prompt.rail).toBe("x402");
    expect(prompt.copy.compensationLine).toContain("cannot be reversed");
  });
});

describe("Slack journey prompt (S2, #2041)", () => {
  it("carries the ruled action ids and the saga id as the button value", () => {
    const prompt = buildJourneyGatePrompt("saga-1", "run-1", "goal", "stripe");
    const payload = buildSlackJourneyPrompt(prompt);
    expect(payload.text).toContain("Enter the trading leg?");
    expect(payload.text).toContain("run-1");
    expect(payload.text).toContain("refund");
    const actions = payload.blocks[1].elements as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions[0].action_id).toBe(SAGA_JOURNEY_APPROVE_ACTION);
    expect(actions[0].value).toBe("saga-1");
    expect(actions[1].action_id).toBe(SAGA_JOURNEY_DENY_ACTION);
    expect(actions[1].value).toBe("saga-1");
    expect(SAGA_JOURNEY_APPROVE_ACTION).toBe("saga_journey_approve");
    expect(SAGA_JOURNEY_DENY_ACTION).toBe("saga_journey_deny");
  });
});

describe("journey decision parsing (S2, #2041)", () => {
  it("accepts a complete decision and returns every field", () => {
    const parsed = parseJourneyDecision({
      sagaId: "saga-1",
      decision: "denied",
      deciderLogin: "u1login",
      surface: "panel",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision).toEqual({
        sagaId: "saga-1",
        decision: "denied",
        deciderLogin: "u1login",
        surface: "panel",
      });
    }
  });

  it.each([
    [null, "malformed_decision_payload"],
    ["nope", "malformed_decision_payload"],
    [{ decision: "approved", deciderLogin: "u", surface: "slack" }, "malformed_saga_id"],
    [{ sagaId: "", decision: "approved", deciderLogin: "u", surface: "slack" }, "malformed_saga_id"],
    [{ sagaId: "s", decision: "maybe", deciderLogin: "u", surface: "slack" }, "malformed_decision_value"],
    [{ sagaId: "s", decision: "approved", deciderLogin: "", surface: "slack" }, "malformed_decider"],
    [{ sagaId: "s", decision: "approved", deciderLogin: "u", surface: "email" }, "malformed_surface"],
  ])("rejects %s with %s", (payload, reason) => {
    const parsed = parseJourneyDecision(payload);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe(reason);
  });
});

describe("journey decision delivery (S2, #2041)", () => {
  function runningInstance() {
    const events: Array<{ type: string; payload: unknown }> = [];
    return {
      events,
      instance: {
        status: async () => ({ status: "running" }),
        sendEvent: async (ev: { type: string; payload: unknown }) => {
          events.push(ev);
        },
      },
    };
  }

  it("sends the exact event payload, including sagaId, to the derived instance", async () => {
    const { events, instance } = runningInstance();
    const gotIds: string[] = [];
    const binding = {
      get: async (id: string) => {
        gotIds.push(id);
        return instance;
      },
    };
    const result = await deliverJourneyDecision(binding, {
      sagaId: "saga-1",
      decision: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "chat" },
    });
    expect(result).toEqual({ accepted: true });
    expect(gotIds).toEqual(["saga-saga-1"]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("saga-journey-decision");
    expect(events[0].payload).toEqual({
      sagaId: "saga-1",
      decision: "approved",
      deciderLogin: "u1login",
      surface: "chat",
    });
  });

  it("reports superseded with the winner's surface for a complete instance", async () => {
    const binding = {
      get: async () => ({
        status: async () => ({ status: "complete", output: { decidingSurface: "panel" } }),
        sendEvent: async () => {
          throw new Error("must not send to a complete instance");
        },
      }),
    };
    const result = await deliverJourneyDecision(binding, {
      sagaId: "saga-1",
      decision: { sagaId: "saga-1", decision: "denied", deciderLogin: "u1login", surface: "slack" },
    });
    expect(result).toEqual({ accepted: false, reason: "superseded", decidedBy: "panel" });
  });

  it("names an unknown winner when the complete instance carries no surface", async () => {
    const binding = {
      get: async () => ({
        status: async () => ({ status: "complete", output: {} }),
        sendEvent: async () => {},
      }),
    };
    const result = await deliverJourneyDecision(binding, {
      sagaId: "saga-1",
      decision: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" },
    });
    expect(result).toEqual({ accepted: false, reason: "superseded", decidedBy: "unknown" });
  });

  it("throws fail-loud on a missing binding or a missing sendEvent", async () => {
    await expect(
      deliverJourneyDecision(undefined, {
        sagaId: "saga-1",
        decision: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" },
      }),
    ).rejects.toThrow(/not configured/);
    await expect(
      deliverJourneyDecision(
        { get: async () => ({ status: async () => ({ status: "running" }) }) },
        {
          sagaId: "saga-1",
          decision: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" },
        },
      ),
    ).rejects.toThrow(/cannot receive events/);
  });
});

describe("saga workflow instance ids (S2, #2041, S4 entry-route contract)", () => {
  it("derives deterministic, readable ids for short saga ids", () => {
    expect(sagaWorkflowInstanceId("saga-1")).toBe("saga-saga-1");
    expect(sagaWorkflowInstanceId("saga-1")).toBe(sagaWorkflowInstanceId("saga-1"));
  });

  it("sanitizes to provider-safe characters", () => {
    const id = sagaWorkflowInstanceId("saga:1/abc def@example");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toContain(":");
    expect(id).not.toContain("/");
  });

  it("hashes long saga ids down under the 100-character ceiling", () => {
    const long = "saga-".repeat(40);
    const id = sagaWorkflowInstanceId(long);
    expect(id.startsWith("saga-h-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toBe(sagaWorkflowInstanceId(long));
  });
});

describe("pending/decided gate reads (S2, #2041)", () => {
  /** Fake audit-owner stub: answers per type from the given event lists. */
  function auditStub(prompted: Array<Record<string, unknown>>, decided: Array<Record<string, unknown>>): AuditOwnerStub {
    return {
      fetch: async (req: Request) => {
        const type = new URL(req.url).searchParams.get("type");
        const events = type === "saga.journey_prompted" ? prompted : decided;
        return Response.json({ events });
      },
    };
  }

  function promptedEvent(sagaId: string, userLogin: string, extra: Record<string, unknown> = {}) {
    return {
      type: "saga.journey_prompted",
      agent: "saga",
      payload: { sagaId, runRequestId: `run-${sagaId}`, userLogin, family: "goal", rail: "stripe", ...extra },
      created_at: "2026-10-31T00:00:00Z",
    };
  }

  function decidedEvent(sagaId: string, surface: string) {
    return {
      type: "saga.journey_decided",
      agent: "saga",
      payload: { sagaId, decidingSurface: surface },
      created_at: "2026-10-31T01:00:00Z",
    };
  }

  it("lists prompted-minus-decided, scoped to the requesting user", async () => {
    const stub = auditStub(
      [promptedEvent("saga-1", "u1login"), promptedEvent("saga-2", "u1login"), promptedEvent("saga-3", "other")],
      [decidedEvent("saga-2", "panel")],
    );
    const gates = await listPendingJourneyGates(stub, "u1login");
    expect(gates.map((g) => g.sagaId)).toEqual(["saga-1"]);
    expect(gates[0].runRequestId).toBe("run-saga-1");
    expect(gates[0].rail).toBe("stripe");
    expect(gates[0].copy.title).toBe("Enter the trading leg?");
  });

  it("lists all pending gates without a user filter", async () => {
    const stub = auditStub(
      [promptedEvent("saga-1", "u1login"), promptedEvent("saga-3", "other")],
      [],
    );
    expect((await listPendingJourneyGates(stub)).map((g) => g.sagaId)).toEqual(["saga-1", "saga-3"]);
  });

  it("skips malformed prompted rows instead of surfacing them", async () => {
    const stub = auditStub(
      [
        promptedEvent("saga-1", "u1login"),
        { type: "saga.journey_prompted", agent: "saga", payload: { userLogin: "u1login" }, created_at: "x" },
        { type: "saga.journey_prompted", agent: "saga", payload: null, created_at: "x" },
      ],
      [],
    );
    expect((await listPendingJourneyGates(stub, "u1login")).map((g) => g.sagaId)).toEqual(["saga-1"]);
  });

  it("finds the deciding surface, and returns null when undecided", async () => {
    const stub = auditStub([], [decidedEvent("saga-9", "chat")]);
    expect(await findDecidedJourneyGate(stub, "saga-9")).toEqual({ decidingSurface: "chat" });
    expect(await findDecidedJourneyGate(stub, "saga-missing")).toBeNull();
  });

  it("throws fail-loud when the audit read fails", async () => {
    const stub: AuditOwnerStub = {
      fetch: async () => new Response("boom", { status: 500 }),
    };
    await expect(listPendingJourneyGates(stub)).rejects.toThrow(/audit read failed/);
  });
});

describe("Slack journey prompt post/edit (S2, #2041)", () => {
  const prompt = buildJourneyGatePrompt("saga-1", "run-1", "goal", "stripe");

  function slackFetch(calls: Array<{ url: string; init: unknown }>, okBody: Record<string, unknown>) {
    return vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => okBody };
    });
  }

  it("posts to chat.postMessage with the bot token and the prompt text, returning receipts", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    vi.stubGlobal("fetch", slackFetch(calls, { ok: true, channel: "C1", ts: "123.456" }));
    const receipts = await postSlackJourneyPrompt(
      {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_CHANNEL: "C1",
      } as never,
      prompt,
    );
    expect(receipts).toEqual({ slackChannel: "C1", slackTs: "123.456" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    const init = calls[0].init as { headers: Record<string, string>; body: string };
    expect(init.headers["Authorization"]).toBe("Bearer xoxb-test");
    const body = JSON.parse(init.body) as { channel: string; text: string };
    expect(body.channel).toBe("C1");
    expect(body.text).toContain("Enter the trading leg?");
  });

  it("skips (never throws) without a token, without a channel, or on a Slack error", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    vi.stubGlobal("fetch", slackFetch(calls, { ok: true, channel: "C1", ts: "1.1" }));
    const noToken = await postSlackJourneyPrompt({} as never, prompt);
    expect(typeof noToken.slackSkipped).toBe("string");
    const noChannel = await postSlackJourneyPrompt({ SLACK_BOT_TOKEN: "x" } as never, prompt);
    expect(typeof noChannel.slackSkipped).toBe("string");
    expect(calls).toHaveLength(0);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: "boom" }) })));
    const failed = await postSlackJourneyPrompt(
      { SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "C1" } as never,
      prompt,
    );
    expect(typeof failed.slackSkipped).toBe("string");
  });

  it("edits via chat.update with the captured receipts, and skips without them", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    vi.stubGlobal("fetch", slackFetch(calls, { ok: true }));
    const result = await editSlackJourneyPrompt(
      { SLACK_BOT_TOKEN: "xoxb-test" } as never,
      { slackChannel: "C1", slackTs: "123.456" },
      "This journey decision is closed.",
    );
    expect(result.slack).toBe("edited");
    expect(result.panel).toBe("state-driven");
    expect(result.chat).toBe("state-driven");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.update");
    const body = JSON.parse((calls[0].init as { body: string }).body) as Record<string, unknown>;
    expect(body["channel"]).toBe("C1");
    expect(body["ts"]).toBe("123.456");
    const skipped = await editSlackJourneyPrompt(
      { SLACK_BOT_TOKEN: "x" } as never,
      {},
      "This journey decision is closed.",
    );
    expect(skipped.slack).toBe("skipped");
  });
});
