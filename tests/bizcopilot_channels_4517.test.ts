/**
 * Issue #4517 (BizCopilot slice 3) — the deterministic channel
 * branch: intent parsing + enforcement derivation + in-process
 * execution through the Channels page's own routes.
 *
 * The fakes below are the route handler's own test seams
 * (channels / directory / operators) over the port's own
 * in-memory adapters, so the executor is exercised through the
 * real handler — gate, partial-patch merge, and 404/403
 * outcomes included — not through a stub of it. No dispatch is
 * ever attempted here: enforcement is reported from the read
 * config through the gate's own primitives.
 */
import { describe, it, expect } from "vitest";
import {
  BIZCOPILOT_CHANNELS_PAGE_URL,
  channelFromName,
  describeChannelEnforcement,
  executeBizCopilotChannelIntent,
  parseBizCopilotChannelIntent,
  runBizCopilotChannelBranch,
} from "../src/services/bizCopilotChannels";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import {
  DEFAULT_TENANT_CHANNELS,
  type TenantChannelConfig,
} from "../src/data/tenantChannelPorts";
import type { StoreOperators, StoreOperatorEntry } from "../src/data/storeOperatorsPorts";

const OPERATOR = "op@example.com";
const NON_OPERATOR = "mallory@example.com";

function makeWorld() {
  const channels = new InMemoryTenantChannelAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("acme", ["alice"]);
  const operators: Pick<StoreOperators, "listOperators"> = {
    listOperators: async () =>
      [{ login: OPERATOR, addedBy: "seed", addedAtMs: 1 }] as unknown as StoreOperatorEntry[],
  };
  // #5867: audit-before-write needs a working IAAA audit store.
  const auditStore = createMemoryAuditStore();
  return {
    channels,
    directory,
    auditStore,
    deps: (userLogin: string) => ({
      env: {},
      userLogin,
      auditStore,
      channels,
      directory,
      operators,
    }),
  };
}

function parseResult(context: string): Record<string, unknown> {
  const marker = context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")
    ? "BIZCOPILOT_CHANNEL_RESULT: "
    : "BIZCOPILOT_CHANNEL_ERROR: ";
  expect(context.startsWith(marker)).toBe(true);
  return JSON.parse(context.slice(marker.length)) as Record<string, unknown>;
}

function enforcementOf(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = parsed["result"] as { enforcement: Array<Record<string, unknown>> };
  return result.enforcement;
}

