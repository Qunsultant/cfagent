/**
 * Issue #5608 (G-11) — channel audit funnel: pin the wired funnel.
 *
 * Build-start enumeration (base c9cefef6d, recorded in the claim):
 * - routeRequest.ts:525 passes `audit` into handlePlatformChannelRoutes.
 * - platformChannels.ts emits one `platform-channel-admin` record per
 *   mutation, after the write: webhook-url :341 ("update-webhook-url"),
 *   slack-channel :396 ("update-slack-channel"), PATCH /channels :464
 *   ("update-channels" — a single record even when the patch writes both
 *   the flag store and the slack-channel store).
 * - The BizCopilot path was UNWIRED for the route-level record
 *   (bizCopilotChannels.ts:351 called the handler with no `audit` in ctx);
 *   this slice wires the turn audit through as the funnel, following the
 *   Accounts executor precedent — a BizCopilot mutation now emits BOTH the
 *   route record and the turn-level `bizcopilot.channel_action_executed`
 *   event. Reads emit no route record; failed mutations emit none;
 *   a throwing funnel never fails the write (best-effort-after-write).
 *
 * Audit-before-write is an OWNER decision (#5608) — not implemented here.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { DEFAULT_TENANT_CHANNELS } from "../src/data/tenantChannelPorts";
import {
  executeBizCopilotChannelIntent,
  runBizCopilotChannelBranch,
} from "../src/services/bizCopilotChannels";

const OPERATOR = "op";
const BIZCOPILOT_OPERATOR = "op@example.com";

function world() {
  const channels = new InMemoryTenantChannelAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("tenant-a", ["alice"]);
  directory.seedTenant("acme", ["alice"]);
  const audit = vi.fn();
  // #5867: audit-before-write needs a working IAAA audit store.
  const auditStore = createMemoryAuditStore();
  const operators = {
    listOperators: async () => [
      { login: OPERATOR, addedBy: "seed", addedAtMs: 1 },
      { login: BIZCOPILOT_OPERATOR, addedBy: "seed", addedAtMs: 1 },
    ],
  };
  return { channels, directory, audit, auditStore, operators };
}

function req(path: string, method: string, login: string | null, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(
  w: ReturnType<typeof world>,
  path: string,
  method: string,
  body?: unknown,
  audit?: unknown,
) {
  const res = await handlePlatformChannelRoutes(
    req(path, method, OPERATOR, body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    {
      env: { COMMERCIAL_STORE_OPERATORS: "" },
      audit: audit === undefined ? w.audit : (audit as never),
      auditStore: w.auditStore,
      channels: w.channels,
      directory: w.directory,
      operators: w.operators,
    } as never,
  );
  return { res, body: (await res?.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The one route-level record shape every mutation pin asserts. */
function expectRouteRecord(
  audit: ReturnType<typeof vi.fn>,
  action: string,
  tenantId = "tenant-a",
  login: string = OPERATOR,
) {
  expect(audit).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledWith("platform-channel-admin", "orchestrator", {
    actorLogin: login,
    action,
    tenantId,
  });
}

