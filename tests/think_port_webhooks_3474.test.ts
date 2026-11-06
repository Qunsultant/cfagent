/**
 * Issue #3474 — webhooks by default on PortThink.
 *
 * The Cloudflare Agents docs define webhooks as a built-in channel
 * of every Agent: an HTTP POST routed to a specific instance,
 * handled in the agent, HMAC-SHA256-verified over the RAW body
 * (X-Hub-Signature-256, crypto.subtle), with processing
 * conventionally ending in setState(...) — which broadcasts to the
 * agent's connected websocket clients. Think extends Agent, so the
 * channel exists by construction; this suite pins that PortThink
 * (the #1951 agent-side port) exposes and routes it:
 *
 *  - the reserved path tail `/webhooks/<source>` is intercepted in
 *    PortThink.fetch — the Durable Object entry every production
 *    dispatch terminates at (actorGateway.dispatch -> stub.fetch,
 *    routeAgentRequest -> stub.fetch) — so EVERY PortThink class
 *    gets the channel with zero per-agent wiring, including the
 *    fleet classes that override onRequest without ever delegating
 *    to super (Orchestrator, Browser, Slack, Sandbox);
 *  - the port verifies (fail-closed), parses, and dispatches to the
 *    port hooks object's new `onWebhook` hook;
 *  - no hook => safe refusal; no configured secret => refused
 *    before any processing; bad signature => 401 and the hook
 *    never runs and the body is never parsed first;
 *  - a hook calling this.setState(...) reaches the base Agent's
 *    broadcast seam untouched (the stub Think records broadcasts —
 *    the seam the Node harness allows; live broadcast is workerd).
 *
 * Under Node vitest "@cloudflare/think" is the tests/stubs alias
 * (see think-harness-stub.test.ts), so these pins run against the
 * real thinkAdapter module with the stub base, exactly like the
 * #2003 harness suite.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PortThink } from "../src/actors/thinkAdapter";
import type {
  ActorTurnHooks,
  ActorWebhookEvent,
} from "../src/actors/actorPorts";
import {
  THINK_WEBHOOK_SECRET_ENV,
  THINK_WEBHOOK_SIGNATURE_HEADER,
  resolveThinkWebhookSecret,
  thinkWebhookSourceFromPath,
  verifyThinkWebhookSignature,
} from "../src/actors/thinkPortMapping";

const SECRET = "test-webhook-secret-3474";
const BODY = JSON.stringify({ type: "settings.changed", brokerId: "alpaca", mode: "paper" });

async function sign(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

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

/** A PortThink agent that opted in: its onWebhook records every event. */
class RecordingWebhookAgent extends PortThink {
  readonly received: ActorWebhookEvent[] = [];
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onWebhook: async (event) => {
        this.received.push(event);
      },
    });
  }
}

/** A PortThink agent whose hook answers with its own Response. */
class ResponsiveWebhookAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onWebhook: async () => new Response("accepted", { status: 202 }),
    });
  }
}

/** A PortThink agent whose hook ends in setState (the docs idiom). */
class StatefulWebhookAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onWebhook: async (event) => {
        this.setState({ lastWebhookSource: event.source });
      },
    });
  }
}

/** A PortThink agent whose hook throws. */
class ThrowingWebhookAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onWebhook: async () => {
        throw new Error("handler boom");
      },
    });
  }
}

/** A PortThink agent with full turn hooks but NO webhook hook. */
class UnhookedAgent extends PortThink {
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks();
  }
}

/** A PortThink agent with no port hooks at all (Browser/Sandbox shape). */
class HooklessAgent extends PortThink {}

/**
 * A PortThink agent in the fleet's overriding shape: its own
 * onRequest answers everything and never delegates to super. The
 * port's webhook channel must still reach it (fetch-level wiring),
 * and its own routes must keep working untouched.
 */
