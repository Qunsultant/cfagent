/**
 * Issue #1764 (#1717 slice: workflow + service identity) — RED first.
 *
 * (1) Queue dead-letter + retention: a terminal drop (denied dispatch,
 * undecodable message, no handler) must produce a structured,
 * auditable dead-letter record — not a bare console warning — while
 * ack/retry semantics stay exactly as before (a retryable failure
 * still retries into the platform DLQ after max_retries; a terminal
 * drop never retries).
 * (2) Background identity attribution: unattended dispatches carry
 * x-actor-kind: background alongside x-user-login, and attribution
 * resolves background ONLY when the login equals the configured
 * service login — a background header on a user login resolves to
 * user with an anomaly flag (the header is corroboration, never
 * authority, so a client-spoofed header cannot claim background).
 * (3) Service-identity provisioning completeness: the status route
 * reports a checklist (login configured, platform membership live,
 * brokerage token present) with explicit owner actions for every
 * item that is not a pass — never a silent "not provisioned".
 */
import { describe, it, expect, vi } from "vitest";
import {
  BACKGROUND_ACTOR_HEADER,
  backgroundDispatchHeaders,
  resolveActorAttribution,
} from "../src/security/backgroundAttribution";
import {
  createDeadLetterRecord,
  deadLetterLogLine,
  type DeadLetterRecord,
} from "../src/messaging/deadLetter";
import {
  createScreenerEventsWorkHandler,
  type ScreenerEventsWorkHandlerDeps,
} from "../src/messaging/screenerEventsConsumer";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";
import {
  handleServiceUserRoutes,
  type ServiceUserRouteContext,
} from "../src/agents/routes/serviceUser";
import {
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";

const SERVICE_LOGIN = "svc-background";
const USER_LOGIN = "some-user";

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "env-1",
    source: "test",
    type: "options_analysis",
    time: new Date(0).toISOString(),
    data: { payload: { userLogin: USER_LOGIN } },
    jobid: "run-1",
    shardid: "unit-1",
    ...overrides,
  };
}

describe("background attribution (#1764)", () => {
  it("unattended dispatches carry x-actor-kind: background with x-user-login", () => {
    const headers = backgroundDispatchHeaders(SERVICE_LOGIN);
    expect(headers["x-user-login"]).toBe(SERVICE_LOGIN);
    expect(headers[BACKGROUND_ACTOR_HEADER]).toBe("background");
  });

  it("service login + background header resolves to background, header corroborated", () => {
    const attr = resolveActorAttribution(
      { "x-user-login": SERVICE_LOGIN, "x-actor-kind": "background" },
      SERVICE_LOGIN
    );
    expect(attr.actorKind).toBe("background");
    expect(attr.login).toBe(SERVICE_LOGIN);
    expect(attr.headerCorroborates).toBe(true);
    expect(attr.anomaly).toBeUndefined();
  });

  it("service login without the header still resolves to background by login equality", () => {
    const attr = resolveActorAttribution(
      { "x-user-login": SERVICE_LOGIN },
      SERVICE_LOGIN
    );
    expect(attr.actorKind).toBe("background");
    expect(attr.headerCorroborates).toBe(false);
  });

  it("a user login resolves to user even with a spoofed background header, flagged as anomaly", () => {
    const attr = resolveActorAttribution(
      { "x-user-login": USER_LOGIN, "x-actor-kind": "background" },
      SERVICE_LOGIN
    );
    expect(attr.actorKind).toBe("user");
    expect(attr.anomaly).toMatch(/background claimed/i);
  });

  it("no service configured means no background attribution from the header alone", () => {
    const attr = resolveActorAttribution(
      { "x-user-login": USER_LOGIN, "x-actor-kind": "background" },
      null
    );
    expect(attr.actorKind).toBe("user");
    expect(attr.anomaly).toBeDefined();
  });
});

