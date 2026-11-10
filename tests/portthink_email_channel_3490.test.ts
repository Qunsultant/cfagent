/**
 * Issue #3490 (Uniform Copilot Standard S2, epic #3488) — the email
 * channel on PortThink.
 *
 * Today no onEmail exists anywhere; email reaches the platform only
 * as the NLQ pipeline (the #1262 Worker forwarder), never as an
 * agent channel. This suite pins the S2 slice:
 *
 *  - the address-based resolver seam (the SDK's resolver pattern,
 *    keyed to per-login instance naming): `<agent-kebab>+<instance>`
 *    routes, a bare mailbox address does not — it stays NLQ traffic;
 *  - the PortThink port hook: `onEmail` on the port hooks object
 *    (the #3474 onWebhook idiom), parsed in the port before
 *    dispatch; an agent without the hook no-ops safely (accepted,
 *    logged, no processing) — the deliberate difference from
 *    webhooks, which refuse (405) without a hook;
 *  - outbound: the port exposes the SDK send/reply path
 *    (sendEmail/replyToEmail) to hooks, failing loud with the named
 *    reason when the EMAIL send binding is absent;
 *  - the Worker entry: agent-addressed mail goes through
 *    routeAgentEmail; everything else falls through to the existing
 *    NLQ handler, untouched.
 *
 * Two SDK-internal hops are mirrored from the installed agents
 * 0.32.0 source (not executed under Node vitest, where the bare
 * "agents" entry cannot load — its graph reaches `cloudflare:email`):
 * the mock `routeAgentEmail` below mirrors the SDK's namespace
 * lookup (env map over exact / kebab-case / lowercase keys, then
 * getAgentByName: idFromName -> get -> __unsafe_ensureInitialized),
 * and the test agent's `_onEmail` mirrors the SDK base's wrapper
 * (build the AgentEmail object, call `this.onEmail(email)`).
 * The real routeAgentEmail invocation + real _onEmail entry are a
 * stated coverage gap for live deploy verification (see §15).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { signAgentHeaders } from "agents/email";

import { PortThink } from "../src/actors/thinkAdapter";
import type {
  ActorEmailEvent,
  ActorTurnHooks,
} from "../src/actors/actorPorts";
import {
  createPortThinkEmailResolver,
  isAgentChannelEmail,
  parseAgentEmailAddress,
  resolveAgentEmailNamespace,
  routeAgentChannelEmail,
} from "../src/actors/agentEmailRouting";

// ---------------------------------------------------------------------------
// The "agents" mock: the real bare entry cannot load under Node vitest
// (its graph reaches `cloudflare:email`), so the Worker-dispatch pins
// below run against a mock routeAgentEmail that mirrors the SDK's
// lookup mechanics from the installed agents 0.32.0 source
// (dist/agent-routing.js + dist/src-DoGNJ4Ud.js, routeAgentEmail /
// getAgentByName). The resolver under test is the REAL one.
// ---------------------------------------------------------------------------
const routeCalls = vi.hoisted(() => [] as Array<{ message: unknown; env: unknown }>);

function mockKebab(s: string): string {
  if (s === s.toUpperCase() && s !== s.toLowerCase())
    return s.toLowerCase().replace(/_/g, "-");
  let kebabified = s.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {},
    routeAgentEmail: async (email: any, env: any, options: any) => {
      routeCalls.push({ message: email, env });
      const routingInfo = await options.resolver(email, env);
      if (!routingInfo) {
        if (options.onNoRoute) await options.onNoRoute(email);
        return;
      }
      const map: Record<string, any> = {};
      for (const [key, value] of Object.entries(env)) {
        if (
          value &&
          typeof value === "object" &&
          "idFromName" in (value as Record<string, unknown>) &&
          typeof (value as Record<string, unknown>).idFromName === "function"
        ) {
          map[key] = value;
          map[mockKebab(key)] = value;
          map[key.toLowerCase()] = value;
        }
      }
      const namespace = map[routingInfo.agentName];
      if (!namespace) {
        throw new Error(
          `Agent namespace '${routingInfo.agentName}' not found in environment.`,
        );
      }
      const stub = namespace.get(namespace.idFromName(routingInfo.agentId));
      if (typeof stub.__unsafe_ensureInitialized === "function") {
        await stub.__unsafe_ensureInitialized();
      }
      const rawBytes = email.raw
        ? new Uint8Array(await new Response(email.raw).arrayBuffer())
        : new Uint8Array();
      const bridge = {
        getRaw: async () => rawBytes,
        setReject: () => {},
        forward: async () => ({}) as never,
        reply: async () => ({}) as never,
      };
      await stub._onEmail({
        from: email.from,
        to: email.to,
        headers: email.headers,
        rawSize: rawBytes.byteLength,
        _secureRouted: routingInfo._secureRouted,
        _bridge: bridge,
      });
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";

const CTX = { storage: { get: async () => null } };

function baseHooks(overrides: Partial<ActorTurnHooks> = {}): ActorTurnHooks {
  return {
    getModel: () => null,
    getSystemPrompt: () => "",
    getTools: () => ({}),
    beforeTurn: async () => undefined,
    onChatResponse: async () => {},
    ...overrides,
  };
}

function rawMime(from: string, to: string, subject: string, text: string): Uint8Array {
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "",
  ].join("\r\n");
  return new TextEncoder().encode(mime);
}

function rawStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function workerMessage(
  from: string,
  to: string,
  subject: string,
  text: string,
  headers?: Headers,
) {
  const bytes = rawMime(from, to, subject, text);
  return {
    from,
    to,
    raw: rawStream(bytes),
    headers: headers ?? new Headers(),
  };
}

function inboundEmail(
  overrides: {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    headers?: Headers;
    getRaw?: () => Promise<Uint8Array>;
    setReject?: (reason: string) => void;
  } = {},
) {
  const from = overrides.from ?? "human@example.com";
  const to = overrides.to ?? "orchestrator-agent+alice@agent.openaimp.com";
  const subject = overrides.subject ?? "Hello copilot";
  const text = overrides.text ?? "please summarize this";
  const bytes = rawMime(from, to, subject, text);
  return {
    from,
    to,
    headers: overrides.headers ?? new Headers({ subject }),
    rawSize: bytes.byteLength,
    _secureRouted: false,
    getRaw: overrides.getRaw ?? (async () => bytes),
    setReject: overrides.setReject ?? (() => {}),
    forward: async () => ({}) as never,
    reply: async () => ({}) as never,
  };
}

/** A PortThink agent that opted in: its onEmail records every event. */
class RecordingEmailAgent extends PortThink {
  readonly received: ActorEmailEvent[] = [];
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onEmail: async (event) => {
        this.received.push(event);
      },
    });
  }
}