describe("channel audit funnel: every mutation emits its record (#5608)", () => {
  it("PUT webhook-url emits update-webhook-url with actor, action, tenantId", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/webhook-url", "PUT", {
      webhookUrl: "https://example.test/hook",
    });
    expect(res?.status).toBe(200);
    expect(body).toEqual({ tenantId: "tenant-a", webhookUrl: "https://example.test/hook" });
    expectRouteRecord(w.audit, "update-webhook-url");
  });

  it("PUT slack-channel emits update-slack-channel with actor, action, tenantId", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/slack-channel", "PUT", {
      slackChannel: "#general",
    });
    expect(res?.status).toBe(200);
    expect(body).toEqual({ tenantId: "tenant-a", slackChannel: "#general" });
    expectRouteRecord(w.audit, "update-slack-channel");
  });

  it("PATCH channels emits update-channels and the flags land", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/channels", "PATCH", {
      channels: { slack: false, docs: false },
    });
    expect(res?.status).toBe(200);
    expect(body.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false, docs: false });
    expectRouteRecord(w.audit, "update-channels");
    expect(await w.channels.getTenantChannels("tenant-a")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
      docs: false,
    });
  });

  it("PATCH channels carrying slackChannel writes both stores but emits ONE update-channels record", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/channels", "PATCH", {
      channels: { slack: false },
      slackChannel: "#general",
    });
    expect(res?.status).toBe(200);
    expect(body.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false });
    expect(body.slackChannel).toBe("#general");
    // Both writes landed…
    expect(await w.channels.getTenantChannels("tenant-a")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
    expect(await w.channels.getTenantSlackChannel("tenant-a")).toBe("#general");
    // …but the request emits a single audit record, not one per store.
    expectRouteRecord(w.audit, "update-channels");
  });

  it("a per-schedule webhook-url PUT audits as update-webhook-url", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/webhook-url", "PUT", {
      scheduleId: "sched-morning",
      webhookUrl: "https://hooks.alpha.example.com/sched-morning",
    });
    expect(res?.status).toBe(200);
    expect(body).toEqual({
      tenantId: "tenant-a",
      scheduleId: "sched-morning",
      webhookUrl: "https://hooks.alpha.example.com/sched-morning",
    });
    expectRouteRecord(w.audit, "update-webhook-url");
  });

  it("GET reads emit no audit record", async () => {
    const w = world();
    const read = await call(w, "/platform-channels/tenant-a", "GET");
    expect(read.res?.status).toBe(200);
    const webhookRead = await call(w, "/platform-channels/tenant-a/webhook-url", "GET");
    expect(webhookRead.res?.status).toBe(200);
    const slackRead = await call(w, "/platform-channels/tenant-a/slack-channel", "GET");
    expect(slackRead.res?.status).toBe(200);
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("failed mutations emit no audit record (404 unknown tenant, 400 bad body)", async () => {
    const w = world();
    const unknown = await call(w, "/platform-channels/nope/channels", "PATCH", {
      channels: { slack: false },
    });
    expect(unknown.res?.status).toBe(404);
    const badBody = await call(w, "/platform-channels/tenant-a/channels", "PATCH", {
      channels: { smoke: true },
    });
    expect(badBody.res?.status).toBe(400);
    const badUrl = await call(w, "/platform-channels/tenant-a/webhook-url", "PUT", {
      webhookUrl: "not-a-url",
    });
    expect(badUrl.res?.status).toBe(400);
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("a throwing audit funnel never fails the write (best-effort-after-write)", async () => {
    const w = world();
    const throwing = vi.fn(() => {
      throw new Error("audit store down");
    });
    const { res, body } = await call(
      w,
      "/platform-channels/tenant-a/channels",
      "PATCH",
      { channels: { slack: false } },
      throwing,
    );
    expect(res?.status).toBe(200);
    expect(body.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(await w.channels.getTenantChannels("tenant-a")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
  });

  it("no audit funnel supplied: the mutation still succeeds (annotation is a no-op)", async () => {
    const w = world();
    const { res, body } = await call(
      w,
      "/platform-channels/tenant-a/slack-channel",
      "PUT",
      { slackChannel: "#general" },
      null,
    );
    expect(res?.status).toBe(200);
    expect(body).toEqual({ tenantId: "tenant-a", slackChannel: "#general" });
  });
});

describe("channel audit funnel: wiring pins (#5608)", () => {
  it("routeRequest.ts supplies the orchestrator audit funnel to handlePlatformChannelRoutes", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "agents", "orchestrator", "routeRequest.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /handlePlatformChannelRoutes\([\s\S]*?audit:\s*\(type,\s*agent,\s*payload\)\s*=>\s*deps\.audit\(type,\s*agent,\s*payload\)/,
    );
  });

  it("bizCopilotChannels.ts passes the turn audit through as the route handler's funnel", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "services", "bizCopilotChannels.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /handlePlatformChannelRoutes\([\s\S]*?audit:\s*\(type,\s*_agent,\s*payload\)\s*=>\s*deps\.audit\?\.?\(type,\s*payload\)/,
    );
  });
});

describe("channel audit funnel: BizCopilot path (#5608)", () => {
  function bizWorld() {
    const channels = new InMemoryTenantChannelAdapter();
    const directory = new InMemoryTenantDirectoryAdapter();
    directory.seedTenant("acme", ["alice"]);
    // #5867: audit-before-write needs a working IAAA audit store.
    const auditStore = createMemoryAuditStore();
    const operators = {
      listOperators: async () => [
        { login: BIZCOPILOT_OPERATOR, addedBy: "seed", addedAtMs: 1 },
      ],
    };
    return { channels, directory, auditStore, operators };
  }

  it("a BizCopilot mutation emits BOTH the route record and the turn event", async () => {
    const w = bizWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "BizCopilot",
      userText: "Disable slack for tenant acme",
      env: {},
      userLogin: BIZCOPILOT_OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      auditStore: w.auditStore,
      channels: w.channels,
      directory: w.directory,
      operators: w.operators,
    });
    expect(context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")).toBe(true);
    expect(audits).toHaveLength(2);
    // The route record fires first (during execution), the turn event second.
    expect(audits[0]).toEqual({
      type: "platform-channel-admin",
      payload: { actorLogin: BIZCOPILOT_OPERATOR, action: "update-channels", tenantId: "acme" },
    });
    expect(audits[1]).toMatchObject({
      type: "bizcopilot.channel_action_executed",
      payload: { sourceTab: "BizCopilot", action: "disable", tenantId: "acme", channel: "slack" },
    });
    // Regression: the mutation itself is unchanged.
    expect(await w.channels.getTenantChannels("acme")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
  });

  it("a BizCopilot read emits only the turn event — no route record", async () => {
    const w = bizWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "BizCopilot",
      userText: "Show channels for tenant acme",
      env: {},
      userLogin: BIZCOPILOT_OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      auditStore: w.auditStore,
      channels: w.channels,
      directory: w.directory,
      operators: w.operators,
    });
    expect(context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.type).toBe("bizcopilot.channel_action_executed");
  });

  it("executeBizCopilotChannelIntent with an audit dep emits the route record directly", async () => {
    const w = bizWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await executeBizCopilotChannelIntent(
      { action: "enable", tenantId: "acme", channel: "email" },
      {
        env: {},
        userLogin: BIZCOPILOT_OPERATOR,
        audit: (type, payload) => audits.push({ type, payload }),
      auditStore: w.auditStore,
        channels: w.channels,
        directory: w.directory,
        operators: w.operators,
      },
    );
    expect(context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")).toBe(true);
    expect(audits).toEqual([
      {
        type: "platform-channel-admin",
        payload: {
          actorLogin: BIZCOPILOT_OPERATOR,
          action: "update-channels",
          tenantId: "acme",
        },
      },
    ]);
    expect(await w.channels.getTenantChannels("acme")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      email: true,
    });
  });
});
