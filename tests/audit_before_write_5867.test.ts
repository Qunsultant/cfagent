/**
 * Issue #5867 — audit-before-write for channel mutations.
 *
 * Build-start facts (base 6bba96f9a, recorded in the claim):
 * - The `ctx.audit` funnel is a turn-level mas_events annotation
 *   (OrchestratorAgent.audit -> recordAudit -> mas_events), NOT the IAAA
 *   audit chain. The before-write record goes through `recordAuditEvent`
 *   over the wired store (SessionStore DO audit-append).
 * - E5 (audit-canonical-store-5084): channel mutations are
 *   consequential, so a failed audit write BLOCKS the mutation.
 * - The funnel annotation stays after the write (#5608 pins); this file
 *   pins the IAAA chain record BEFORE the write.
 * - Residual (documented, not solved): a D1 write failing after a
 *   successful audit append leaves an audit record for a change that
 *   never landed — the chain has no rollback for this.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { DEFAULT_TENANT_CHANNELS } from "../src/data/tenantChannelPorts";
import {
  createMemoryAuditStore,
  type AuditStore,
} from "../src/security/iaaaAudit";
import {
  executeBizCopilotChannelIntent,
  runBizCopilotChannelBranch,
} from "../src/services/bizCopilotChannels";

const OPERATOR = "op";
const BIZCOPILOT_OPERATOR = "op@example.com";

/** An audit store whose appends always fail (the audit store is down). */
function failingAuditStore(): AuditStore {
  return {
    append: async () => {
      throw new Error("audit store down");
    },
    list: async () => [],
  };
}

function world() {
  const channels = new InMemoryTenantChannelAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("tenant-a", ["alice"]);
  directory.seedTenant("acme", ["alice"]);
  const audit = vi.fn();
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
  auditStore?: AuditStore,
) {
  const res = await handlePlatformChannelRoutes(
    req(path, method, OPERATOR, body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    {
      env: { COMMERCIAL_STORE_OPERATORS: "" },
      audit: w.audit,
      auditStore: auditStore ?? w.auditStore,
      channels: w.channels,
      directory: w.directory,
      operators: w.operators,
    } as never,
  );
  return { res, body: (await res?.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The one IAAA chain-record shape every before-write pin asserts. */
async function expectChainRecord(
  auditStore: AuditStore,
  action: string,
  tenantId = "tenant-a",
  login: string = OPERATOR,
) {
  const events = await auditStore.list();
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(event.action).toBe(action);
  expect(event.type).toBe("platform-channel-admin");
  expect(event.tenantId).toBe(tenantId);
  expect(event.actorPrincipalId).toBe(login);
  expect(event.initiatingPrincipalId).toBe(login);
  expect(event.actorType).toBe("human");
  expect(event.decision).toBe("allow");
  expect(event.policyVersion).toBe("iaaa-audit-1");
  // The record is written before the write runs, so its outcome is
  // pending — the funnel record after the write carries the outcome.
  expect(event.outcome).toBe("pending");
  expect(typeof event.correlationId).toBe("string");
  expect(event.correlationId.length).toBeGreaterThan(0);
}

describe("audit-before-write: the IAAA record lands before the D1 write (#5867)", () => {
  it("PUT webhook-url writes the chain record, then the write, then the funnel record", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/webhook-url", "PUT", {
      webhookUrl: "https://example.test/hook",
    });
    expect(res?.status).toBe(200);
    expect(body).toEqual({ tenantId: "tenant-a", webhookUrl: "https://example.test/hook" });
    await expectChainRecord(w.auditStore, "update-webhook-url");
    expect(w.audit).toHaveBeenCalledTimes(1);
    expect(await w.channels.getTenantWebhookUrl("tenant-a")).toBe("https://example.test/hook");
  });

  it("PUT slack-channel writes the chain record before the write", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/slack-channel", "PUT", {
      slackChannel: "#general",
    });
    expect(res?.status).toBe(200);
    expect(body).toEqual({ tenantId: "tenant-a", slackChannel: "#general" });
    await expectChainRecord(w.auditStore, "update-slack-channel");
    expect(w.audit).toHaveBeenCalledTimes(1);
    expect(await w.channels.getTenantSlackChannel("tenant-a")).toBe("#general");
  });

  it("PATCH channels writes ONE chain record before writing both stores", async () => {
    const w = world();
    const { res, body } = await call(w, "/platform-channels/tenant-a/channels", "PATCH", {
      channels: { slack: false },
      slackChannel: "#general",
    });
    expect(res?.status).toBe(200);
    expect(body.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false });
    await expectChainRecord(w.auditStore, "update-channels");
    expect(w.audit).toHaveBeenCalledTimes(1);
    expect(await w.channels.getTenantChannels("tenant-a")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
    expect(await w.channels.getTenantSlackChannel("tenant-a")).toBe("#general");
  });
});