describe("BizCopilot channel intent parsing (#4517)", () => {
  it("parses enablement reads", () => {
    expect(parseBizCopilotChannelIntent("Show channels for tenant acme")).toEqual({
      action: "show",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("show channel enablement for acme")).toEqual({
      action: "show",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("List channels for tenant acme")).toEqual({
      action: "show",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("What channels are enabled for tenant acme?")).toEqual({
      action: "show",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("Show channel settings for tenant acme")).toEqual({
      action: "show",
      tenantId: "acme",
    });
  });

  it("parses enable and disable for every channel, including the two-word Copilot card name", () => {
    expect(parseBizCopilotChannelIntent("Enable email for tenant acme")).toEqual({
      action: "enable",
      tenantId: "acme",
      channel: "email",
    });
    expect(parseBizCopilotChannelIntent("disable slack for acme")).toEqual({
      action: "disable",
      tenantId: "acme",
      channel: "slack",
    });
    expect(parseBizCopilotChannelIntent("Turn off webhook for tenant acme")).toEqual({
      action: "disable",
      tenantId: "acme",
      channel: "webhook",
    });
    expect(parseBizCopilotChannelIntent("Switch on docs for tenant acme")).toEqual({
      action: "enable",
      tenantId: "acme",
      channel: "docs",
    });
    expect(parseBizCopilotChannelIntent("Set copilot card off for tenant acme")).toEqual({
      action: "disable",
      tenantId: "acme",
      channel: "copilot",
    });
    expect(parseBizCopilotChannelIntent("Enable copilot for tenant acme")).toEqual({
      action: "enable",
      tenantId: "acme",
      channel: "copilot",
    });
    expect(parseBizCopilotChannelIntent("Set email on for acme")).toEqual({
      action: "enable",
      tenantId: "acme",
      channel: "email",
    });
  });

  it("parses enforcement reads, whole-tenant and single-channel", () => {
    expect(parseBizCopilotChannelIntent("Show enforcement for tenant acme")).toEqual({
      action: "enforcement",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("Show enforcement state for acme")).toEqual({
      action: "enforcement",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("What is the enforcement state for tenant acme?")).toEqual({
      action: "enforcement",
      tenantId: "acme",
    });
    expect(parseBizCopilotChannelIntent("Is email enabled for tenant acme?")).toEqual({
      action: "enforcement",
      tenantId: "acme",
      channel: "email",
    });
    expect(parseBizCopilotChannelIntent("Is slack disabled for acme")).toEqual({
      action: "enforcement",
      tenantId: "acme",
      channel: "slack",
    });
    expect(parseBizCopilotChannelIntent("Is copilot card on for tenant acme")).toEqual({
      action: "enforcement",
      tenantId: "acme",
      channel: "copilot",
    });
  });

  it("refuses to guess an unknown channel or a malformed id", () => {
    expect(parseBizCopilotChannelIntent("Enable pigeon for tenant acme")).toBeNull();
    expect(parseBizCopilotChannelIntent("Enable email for tenant a b")).toBeNull();
    expect(channelFromName("pigeon")).toBeNull();
    expect(channelFromName("sms")).toBeNull();
  });

  it("asks for the tenant id on a recognizable-but-incomplete command (#4701)", () => {
    expect(parseBizCopilotChannelIntent("Show channels")).toEqual({
      action: "needs-identifier",
      command: "show",
      tenantId: null,
    });
    expect(parseBizCopilotChannelIntent("What channels are enabled?")).toEqual({
      action: "needs-identifier",
      command: "show",
      tenantId: null,
    });
    expect(parseBizCopilotChannelIntent("Show enforcement")).toEqual({
      action: "needs-identifier",
      command: "enforcement",
      tenantId: null,
    });
    expect(parseBizCopilotChannelIntent("Is email enabled?")).toEqual({
      action: "needs-identifier",
      command: "enforcement",
      tenantId: null,
      channel: "email",
    });
    expect(parseBizCopilotChannelIntent("Is slack off")).toEqual({
      action: "needs-identifier",
      command: "enforcement",
      tenantId: null,
      channel: "slack",
    });
    expect(parseBizCopilotChannelIntent("Enable email")).toEqual({
      action: "needs-identifier",
      command: "enable",
      tenantId: null,
      channel: "email",
    });
    expect(parseBizCopilotChannelIntent("Disable slack")).toEqual({
      action: "needs-identifier",
      command: "disable",
      tenantId: null,
      channel: "slack",
    });
    expect(parseBizCopilotChannelIntent("Turn off webhook")).toEqual({
      action: "needs-identifier",
      command: "disable",
      tenantId: null,
      channel: "webhook",
    });
    expect(parseBizCopilotChannelIntent("Set copilot card off")).toEqual({
      action: "needs-identifier",
      command: "disable",
      tenantId: null,
      channel: "copilot",
    });
    expect(parseBizCopilotChannelIntent("Set docs on")).toEqual({
      action: "needs-identifier",
      command: "enable",
      tenantId: null,
      channel: "docs",
    });
  });

  it("returns null for anything that is not an explicit channel command", () => {
    for (const text of [
      "What is the weather?",
      "Show tenant acme",
      "Show settings for tenant acme",
      "Show account alice@example.com",
      "Enable ads for acme",
      "Tell me about channels",
      "Send an email to tenant acme",
      "Send a Slack message to acme",
    ]) {
      expect(parseBizCopilotChannelIntent(text), text).toBeNull();
    }
  });
});

describe("BizCopilot channel enforcement derivation (#4517)", () => {
  it("reports permitted dispatch for enabled push channels and configuration-only for Copilot card / Docs", () => {
    const states = describeChannelEnforcement("acme", { ...DEFAULT_TENANT_CHANNELS });
    expect(states).toHaveLength(5);
    const byId = Object.fromEntries(states.map((s) => [s.channel, s]));
    expect(byId["email"]).toMatchObject({ label: "Email", enabled: true, dispatch: "permitted" });
    expect(byId["slack"]).toMatchObject({ label: "Slack", enabled: true, dispatch: "permitted" });
    expect(byId["webhook"]).toMatchObject({ label: "Webhook", enabled: true, dispatch: "permitted" });
    expect(byId["copilot"]).toMatchObject({
      label: "Copilot card",
      enabled: true,
      dispatch: "configuration-only",
    });
    expect(byId["copilot"].state).toContain("configuration only");
    expect(byId["copilot"].state).toContain("no dispatch exists");
    expect(byId["docs"]).toMatchObject({ label: "Docs", enabled: true, dispatch: "configuration-only" });
    expect(byId["docs"].state).toContain("configuration only");
    expect(byId["docs"].state).toContain("no dispatch exists");
  });

  it("reports a disabled push channel as refused, never attempted, in the gate's own words", () => {
    const config: TenantChannelConfig = { ...DEFAULT_TENANT_CHANNELS, email: false, slack: false };
    const states = describeChannelEnforcement("acme", config);
    const byId = Object.fromEntries(states.map((s) => [s.channel, s]));
    expect(byId["email"]).toMatchObject({ enabled: false, dispatch: "refused" });
    expect(byId["email"].state).toContain('Channel "email" is disabled for tenant "acme"');
    expect(byId["email"].state).toContain("never attempted");
    expect(byId["slack"]).toMatchObject({ enabled: false, dispatch: "refused" });
    expect(byId["webhook"]).toMatchObject({ enabled: true, dispatch: "permitted" });
  });

  it("reports a disabled Copilot card / Docs flag as configuration-only, never as a refused dispatch", () => {
    const config: TenantChannelConfig = { ...DEFAULT_TENANT_CHANNELS, copilot: false, docs: false };
    const states = describeChannelEnforcement("acme", config);
    const byId = Object.fromEntries(states.map((s) => [s.channel, s]));
    expect(byId["copilot"]).toMatchObject({ enabled: false, dispatch: "configuration-only" });
    expect(byId["copilot"].state).toContain("configuration only");
    expect(byId["copilot"].state).toContain("no dispatch exists");
    expect(byId["docs"]).toMatchObject({ enabled: false, dispatch: "configuration-only" });
    expect(byId["docs"].state).toContain("configuration only");
  });
});

describe("BizCopilot channel execution through the page's routes (#4517)", () => {
  it("reads enablement with defaults for an unconfigured tenant, plus enforcement state and the page link", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotChannelIntent(
      { action: "show", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    const parsed = parseResult(context);
    expect(parsed["action"]).toBe("show");
    expect(parsed["tenantId"]).toBe("acme");
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_CHANNELS_PAGE_URL);
    const result = parsed["result"] as { channels: TenantChannelConfig };
    expect(result.channels).toEqual(DEFAULT_TENANT_CHANNELS);
    const states = enforcementOf(parsed);
    expect(states).toHaveLength(5);
    expect(states.find((s) => s["channel"] === "email")).toMatchObject({ dispatch: "permitted" });
    expect(states.find((s) => s["channel"] === "copilot")).toMatchObject({
      dispatch: "configuration-only",
    });
  });

  it("enables and disables one flag at a time, merging over the stored config", async () => {
    const world = makeWorld();
    const disabled = await executeBizCopilotChannelIntent(
      { action: "disable", tenantId: "acme", channel: "slack" },
      world.deps(OPERATOR),
    );
    const disabledParsed = parseResult(disabled);
    expect(disabledParsed["action"]).toBe("disable");
    expect(disabledParsed["channel"]).toBe("slack");
    expect(disabledParsed["pageUrl"]).toBe(BIZCOPILOT_CHANNELS_PAGE_URL);
    const disabledResult = disabledParsed["result"] as { channels: TenantChannelConfig };
    expect(disabledResult.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false });
    expect(
      enforcementOf(disabledParsed).find((s) => s["channel"] === "slack"),
    ).toMatchObject({ enabled: false, dispatch: "refused" });

    const reenabled = await executeBizCopilotChannelIntent(
      { action: "enable", tenantId: "acme", channel: "slack" },
      world.deps(OPERATOR),
    );
    const reenabledResult = parseResult(reenabled)["result"] as { channels: TenantChannelConfig };
    expect(reenabledResult.channels).toEqual(DEFAULT_TENANT_CHANNELS);

    // A second flag change leaves the first flag's restored value alone.
    await executeBizCopilotChannelIntent(
      { action: "disable", tenantId: "acme", channel: "email" },
      world.deps(OPERATOR),
    );
    const reread = await executeBizCopilotChannelIntent(
      { action: "show", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    const rereadResult = parseResult(reread)["result"] as { channels: TenantChannelConfig };
    expect(rereadResult.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, email: false });
  });

  it("reports enforcement state from the read config, including a refused channel", async () => {
    const world = makeWorld();
    await world.channels.setTenantChannels("acme", { webhook: false });
    const context = await executeBizCopilotChannelIntent(
      { action: "enforcement", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    const parsed = parseResult(context);
    expect(parsed["action"]).toBe("enforcement");
    const states = enforcementOf(parsed);
    expect(states.find((s) => s["channel"] === "webhook")).toMatchObject({
      enabled: false,
      dispatch: "refused",
    });
    expect(states.find((s) => s["channel"] === "email")).toMatchObject({
      enabled: true,
      dispatch: "permitted",
    });
  });

  it("answers a single-channel enforcement question from the read config", async () => {
    const world = makeWorld();
    await world.channels.setTenantChannels("acme", { email: false });
    const context = await executeBizCopilotChannelIntent(
      { action: "enforcement", tenantId: "acme", channel: "email" },
      world.deps(OPERATOR),
    );
    const parsed = parseResult(context);
    expect(parsed["channel"]).toBe("email");
    expect(enforcementOf(parsed).find((s) => s["channel"] === "email")).toMatchObject({
      enabled: false,
      dispatch: "refused",
    });
  });

  it("toggles Copilot card / Docs flags like the page does, and states plainly that no dispatch exists", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotChannelIntent(
      { action: "disable", tenantId: "acme", channel: "copilot" },
      world.deps(OPERATOR),
    );
    const parsed = parseResult(context);
    expect(parsed["action"]).toBe("disable");
    expect(parsed["channel"]).toBe("copilot");
    const result = parsed["result"] as { channels: TenantChannelConfig };
    expect(result.channels.copilot).toBe(false);
    const copilot = enforcementOf(parsed).find((s) => s["channel"] === "copilot");
    expect(copilot).toMatchObject({ enabled: false, dispatch: "configuration-only" });
    expect(String(copilot?.["state"])).toContain("configuration only");
    expect(String(copilot?.["state"])).toContain("no dispatch exists");
    // The whole result never claims a dispatch happened.
    expect(context).not.toMatch(/sent a|dispatched|delivered a/i);

    const docs = await executeBizCopilotChannelIntent(
      { action: "enable", tenantId: "acme", channel: "docs" },
      world.deps(OPERATOR),
    );
    const docsParsed = parseResult(docs);
    const docsState = enforcementOf(docsParsed).find((s) => s["channel"] === "docs");
    expect(docsState).toMatchObject({ enabled: true, dispatch: "configuration-only" });
    expect(String(docsState?.["state"])).toContain("no dispatch exists");
  });

  it("surfaces an unknown tenant as an explicit error outcome", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotChannelIntent(
      { action: "show", tenantId: "ghost" },
      world.deps(OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_CHANNEL_ERROR: ")).toBe(true);
    const parsed = parseResult(context);
    expect(parsed["status"]).toBe(404);
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_CHANNELS_PAGE_URL);
  });

  it("enforces the store-operator gate: a non-operator gets a 403 outcome and writes nothing", async () => {
    const world = makeWorld();
    const read = await executeBizCopilotChannelIntent(
      { action: "show", tenantId: "acme" },
      world.deps(NON_OPERATOR),
    );
    expect(read.startsWith("BIZCOPILOT_CHANNEL_ERROR: ")).toBe(true);
    expect(parseResult(read)["status"]).toBe(403);

    const write = await executeBizCopilotChannelIntent(
      { action: "disable", tenantId: "acme", channel: "email" },
      world.deps(NON_OPERATOR),
    );
    expect(parseResult(write)["status"]).toBe(403);

    const reread = await executeBizCopilotChannelIntent(
      { action: "show", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    const rereadResult = parseResult(reread)["result"] as { channels: TenantChannelConfig };
    expect(rereadResult.channels).toEqual(DEFAULT_TENANT_CHANNELS);
  });

  it("fails closed without a verified login", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotChannelIntent(
      { action: "show", tenantId: "acme" },
      world.deps(""),
    );
    expect(context.startsWith("BIZCOPILOT_CHANNEL_ERROR: ")).toBe(true);
    expect(parseResult(context)["status"]).toBe(401);
  });

  it("answers a needs-identifier intent with the question and the page link, calling no route (#4701)", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotChannelIntent(
      { action: "needs-identifier", command: "disable", tenantId: null, channel: "slack" },
      world.deps(OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")).toBe(true);
    const parsed = parseResult(context);
    expect(parsed["action"]).toBe("needs-identifier");
    expect(parsed["command"]).toBe("disable");
    expect(parsed["channel"]).toBe("slack");
    expect(parsed["tenantId"]).toBeNull();
    expect(parsed["needsIdentifier"]).toBe(true);
    expect(parsed["ask"]).toContain("Disable slack for tenant acme");
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_CHANNELS_PAGE_URL);
    expect(await world.channels.getTenantChannels("acme")).toEqual(DEFAULT_TENANT_CHANNELS);
  });
});

describe("BizCopilot channel turn branch (#4517)", () => {
  it("returns empty context for a non-BizCopilot turn", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "Stock Copilot",
      userText: "Show channels for tenant acme",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(context).toBe("");
    expect(audits).toEqual([]);
    expect(await world.channels.getTenantChannels("acme")).toEqual(DEFAULT_TENANT_CHANNELS);
  });

  it("returns empty context when the BizCopilot text is not a channel command", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "BizCopilot",
      userText: "What can you do here?",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(context).toBe("");
    expect(audits).toEqual([]);
  });

  it("executes a BizCopilot channel command and audits the action", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "BizCopilot",
      userText: "Disable slack for tenant acme",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      // #5867: audit-before-write needs a working IAAA audit store.
      auditStore: world.auditStore,
      channels: world.channels,
      directory: world.directory,
      operators: world.deps(OPERATOR).operators,
    });
    expect(context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")).toBe(true);
    // Issue #5608 (G-11): a BizCopilot mutation now emits BOTH the route
    // record (the turn audit passed through as the handler's funnel) and
    // the turn event — the Accounts executor's shape.
    expect(audits).toHaveLength(2);
    expect(audits[0]).toEqual({
      type: "platform-channel-admin",
      payload: { actorLogin: OPERATOR, action: "update-channels", tenantId: "acme" },
    });
    expect(audits[1]).toMatchObject({
      type: "bizcopilot.channel_action_executed",
      payload: {
        sourceTab: "BizCopilot",
        action: "disable",
        tenantId: "acme",
        channel: "slack",
      },
    });
    expect(await world.channels.getTenantChannels("acme")).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
  });

  it("answers a bare channel command with the ask outcome instead of falling through (#4701)", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotChannelBranch({
      sourceTab: "BizCopilot",
      userText: "Show channels",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      channels: world.channels,
      directory: world.directory,
      operators: world.deps(OPERATOR).operators,
    });
    expect(context.startsWith("BIZCOPILOT_CHANNEL_RESULT: ")).toBe(true);
    expect(parseResult(context)["needsIdentifier"]).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "bizcopilot.channel_action_executed",
      payload: {
        sourceTab: "BizCopilot",
        action: "needs-identifier",
        command: "show",
        tenantId: null,
      },
    });
    expect(await world.channels.getTenantChannels("acme")).toEqual(DEFAULT_TENANT_CHANNELS);
  });
});