describe("dead-letter records (#1764)", () => {
  it("a denied dispatch yields a structured record with queue, run, unit and actor", () => {
    const record: DeadLetterRecord = createDeadLetterRecord({
      queue: "screener-events",
      reason: "denied",
      messageId: "env-1",
      runId: "run-1",
      unitId: "unit-1",
      actorLogin: SERVICE_LOGIN,
      actorKind: "background",
      detail: "the service user is not provisioned for the platform tier",
    });
    expect(record.event).toBe("queue.dead_letter");
    expect(record.queue).toBe("screener-events");
    expect(record.reason).toBe("denied");
    expect(record.runId).toBe("run-1");
    expect(record.actorKind).toBe("background");
    const line = deadLetterLogLine(record);
    expect(line).toContain("queue.dead_letter");
    expect(line).toContain("run-1");
    expect(() => JSON.parse(line.replace(/^\[dead-letter\] /, ""))).not.toThrow();
  });

  it("an undecodable message yields a record even with no ids at all", () => {
    const record = createDeadLetterRecord({ reason: "undecodable", queue: "screener-events" });
    expect(record.reason).toBe("undecodable");
    expect(record.messageId).toBeNull();
  });

  it("the screener work handler drops unknown types and reports the drop through the dead-letter sink", async () => {
    const onDeadLetter = vi.fn();
    const deps: ScreenerEventsWorkHandlerDeps = {
      dispatchOptionsAnalysis: vi.fn(),
      onDeadLetter: { record: onDeadLetter },
    };
    const handler = createScreenerEventsWorkHandler(deps);
    const outcome = await handler(envelope({ type: "something.else", data: {} }));
    expect(outcome).toBe("drop");
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(onDeadLetter.mock.calls[0][0].reason).toBe("no_handler");
    expect(onDeadLetter.mock.calls[0][0].queue).toBe("screener-events");
  });

  it("a denied dispatch through the work handler drops and reports reason denied, never retries", async () => {
    const onDeadLetter = vi.fn();
    const deps: ScreenerEventsWorkHandlerDeps = {
      dispatchOptionsAnalysis: vi.fn().mockResolvedValue("denied"),
      onDeadLetter: { record: onDeadLetter },
    };
    const handler = createScreenerEventsWorkHandler(deps);
    const outcome = await handler(envelope());
    expect(outcome).toBe("drop");
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(onDeadLetter.mock.calls[0][0].reason).toBe("denied");
  });
});

// --- service-user provisioning checklist ---

const ADMIN_LOGIN = "admin-user";
const ADMIN_ID = "admin-id-1";
const SERVICE_ID = "service:svc-background";
const STATUS = "/api/admin/service-user/status";
const PROVISION = "/api/admin/service-user/provision";

function mapKv(seed: Record<string, string> = {}): KvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
}

function platformAdminMembership(userId: string): Membership {
  return {
    membershipId: `m-platform-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

async function makeCtx(opts: {
  preexisting?: Membership[];
  brokerageTokenPresent?: boolean | null;
}): Promise<{ ctx: ServiceUserRouteContext; store: MembershipStore }> {
  const store = createMemoryMembershipStore();
  await store.put(platformAdminMembership(ADMIN_ID));
  for (const m of opts.preexisting ?? []) await store.put(m);
  const kv = mapKv({
    [`${IAAA_ALIAS_KEY_PREFIX}login:${ADMIN_LOGIN}`]: JSON.stringify({
      githubLogin: ADMIN_LOGIN,
      internalUserId: ADMIN_ID,
      recordedAtMs: 1,
      source: "wired-login",
    }),
  });
  const ctx = {
    env: {},
    audit: vi.fn(),
    membershipStore: store,
    aliasKv: kv,
    serviceLogin: SERVICE_LOGIN,
    defaultTenantId: "primary",
    brokerageTokenPresent:
      opts.brokerageTokenPresent === undefined
        ? undefined
        : async () => opts.brokerageTokenPresent as boolean | null,
  } as unknown as ServiceUserRouteContext;
  return { ctx, store };
}

async function callStatus(ctx: ServiceUserRouteContext) {
  const req = new Request(`https://agent.test${STATUS}`, {
    method: "GET",
    headers: { "x-user-login": ADMIN_LOGIN },
  });
  const res = await handleServiceUserRoutes(req, new URL(`https://agent.test${STATUS}`), STATUS, "session-1", ctx);
  return { status: res!.status, body: (await res!.json()) as any };
}