/** A PortThink agent whose hook answers with a reply + a send. */
class ReplyingEmailAgent extends PortThink {
  readonly replies: unknown[] = [];
  readonly sends: unknown[] = [];
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onEmail: async (event) => {
        await event.reply({
          fromName: "Copilot",
          subject: "Re: Hello copilot",
          body: "noted",
        });
        await event.send({
          to: "human@example.com",
          subject: "follow-up",
          text: "done",
        });
      },
    });
  }
}

/** A PortThink agent whose hook ends in setState (the docs idiom). */
class StatefulEmailAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onEmail: async (event) => {
        this.setState({ lastEmailFrom: event.from });
      },
    });
  }
}

/** A PortThink agent whose hook throws. */
class ThrowingEmailAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onEmail: async () => {
        throw new Error("hook boom");
      },
    });
  }
}

/** A PortThink agent with full turn hooks but NO email hook. */
class UnhookedEmailAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks();
  }
}

/** A PortThink agent with no port hooks at all (Browser/Sandbox shape). */
class HooklessEmailAgent extends PortThink {}

/**
 * A PortThink agent addressed through the Worker dispatch: its
 * `_onEmail` mirrors the SDK base Agent's wrapper (agents 0.32.0,
 * src-DoGNJ4Ud.js ~2395 — build the AgentEmail object from the
 * bridge payload, call `this.onEmail(email)`), so the worker test
 * below exercises the REAL PortThink.onEmail through the REAL
 * resolver with only the SDK's lookup + wrapper mirrored.
 */