class OwnRouterAgent extends PortThink {
  readonly received: ActorWebhookEvent[] = [];
  constructor(ctx: unknown, env: unknown) {
    super(ctx as never, env as never);
    this.portHooks = baseHooks({
      onWebhook: async (event) => {
        this.received.push(event);
      },
    });
  }
  async onRequest(_request: Request): Promise<Response> {
    return new Response("own-router", { status: 200 });
  }
}

const CTX = { storage: { get: async () => null } };
const ENV_WITH_SECRET = { [THINK_WEBHOOK_SECRET_ENV]: SECRET };

function agentUrl(tail: string): string {
  // The routeAgentRequest production URL shape:
  // /agents/<kebab-class>/<instance-name><tail>.
  return `https://agent.openaimp.com/agents/recording-webhook-agent/instance-1${tail}`;
}

async function webhookRequest(
  rawBody: string,
  opts: { secret?: string; signature?: string | null; url?: string; method?: string } = {}
): Promise<Request> {
  const headers = new Headers({ "content-type": "application/json" });
  const signature =
    opts.signature === undefined ? await sign(rawBody, opts.secret ?? SECRET) : opts.signature;
  if (signature) headers.set(THINK_WEBHOOK_SIGNATURE_HEADER, signature);
  return new Request(opts.url ?? agentUrl("/webhooks/settings"), {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "GET" || opts.method === "HEAD" ? undefined : rawBody,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook path / secret / signature seams (pure, thinkPortMapping)", () => {
  it("matches the reserved /webhooks/<source> tail under any prefix", () => {
    expect(thinkWebhookSourceFromPath("/agents/orchestrator-agent/alice/webhooks/settings")).toBe("settings");
    expect(thinkWebhookSourceFromPath("/webhooks/github")).toBe("github");
    expect(thinkWebhookSourceFromPath("/agents/x/y/webhooks/slack-events")).toBe("slack-events");
  });

  it("rejects non-webhook and malformed webhook paths", () => {
    expect(thinkWebhookSourceFromPath("/agents/x/y/get-messages")).toBeNull();
    expect(thinkWebhookSourceFromPath("/agents/x/y/webhooks")).toBeNull();
    expect(thinkWebhookSourceFromPath("/agents/x/y/webhooks/")).toBeNull();
    expect(thinkWebhookSourceFromPath("/agents/x/y/webhooks/a/b")).toBeNull();
    expect(thinkWebhookSourceFromPath("/api/webhooksx/settings")).toBeNull();
    expect(thinkWebhookSourceFromPath("/")).toBeNull();
  });

  it("resolves the secret from env, treating blank/non-string as unconfigured", () => {
    expect(resolveThinkWebhookSecret({ [THINK_WEBHOOK_SECRET_ENV]: "s3cret" })).toBe("s3cret");
    expect(resolveThinkWebhookSecret({ [THINK_WEBHOOK_SECRET_ENV]: "" })).toBeUndefined();
    expect(resolveThinkWebhookSecret({ [THINK_WEBHOOK_SECRET_ENV]: "   " })).toBeUndefined();
    expect(resolveThinkWebhookSecret({ [THINK_WEBHOOK_SECRET_ENV]: 42 })).toBeUndefined();
    expect(resolveThinkWebhookSecret({})).toBeUndefined();
    expect(resolveThinkWebhookSecret(undefined)).toBeUndefined();
    expect(resolveThinkWebhookSecret(null)).toBeUndefined();
  });

  it("verifies HMAC-SHA256 over the raw body (docs pattern)", async () => {
    const good = await sign(BODY, SECRET);
    await expect(verifyThinkWebhookSignature(BODY, good, SECRET)).resolves.toBe(true);
    await expect(verifyThinkWebhookSignature(BODY + " ", good, SECRET)).resolves.toBe(false);
    await expect(verifyThinkWebhookSignature(BODY, good, "other-secret")).resolves.toBe(false);
    await expect(verifyThinkWebhookSignature(BODY, null, SECRET)).resolves.toBe(false);
    await expect(verifyThinkWebhookSignature(BODY, "sha256=xyz", SECRET)).resolves.toBe(false);
    await expect(verifyThinkWebhookSignature(BODY, good.replace("sha256=", ""), SECRET)).resolves.toBe(false);
  });
});

describe("PortThink webhook channel (through the production fetch entry)", () => {
  it("delivers a verified webhook to the hook with payload, raw body, source, and headers", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
    expect(agent.received).toHaveLength(1);
    const event = agent.received[0];
    expect(event.source).toBe("settings");
    expect(event.payload).toEqual(JSON.parse(BODY));
    expect(event.rawBody).toBe(BODY);
    expect(event.headers.get(THINK_WEBHOOK_SIGNATURE_HEADER)).toMatch(/^sha256=/);
    expect(event.url.pathname).toBe("/agents/recording-webhook-agent/instance-1/webhooks/settings");
  });

  it("returns the hook's own Response when it produces one", async () => {
    const agent = new ResponsiveWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("accepted");
  });

  it("refuses a bad signature with 401 and never calls the hook", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY, { secret: "wrong-secret" }));
    expect(res.status).toBe(401);
    expect(agent.received).toHaveLength(0);
  });

  it("refuses a missing signature with 401 and never calls the hook", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY, { signature: null }));
    expect(res.status).toBe(401);
    expect(agent.received).toHaveLength(0);
  });

  it("refuses an unparseable body with 400 after verification, hook never called", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const notJson = "this is not json";
    const res = await agent.fetch(await webhookRequest(notJson));
    expect(res.status).toBe(400);
    expect(agent.received).toHaveLength(0);
  });

  it("fails closed with 503 when no webhook secret is configured, hook never called", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new RecordingWebhookAgent(CTX, {});
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(503);
    expect(agent.received).toHaveLength(0);
  });

  it("refuses safely (405) when the agent has not opted in — hooks without onWebhook", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new UnhookedAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(405);
  });

  it("refuses safely (405) when the agent has no port hooks at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new HooklessAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(405);
  });

  it("refuses a non-POST method on the webhook path with 405", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY, { method: "GET" }));
    expect(res.status).toBe(405);
    expect(agent.received).toHaveLength(0);
  });

  it("answers 500 (and logs) when the hook throws, instead of taking the DO down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = new ThrowingWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(500);
  });

  it("reaches even an agent class that overrides onRequest without delegating", async () => {
    const agent = new OwnRouterAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(200);
    expect(agent.received).toHaveLength(1);
    // ...and its own routes are untouched by the interception.
    const own = await agent.fetch(new Request(agentUrl("/health"), { method: "GET" }));
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("own-router");
    expect(agent.received).toHaveLength(1);
  });

  it("passes non-webhook requests through to the base fetch untouched", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(new Request(agentUrl("/get-messages"), { method: "GET" }));
    // The stub base's default onRequest answers 404; the point of the
    // pin is that the port did NOT answer it as a webhook.
    expect(res.status).toBe(404);
    expect(agent.received).toHaveLength(0);
  });

  it("does not intercept a sub-agent-addressed webhook tail (facet forwarding stays the base fetch's)", async () => {
    const agent = new RecordingWebhookAgent(CTX, ENV_WITH_SECRET);
    const subUrl =
      "https://agent.openaimp.com/agents/recording-webhook-agent/instance-1/sub/child-agent/child-1/webhooks/settings";
    const res = await agent.fetch(await webhookRequest(BODY, { url: subUrl }));
    expect(res.status).toBe(404);
    expect(agent.received).toHaveLength(0);
  });

  it("lets a hook's setState reach the base Agent's broadcast seam", async () => {
    const agent = new StatefulWebhookAgent(CTX, ENV_WITH_SECRET);
    const res = await agent.fetch(await webhookRequest(BODY));
    expect(res.status).toBe(200);
    const seam = agent as unknown as {
      state: unknown;
      stateBroadcasts: unknown[];
    };
    expect(seam.state).toEqual({ lastWebhookSource: "settings" });
    expect(seam.stateBroadcasts).toEqual([{ lastWebhookSource: "settings" }]);
  });
});