describe("service-identity provisioning checklist (#1764)", () => {
  it("reports complete=true only when login, platform membership and token are all present", async () => {
    const { ctx } = await makeCtx({
      brokerageTokenPresent: true,
      preexisting: [
        {
          membershipId: "m-svc-platform",
          internalUserId: SERVICE_ID,
          tenantId: "primary",
          roleBindings: [{ role: "member", scope: "platform", grantedBy: ADMIN_ID }],
          createdBy: ADMIN_ID,
          createdAtMs: 1,
        },
      ],
    });
    const { status, body } = await callStatus(ctx);
    expect(status).toBe(200);
    expect(body.provisioning.complete).toBe(true);
    expect(body.provisioning.checklist.map((c: any) => `${c.id}:${c.status}`)).toEqual([
      "service_login_configured:pass",
      "platform_membership_live:pass",
      "brokerage_token_present:pass",
    ]);
    expect(body.provisioning.ownerActions).toEqual([]);
  });

  it("reports complete=false with explicit owner actions when platform and token are missing", async () => {
    const { ctx } = await makeCtx({ brokerageTokenPresent: false });
    const { status, body } = await callStatus(ctx);
    expect(status).toBe(200);
    expect(body.provisioning.complete).toBe(false);
    const byId = Object.fromEntries(body.provisioning.checklist.map((c: any) => [c.id, c.status]));
    expect(byId.platform_membership_live).toBe("fail");
    expect(byId.brokerage_token_present).toBe("fail");
    expect(body.provisioning.ownerActions.join(" ")).toMatch(/provision/i);
    expect(body.provisioning.ownerActions.join(" ")).toMatch(/E\*TRADE|token/i);
  });

  it("an expired platform binding is not live, and an unknown token read is reported unknown, not pass", async () => {
    const { ctx } = await makeCtx({
      brokerageTokenPresent: null,
      preexisting: [
        {
          membershipId: "m-svc-expired",
          internalUserId: SERVICE_ID,
          tenantId: "primary",
          roleBindings: [{ role: "member", scope: "platform", grantedBy: ADMIN_ID, expiresAtMs: 1 }],
          createdBy: ADMIN_ID,
          createdAtMs: 1,
        },
      ],
    });
    const { body } = await callStatus(ctx);
    const byId = Object.fromEntries(body.provisioning.checklist.map((c: any) => [c.id, c.status]));
    expect(byId.platform_membership_live).toBe("fail");
    expect(byId.brokerage_token_present).toBe("unknown");
    expect(body.provisioning.complete).toBe(false);
  });

  it("the pre-existing status fields are unchanged (additive checklist only)", async () => {
    const { ctx } = await makeCtx({ brokerageTokenPresent: true });
    // Provision platform first through the route, then read status.
    const provisionReq = new Request(`https://agent.test${PROVISION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": ADMIN_LOGIN },
      body: JSON.stringify({ tier: "platform" }),
    });
    await handleServiceUserRoutes(provisionReq, new URL(`https://agent.test${PROVISION}`), PROVISION, "session-1", ctx);
    const { body } = await callStatus(ctx);
    expect(body.serviceUser).toBe(SERVICE_LOGIN);
    expect(body.serviceInternalUserId).toBe(SERVICE_ID);
    expect(body.platform).not.toBeNull();
    expect(body.provisioning.complete).toBe(true);
  });
});