class WorkerRoutedAgent extends PortThink {
  readonly received: ActorEmailEvent[] = [];
  readonly onEmailPayloads: unknown[] = [];
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onEmail: async (event) => {
        this.received.push(event);
      },
    });
  }
  async _onEmail(payload: {
    from: string;
    to: string;
    headers: Headers;
    rawSize: number;
    _secureRouted?: boolean;
    _bridge: {
      getRaw: () => Promise<Uint8Array>;
      setReject: (reason: string) => void;
      forward: (rcptTo: string, headers?: Headers) => Promise<unknown>;
      reply: (options: { from: string; to: string; raw: string }) => Promise<unknown>;
    };
  }): Promise<void> {
    const email = {
      from: payload.from,
      to: payload.to,
      headers: payload.headers,
      rawSize: payload.rawSize,
      _secureRouted: payload._secureRouted,
      getRaw: () => payload._bridge.getRaw(),
      setReject: (reason: string) => payload._bridge.setReject(reason),
      forward: (rcptTo: string, headers?: Headers) =>
        payload._bridge.forward(rcptTo, headers),
      reply: (options: { from: string; to: string; raw: string }) =>
        payload._bridge.reply(options),
    };
    this.onEmailPayloads.push(email);
    await (this as unknown as { onEmail: (e: unknown) => Promise<void> }).onEmail(email);
  }
  async __unsafe_ensureInitialized(): Promise<void> {}
}

const ENV_WITH_BINDING = {
  EMAIL: { send: vi.fn(async () => ({ messageId: "mid-1" })) },
  EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
};

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  routeCalls.length = 0;
});

// ---------------------------------------------------------------------------
// The resolver seam (pure): address parsing + namespace gate
// ---------------------------------------------------------------------------

describe("agent email address parsing (#3490)", () => {
  it("parses <agent-kebab>+<instance>@domain to agentName + agentId", () => {
    expect(
      parseAgentEmailAddress("orchestrator-agent+alice@agent.openaimp.com"),
    ).toEqual({ agentName: "orchestrator-agent", agentId: "alice" });
    expect(parseAgentEmailAddress("research-agent+bob@agent.openaimp.com")).toEqual({
      agentName: "research-agent",
      agentId: "bob",
    });
    expect(
      parseAgentEmailAddress("ORCHESTRATOR_AGENT+alice@agent.openaimp.com"),
    ).toEqual({ agentName: "ORCHESTRATOR_AGENT", agentId: "alice" });
  });

  it("a bare mailbox address has no agent route (it stays NLQ traffic)", () => {
    expect(parseAgentEmailAddress("trade@agent.openaimp.com")).toBeNull();
    expect(parseAgentEmailAddress("orchestrator-agent@agent.openaimp.com")).toBeNull();
  });

  it("malformed addresses have no agent route", () => {
    expect(parseAgentEmailAddress("")).toBeNull();
    expect(parseAgentEmailAddress("not-an-address")).toBeNull();
    expect(parseAgentEmailAddress("orchestrator-agent+@agent.openaimp.com")).toBeNull();
    expect(parseAgentEmailAddress("+alice@agent.openaimp.com")).toBeNull();
  });

  it("the SDK regex permits '+' inside the sub-address (mirrored exactly)", () => {
    expect(parseAgentEmailAddress("a+b+c@agent.openaimp.com")).toEqual({
      agentName: "a",
      agentId: "b+c",
    });
  });
});

