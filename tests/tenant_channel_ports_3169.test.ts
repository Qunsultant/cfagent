/**
 * Issue #3169 (program #2218) — tenant delivery-channel store port.
 *
 * Tenant-level delivery-channel enablement flags (email, Slack,
 * webhook, Copilot card, Docs) behind a port (ADR 0002): the D1
 * adapter owns the table, the in-memory adapter owns tests, and
 * the composition root returns null when AGENT_DB is unbound.
 * Enablement flags ONLY — no webhook URLs, tokens, or secrets
 * ever live in this store (v1 scope, #3169).
 *
 * Defaults are all-enabled: a tenant with no channel row behaves
 * exactly as before this slice (every channel permitted), so
 * configuring nothing changes nothing. Only an explicit operator
 * disable refuses a channel at dispatch.
 */
import { describe, it, expect } from "vitest";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { createTenantChannelAdapter } from "../src/data/createTenantChannelPorts";
import {
  DEFAULT_TENANT_CHANNELS,
  TENANT_CHANNEL_IDS,
} from "../src/data/tenantChannelPorts";
import { MIGRATION_0039_TENANT_CHANNELS } from "../src/data/migrationRunner";

describe("tenant channel port: channel ids and defaults (#3169)", () => {
  it("names exactly the five delivery channels, in panel order", () => {
    expect([...TENANT_CHANNEL_IDS]).toEqual([
      "email",
      "slack",
      "webhook",
      "copilot",
      "docs",
    ]);
  });

  it("defaults every channel to enabled", () => {
    expect(DEFAULT_TENANT_CHANNELS).toEqual({
      email: true,
      slack: true,
      webhook: true,
      copilot: true,
      docs: true,
    });
  });
});

describe("tenant channel port: in-memory adapter (#3169)", () => {
  it("reads defaults for a tenant with no row, without creating one", async () => {
    const store = new InMemoryTenantChannelAdapter();
    expect(await store.getTenantChannels("tenant-a")).toEqual(
      DEFAULT_TENANT_CHANNELS,
    );
    // A read must not materialize a row: a later patch still
    // starts from defaults, not from a phantom stored row.
    expect(await store.setTenantChannels("tenant-a", { slack: false })).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      slack: false,
    });
  });

  it("merges partial patches over the current config", async () => {
    const store = new InMemoryTenantChannelAdapter();
    await store.setTenantChannels("tenant-a", { email: false });
    const after = await store.setTenantChannels("tenant-a", { webhook: false });
    expect(after).toEqual({
      ...DEFAULT_TENANT_CHANNELS,
      email: false,
      webhook: false,
    });
    expect(await store.getTenantChannels("tenant-a")).toEqual(after);
  });

  it("keeps tenants independent", async () => {
    const store = new InMemoryTenantChannelAdapter();
    await store.setTenantChannels("tenant-a", { slack: false });
    expect(await store.getTenantChannels("tenant-b")).toEqual(
      DEFAULT_TENANT_CHANNELS,
    );
  });
});

describe("tenant channel port: composition root and migration (#3169)", () => {
  it("returns null when AGENT_DB is unbound", () => {
    expect(createTenantChannelAdapter({})).toBeNull();
    expect(createTenantChannelAdapter({ AGENT_DB: undefined })).toBeNull();
  });

  it("migration 0039 creates the channel table with one flag per channel", () => {
    expect(MIGRATION_0039_TENANT_CHANNELS.version).toBe(39);
    const sql = MIGRATION_0039_TENANT_CHANNELS.sql;
    expect(sql).toContain("agent_tenant_channels");
    expect(sql).toContain("tenant_id TEXT PRIMARY KEY");
    for (const column of [
      "email_enabled",
      "slack_enabled",
      "webhook_enabled",
      "copilot_enabled",
      "docs_enabled",
    ]) {
      expect(sql).toContain(column);
    }
    // Flags only: no URL, token, or secret column may ever appear here.
    expect(sql).not.toMatch(/url|token|secret/i);
  });
});