describe("audit-before-write: a failed audit write BLOCKS the mutation (#5867)", () => {
  it("PUT webhook-url with a down audit store is a coded 503 and writes nothing", async () => {
    const w = world();
    const { res, body } = await call(
      w,
      "/platform-channels/tenant-a/webhook-url",
      "PUT",
      { webhookUrl: "https://example.test/hook" },
      failingAuditStore(),
    );
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(await w.channels.getTenantWebhookUrl("tenant-a")).toBeNull();
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("PUT slack-channel with a down audit store is a coded 503 and writes nothing", async () => {
    const w = world();
    const { res, body } = await call(
      w,
      "/platform-channels/tenant-a/slack-channel",
      "PUT",
      { slackChannel: "#general" },
      failingAuditStore(),
    );
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(await w.channels.getTenantSlackChannel("tenant-a")).toBeNull();
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("PATCH channels with a down audit store writes NEITHER store", async () => {
    const w = world();
    const { res, body } = await call(
      w,
      "/platform-channels/tenant-a/channels",
      "PATCH",
      { channels: { slack: false }, slackChannel: "#general" },
      failingAuditStore(),
    );
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(await w.channels.getTenantChannels("tenant-a")).toEqual(DEFAULT_TENANT_CHANNELS);
    expect(await w.channels.getTenantSlackChannel("tenant-a")).toBeNull();
    expect(w.audit).not.toHaveBeenCalled();
  });
});

describe("audit-before-write: validation and reads never consult the audit store (#5867)", () => {
  it("a 400 bad body consumes no chain record — and a down store still answers 400", async () => {
    const w = world();
    const badBody = await call(
      w,
      "/platform-channels/tenant-a/channels",
      "PATCH",
      { channels: { smoke: true } },
      failingAuditStore(),
    );
    expect(badBody.res?.status).toBe(400);
    expect(await w.auditStore.list()).toHaveLength(0);

    const badUrl = await call(
      w,
      "/platform-channels/tenant-a/webhook-url",
      "PUT",
      { webhookUrl: "not-a-url" },
      failingAuditStore(),
    );
    expect(badUrl.res?.status).toBe(400);
    expect(await w.auditStore.list()).toHaveLength(0);
  });

  it("a 404 unknown tenant consumes no chain record", async () => {
    const w = world();
    const unknown = await call(
      w,
      "/platform-channels/nope/channels",
      "PATCH",
      { channels: { slack: false } },
      failingAuditStore(),
    );
    expect(unknown.res?.status).toBe(404);
    expect(await w.auditStore.list()).toHaveLength(0);
  });

  it("GET reads write no chain record", async () => {
    const w = world();
    const read = await call(w, "/platform-channels/tenant-a", "GET");
    expect(read.res?.status).toBe(200);
    expect(await w.auditStore.list()).toHaveLength(0);
  });

  it("a throwing funnel never fails the write (the funnel stays best-effort)", async () => {
    const w = world();
    const throwing = vi.fn(() => {
      throw new Error("funnel down");
    });
    const res = await handlePlatformChannelRoutes(
      req("/platform-channels/tenant-a/channels", "PATCH", OPERATOR, {
        channels: { slack: false },
      }),
      new URL("https://worker.test/platform-channels/tenant-a/channels"),
      "/platform-channels/tenant-a/channels",
      "session-1",
      {
        env: { COMMERCIAL_STORE_OPERATORS: "" },
        audit: throwing,
        auditStore: w.auditStore,
        channels: w.channels,
        directory: w.directory,
        operators: w.operators,
      } as never,
    );
    expect(res?.status).toBe(200);
    await expectChainRecord(w.auditStore, "update-channels");
    expect(await w.channels.getTenantChannels("tenant-a")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
  });
});

describe("audit-before-write: BizCopilot path (#5867)", () => {
  function bizWorld() {
    const channels = new InMemoryTenantChannelAdapter();
    const directory = new InMemoryTenantDirectoryAdapter();
    directory.seedTenant("acme", ["alice"]);
    const auditStore = createMemoryAuditStore();
    const operators = {
      listOperators: async () => [
        { login: BIZCOPILOT_OPERATOR, addedBy: "seed", addedAtMs: 1 },
      ],
    };
    return { channels, directory, auditStore, operators };
  }

  it("a BizCopilot mutation writes the chain record, the route record, and the turn event", async () => {
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
    await expectChainRecord(w.auditStore, "update-channels", "acme", BIZCOPILOT_OPERATOR);
    expect(audits).toHaveLength(2);
    expect(audits[0]?.type).toBe("platform-channel-admin");
    expect(audits[1]?.type).toBe("bizcopilot.channel_action_executed");
    expect(await w.channels.getTenantChannels("acme")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
  });

  it("a BizCopilot mutation with a down audit store is refused and writes nothing", async () => {
    const w = bizWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "BizCopilot",
      userText: "Disable slack for tenant acme",
      env: {},
      userLogin: BIZCOPILOT_OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      auditStore: failingAuditStore(),
      channels: w.channels,
      directory: w.directory,
      operators: w.operators,
    });
    expect(context.startsWith("BIZCOPILOT_CHANNEL_ERROR: ")).toBe(true);
    expect(context).toContain("503");
    expect(context).toContain("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(await w.channels.getTenantChannels("acme")).toEqual(DEFAULT_TENANT_CHANNELS);
    // No route record (the write never ran); only the turn event fires.
    expect(audits).toHaveLength(1);
    expect(audits[0]?.type).toBe("bizcopilot.channel_action_executed");
  });

  it("executeBizCopilotChannelIntent with a down audit store returns the coded refusal", async () => {
    const w = bizWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await executeBizCopilotChannelIntent(
      { action: "enable", tenantId: "acme", channel: "email" },
      {
        env: {},
        userLogin: BIZCOPILOT_OPERATOR,
        audit: (type, payload) => audits.push({ type, payload }),
        auditStore: failingAuditStore(),
        channels: w.channels,
        directory: w.directory,
        operators: w.operators,
      },
    );
    expect(context.startsWith("BIZCOPILOT_CHANNEL_ERROR: ")).toBe(true);
    expect(context).toContain("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(await w.channels.getTenantChannels("acme")).toEqual(DEFAULT_TENANT_CHANNELS);
    expect(audits).toHaveLength(0);
  });
});

describe("audit-before-write: structural pins (#5867)", () => {
  it("the route handler records through recordAuditEvent and blocks consequential actions on failure", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "agents", "routes", "platformChannels.ts"),
      "utf8",
    );
    expect(src).toContain("recordAuditEvent");
    expect(src).toContain('shouldBlockAction("consequential"');
    expect(src).toContain("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(src).toContain("createWiredAuditStore");
    // The before-write record precedes the first D1 write in every
    // mutation branch: one awaited auditBeforeWrite call per branch,
    // each placed before its branch's setTenant* write.
    expect(src.match(/await auditBeforeWrite\(/g)).toHaveLength(3);
    const calls = [...src.matchAll(/await auditBeforeWrite\(/g)].map((m) => m.index!);
    for (const write of [
      "channels.setTenantWebhookUrl(",
      "channels.setTenantSlackChannel(",
      "channels.setTenantChannels(",
    ]) {
      const writeAt = src.indexOf(write);
      expect(writeAt).toBeGreaterThan(0);
      expect(calls.some((c) => c < writeAt)).toBe(true);
    }
  });

  it("the BizCopilot executor threads the audit store seam into the route handler", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "services", "bizCopilotChannels.ts"),
      "utf8",
    );
    expect(src).toMatch(/auditStore:\s*deps\.auditStore/);
  });

  it("the new code is in the outcome catalog at 503", async () => {
    const { resolveOutcome } = await import("../src/outcomes/outcomeAspects");
    const outcome = resolveOutcome("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(outcome.entry?.httpStatus).toBe(503);
    expect(outcome.entry?.code).toBe("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
  });
});