describe("agent email namespace gate (#3490)", () => {
  const fakeNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({}),
  };
  it("resolves the namespace by exact, kebab-case, and lowercase binding key (the SDK's map)", () => {
    const env = { ORCHESTRATOR_AGENT: fakeNamespace } as unknown as Record<
      string,
      unknown
    >;
    expect(resolveAgentEmailNamespace(env, "ORCHESTRATOR_AGENT")).toBe(fakeNamespace);
    expect(resolveAgentEmailNamespace(env, "orchestrator-agent")).toBe(fakeNamespace);
    expect(resolveAgentEmailNamespace(env, "orchestrator_agent")).toBe(fakeNamespace);
  });

  it("an unknown agent prefix resolves to no namespace", () => {
    const env = { ORCHESTRATOR_AGENT: fakeNamespace } as unknown as Record<
      string,
      unknown
    >;
    expect(resolveAgentEmailNamespace(env, "nope-agent")).toBeUndefined();
    expect(resolveAgentEmailNamespace(env, "NopeAgent")).toBeUndefined();
  });

  it("a binding-shaped value without addressing methods is not a namespace", () => {
    const env = { ORCHESTRATOR_AGENT: { send: () => {} } } as unknown as Record<
      string,
      unknown
    >;
    expect(resolveAgentEmailNamespace(env, "orchestrator-agent")).toBeUndefined();
  });

  it("isAgentChannelEmail is true only for a sub-addressed mail to a bound agent", () => {
    const env = { ORCHESTRATOR_AGENT: fakeNamespace } as unknown as Record<
      string,
      unknown
    >;
    expect(isAgentChannelEmail("orchestrator-agent+alice@agent.openaimp.com", env)).toBe(
      true,
    );
    expect(isAgentChannelEmail("trade@agent.openaimp.com", env)).toBe(false);
    expect(isAgentChannelEmail("orchestrator-agent+alice@agent.openaimp.com", {})).toBe(
      false,
    );
    expect(isAgentChannelEmail("nope-agent+alice@agent.openaimp.com", env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The resolver itself (real SDK secure-reply leg, real address leg)
// ---------------------------------------------------------------------------

describe("createPortThinkEmailResolver (#3490)", () => {
  const fakeNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({}),
  };
  const env = { ORCHESTRATOR_AGENT: fakeNamespace } as unknown as Record<
    string,
    unknown
  >;

  it("routes <agent>+<instance> to that agent binding + instance", async () => {
    const resolver = createPortThinkEmailResolver(env);
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "orchestrator-agent+alice@agent.openaimp.com",
          headers: new Headers(),
          rawSize: 0,
        } as never,
        env as never,
      ),
    ).resolves.toEqual({ agentName: "orchestrator-agent", agentId: "alice" });
  });

  it("returns null for NLQ mail and for unknown agent prefixes (onNoRoute, never a throw)", async () => {
    const resolver = createPortThinkEmailResolver(env);
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "trade@agent.openaimp.com",
          headers: new Headers(),
          rawSize: 0,
        } as never,
        env as never,
      ),
    ).resolves.toBeNull();
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "nope-agent+alice@agent.openaimp.com",
          headers: new Headers(),
          rawSize: 0,
        } as never,
        env as never,
      ),
    ).resolves.toBeNull();
  });

  it("without EMAIL_SECRET there is no secure leg and no throw", async () => {
    const resolver = createPortThinkEmailResolver(env);
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "orchestrator-agent+alice@agent.openaimp.com",
          headers: new Headers(),
          rawSize: 0,
        } as never,
        env as never,
      ),
    ).resolves.toEqual({ agentName: "orchestrator-agent", agentId: "alice" });
  });

  it("with EMAIL_SECRET, a signed reply routes by its signed headers (secure leg first)", async () => {
    const secret = "test-email-secret-3490";
    // The signed agent name is the kebab-case binding form — what
    // the SDK's replyToEmail signs (camelCaseToKebabCase of the
    // class name), so the namespace lookup agrees with it.
    const signed = await signAgentHeaders(secret, "orchestrator-agent", "alice");
    const headers = new Headers();
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    const resolver = createPortThinkEmailResolver({ ...env, EMAIL_SECRET: secret });
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "trade@agent.openaimp.com",
          headers,
          rawSize: 0,
        } as never,
        { ...env, EMAIL_SECRET: secret } as never,
      ),
    ).resolves.toEqual({
      agentName: "orchestrator-agent",
      agentId: "alice",
      _secureRouted: true,
    });
  });

  it("with EMAIL_SECRET, a signature for an unbound agent falls through to the address leg", async () => {
    const secret = "test-email-secret-3490";
    const signed = await signAgentHeaders(secret, "NopeAgent", "alice");
    const headers = new Headers();
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    const resolver = createPortThinkEmailResolver({ ...env, EMAIL_SECRET: secret });
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "orchestrator-agent+alice@agent.openaimp.com",
          headers,
          rawSize: 0,
        } as never,
        env as never,
      ),
    ).resolves.toEqual({ agentName: "orchestrator-agent", agentId: "alice" });
  });

  it("with EMAIL_SECRET, an invalid signature falls through to the address leg", async () => {
    const secret = "test-email-secret-3490";
    const reasons: unknown[] = [];
    const headers = new Headers({
      "x-agent-name": "OrchestratorAgent",
      "x-agent-id": "alice",
      "x-agent-sig": "deadbeef",
      "x-agent-sig-ts": String(Math.floor(Date.now() / 1000)),
    });
    const resolver = createPortThinkEmailResolver(
      {
        ...env,
        EMAIL_SECRET: secret,
      } as unknown as Record<string, unknown>,
      {
        onInvalidSignature: (reason: string) => {
          reasons.push(reason);
        },
      },
    );
    await expect(
      resolver(
        {
          from: "human@example.com",
          to: "orchestrator-agent+alice@agent.openaimp.com",
          headers,
          rawSize: 0,
        } as never,
        env as never,
      ),
    ).resolves.toEqual({ agentName: "orchestrator-agent", agentId: "alice" });
    expect(reasons.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The port hook: PortThink.onEmail dispatch
// ---------------------------------------------------------------------------

describe("PortThink onEmail dispatch (#3490)", () => {
  it("delivers a parsed email to the hook with sender/recipients/headers/body", async () => {
    const agent = new RecordingEmailAgent(CTX, ENV_WITH_BINDING);
    await agent.onEmail(inboundEmail() as never);
    expect(agent.received).toHaveLength(1);
    const event = agent.received[0];
    expect(event.from).toBe("human@example.com");
    expect(event.to).toBe("orchestrator-agent+alice@agent.openaimp.com");
    expect(event.subject).toBe("Hello copilot");
    expect(event.text).toContain("please summarize this");
    expect(event.headers.some((h) => h.key === "subject" && h.value === "Hello copilot")).toBe(
      true,
    );
    expect(event.rawSize).toBeGreaterThan(0);
    expect(event.secureRouted).toBe(false);
    expect(typeof event.reply).toBe("function");
    expect(typeof event.send).toBe("function");
    expect(typeof event.getRaw).toBe("function");
  });

  it("an agent without the hook no-ops safely: accepted, logged, no processing, no throw", async () => {
    const agent = new UnhookedEmailAgent(CTX, ENV_WITH_BINDING);
    await expect(agent.onEmail(inboundEmail() as never)).resolves.toBeUndefined();
  });

  it("an agent with no port hooks at all no-ops safely", async () => {
    const agent = new HooklessEmailAgent(CTX, ENV_WITH_BINDING);
    await expect(agent.onEmail(inboundEmail() as never)).resolves.toBeUndefined();
  });

  it("a throwing hook does not take the DO down: onEmail resolves and the failure is logged", async () => {
    const agent = new ThrowingEmailAgent(CTX, ENV_WITH_BINDING);
    await expect(agent.onEmail(inboundEmail() as never)).resolves.toBeUndefined();
  });

  it("a disabled email capability rejects loudly with the named reason and never calls the hook", async () => {
    const rejected: string[] = [];
    const agent = new RecordingEmailAgent(CTX, {
      ...ENV_WITH_BINDING,
      AGENT_CAPABILITIES_DISABLED: "*:email",
    });
    await agent.onEmail(
      inboundEmail({ setReject: (reason) => rejected.push(reason) }) as never,
    );
    expect(agent.received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("email_channel_disabled_by_config");
  });

  it("an unparseable message rejects loudly and never calls the hook", async () => {
    const rejected: string[] = [];
    const agent = new RecordingEmailAgent(CTX, ENV_WITH_BINDING);
    await agent.onEmail(
      inboundEmail({
        getRaw: async () => {
          throw new Error("raw unreadable");
        },
        setReject: (reason) => rejected.push(reason),
      }) as never,
    );
    expect(agent.received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("email_unparseable");
  });

  it("lets a hook's setState reach the base Agent's broadcast seam", async () => {
    const agent = new StatefulEmailAgent(CTX, ENV_WITH_BINDING);
    await agent.onEmail(inboundEmail() as never);
    const seam = agent as unknown as { state: unknown; stateBroadcasts: unknown[] };
    expect(seam.state).toEqual({ lastEmailFrom: "human@example.com" });
    expect(seam.stateBroadcasts).toEqual([{ lastEmailFrom: "human@example.com" }]);
  });
});

// ---------------------------------------------------------------------------
// Outbound: the port's send/reply path
// ---------------------------------------------------------------------------

describe("PortThink email send/reply path (#3490)", () => {
  it("sendPortEmail delegates to the SDK sendEmail with the binding and the instance channel address as default From", async () => {
    const agent = new RecordingEmailAgent(CTX, ENV_WITH_BINDING);
    (agent as unknown as { name: string }).name = "alice";
    const sendEmail = vi.fn(async () => ({ messageId: "mid-1" }));
    (agent as unknown as { sendEmail: unknown }).sendEmail = sendEmail;
    await agent.sendPortEmail({
      to: "human@example.com",
      subject: "hello",
      text: "hi",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const opts = sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.binding).toBe(ENV_WITH_BINDING.EMAIL);
    expect(opts.to).toBe("human@example.com");
    expect(opts.subject).toBe("hello");
    expect(opts.from).toBe("recording-email-agent+alice@agent.openaimp.com");
  });

  it("sendPortEmail honors an explicit From", async () => {
    const agent = new RecordingEmailAgent(CTX, ENV_WITH_BINDING);
    (agent as unknown as { name: string }).name = "alice";
    const sendEmail = vi.fn(async () => ({ messageId: "mid-1" }));
    (agent as unknown as { sendEmail: unknown }).sendEmail = sendEmail;
    await agent.sendPortEmail({
      to: "human@example.com",
      subject: "hello",
      text: "hi",
      from: "support@agent.openaimp.com",
    });
    expect(
      (sendEmail.mock.calls[0][0] as Record<string, unknown>).from,
    ).toBe("support@agent.openaimp.com");
  });

  it("sendPortEmail fails loud with the named reason when the EMAIL binding is absent", async () => {
    const agent = new RecordingEmailAgent(CTX, {});
    (agent as unknown as { sendEmail: unknown }).sendEmail = vi.fn(async () => ({}));
    await expect(
      agent.sendPortEmail({ to: "human@example.com", subject: "hello", text: "hi" }),
    ).rejects.toThrow(/email_send_binding_not_configured/);
  });

  it("the hook event's send delegates to sendPortEmail and reply delegates to replyToEmail", async () => {
    const agent = new ReplyingEmailAgent(CTX, ENV_WITH_BINDING);
    (agent as unknown as { name: string }).name = "alice";
    const sendEmail = vi.fn(async () => ({ messageId: "mid-1" }));
    const replyToEmail = vi.fn(async () => {});
    (agent as unknown as { sendEmail: unknown }).sendEmail = sendEmail;
    (agent as unknown as { replyToEmail: unknown }).replyToEmail = replyToEmail;
    await agent.onEmail(inboundEmail() as never);
    expect(replyToEmail).toHaveBeenCalledTimes(1);
    expect(replyToEmail.mock.calls[0][0]).toBeDefined();
    expect(replyToEmail.mock.calls[0][1]).toMatchObject({
      fromName: "Copilot",
      body: "noted",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(
      (sendEmail.mock.calls[0][0] as Record<string, unknown>).to,
    ).toBe("human@example.com");
  });
});

// ---------------------------------------------------------------------------
// The Worker entry: agent-addressed mail routes, everything else is NLQ
// ---------------------------------------------------------------------------

describe("worker email export: agent channel vs NLQ fallthrough (#3490)", () => {
  function fakeNamespace(agent: unknown) {
    return {
      idFromName: (name: string) => ({ name }),
      get: () => agent,
    };
  }

  it("agent-addressed mail reaches the addressed PortThink instance's hook", async () => {
    const agent = new WorkerRoutedAgent(CTX, ENV_WITH_BINDING);
    const env = {
      ...ENV_WITH_BINDING,
      ORCHESTRATOR_AGENT: fakeNamespace(agent),
    } as unknown as Record<string, unknown>;
    const message = workerMessage(
      "human@example.com",
      "orchestrator-agent+alice@agent.openaimp.com",
      "Hello copilot",
      "please summarize this",
    );
    await (worker as unknown as { email: (m: unknown, e: unknown) => Promise<void> }).email(
      message,
      env,
    );
    expect(routeCalls).toHaveLength(1);
    expect(agent.received).toHaveLength(1);
    expect(agent.received[0].from).toBe("human@example.com");
    expect(agent.received[0].subject).toBe("Hello copilot");
    expect(agent.received[0].text).toContain("please summarize this");
  });

  it("NLQ mail (bare mailbox) falls through to the existing handler untouched", async () => {
    const agent = new WorkerRoutedAgent(CTX, ENV_WITH_BINDING);
    const env = {
      ...ENV_WITH_BINDING,
      ORCHESTRATOR_AGENT: fakeNamespace(agent),
    } as unknown as Record<string, unknown>;
    // No SERVICE_USER_LOGIN: the NLQ handler fails loud on the
    // missing service identity (the #815/#1185 contract) — which
    // proves the mail reached it instead of the agent channel.
    const message = workerMessage(
      "human@example.com",
      "trade@agent.openaimp.com",
      "APPROVE ord_1",
      "APPROVE ord_1",
    );
    await expect(
      (worker as unknown as { email: (m: unknown, e: unknown) => Promise<void> }).email(
        message,
        env,
      ),
    ).rejects.toThrow(/service identity/i);
    expect(routeCalls).toHaveLength(0);
    expect(agent.received).toHaveLength(0);
  });

  it("mail to an unknown agent prefix falls through to the NLQ handler, never swallowed", async () => {
    const agent = new WorkerRoutedAgent(CTX, ENV_WITH_BINDING);
    const env = {
      ...ENV_WITH_BINDING,
      ORCHESTRATOR_AGENT: fakeNamespace(agent),
    } as unknown as Record<string, unknown>;
    const message = workerMessage(
      "human@example.com",
      "nope-agent+alice@agent.openaimp.com",
      "hello",
      "hello",
    );
    await expect(
      (worker as unknown as { email: (m: unknown, e: unknown) => Promise<void> }).email(
        message,
        env,
      ),
    ).rejects.toThrow(/service identity/i);
    expect(routeCalls).toHaveLength(0);
    expect(agent.received).toHaveLength(0);
  });

  it("routeAgentChannelEmail returns false without routing when the mail is not agent-addressed", async () => {
    const env = {} as unknown as Record<string, unknown>;
    const message = workerMessage(
      "human@example.com",
      "trade@agent.openaimp.com",
      "hi",
      "hi",
    );
    await expect(routeAgentChannelEmail(message as never, env)).resolves.toBe(false);
    expect(routeCalls).toHaveLength(0);
  });
});
