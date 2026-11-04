// @vitest-environment node
/**
 * Issue #2183 (Q7 audit-policy mechanism, sub-issue of #2012;
 * proposal slice for CISO+CDO review under #945) — port
 * conformance + pins, TDD.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter. A
 * behavior that passes on one adapter and fails on the other is
 * a layer defect, not an application bug.
 *
 * Pinned contracts:
 *  - Seeded operator data (PROPOSED, pending CISO+CDO sign-off):
 *    payment.charge / payment.refund / subscription.change /
 *    credit.issue block; audit.read / payment.read never block;
 *    enforcement mode seeds to audit-only; retention seeds to
 *    365 days. Re-seeding never overwrites an operator edit.
 *  - Gate evaluator: money action blocked ONLY in enforcing
 *    mode on audit failure; read-only actions never blocked in
 *    either mode; unknown actions never blocked (adding a new
 *    consequential action requires an operator-data row);
 *    audit-only mode never blocks (wouldBlock only).
 *  - Hash chain: append links prevHash/entryHash; verification
 *    passes on an intact chain and detects a modified row, a
 *    deleted middle row, and a sequence-swapped (reordered) row;
 *    verification never auto-corrects.
 *  - Retention: prune applies the externalized period per
 *    tenant, is idempotent, and prunes NOTHING when the period
 *    is unset, non-numeric, zero, or negative.
 *  - Tenant isolation: one tenant's chain rows are invisible to
 *    another. Policy rows are GLOBAL operator data (one policy
 *    for all tenants), by design.
 *  - Migration 0016 owns the audit-policy DDL; the Drizzle
 *    schema maps it (column parity pinned here).
 *  - Port and gate-helper modules import no store client
 *    (structural grep pins).
 *  - Gate helper fail direction: a null adapter or a throwing
 *    port never blocks (pre-sign-off default, loudly logged).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditPolicyDb,
  D1AuditPolicyAdapter,
  ensureAuditPolicySchema,
} from "../src/data/d1AuditPolicyAdapter";
import { InMemoryAuditPolicyAdapter } from "../src/data/inMemoryAuditPolicyAdapter";
import { MIGRATION_0016_AUDIT_POLICY } from "../src/data/migrationRunner";
import {
  agentAuditChain,
  agentAuditPolicyActions,
  agentAuditPolicySettings,
} from "../src/data/drizzleSchema";
import {
  AUDIT_POLICY_BLOCKING_ACTIONS,
  AUDIT_POLICY_NON_BLOCKING_ACTIONS,
  AUDIT_POLICY_PROPOSED_RETENTION_DAYS,
  AUDIT_POLICY_SETTING_ENFORCEMENT_MODE,
  AUDIT_POLICY_SETTING_RETENTION_DAYS,
  evaluateAuditGate,
  pruneAuditChainForTenant,
  resolveAuditPolicy,
  verifyAuditChain,
  type AuditPolicy,
  type AuditPolicyPort,
} from "../src/data/auditPolicyPorts";
import {
  appendAuditChainBestEffort,
  checkAuditGate,
} from "../src/services/auditGate";

async function makeD1Store(): Promise<{
  port: AuditPolicyPort;
  reensure: () => Promise<void>;
}> {
  const mock = new MockD1Database();
  const db = createD1AuditPolicyDb(mock as any);
  await ensureAuditPolicySchema(db);
  return {
    port: new D1AuditPolicyAdapter(db),
    reensure: async () => {
      await ensureAuditPolicySchema(db);
    },
  };
}

const makers: Array<{
  name: string;
  make: () => Promise<{ port: AuditPolicyPort; reensure?: () => Promise<void> }>;
}> = [
  { name: "Drizzle D1 adapter", make: makeD1Store },
  {
    name: "in-memory adapter",
    make: async () => ({ port: new InMemoryAuditPolicyAdapter() }),
  },
];

const DAY_MS = 86_400_000;

describe.each(makers)("audit-policy port conformance (#2183) — $name", ({ make }) => {
  it("seeds the proposed blocking set, non-blocking reads, audit-only mode, 365d retention", async () => {
    const { port } = await make();
    const actions = await port.listActionPolicies();
    for (const action of AUDIT_POLICY_BLOCKING_ACTIONS) {
      expect(actions.find((a) => a.action === action)?.blockOnAuditFailure).toBe(true);
    }
    for (const action of AUDIT_POLICY_NON_BLOCKING_ACTIONS) {
      expect(actions.find((a) => a.action === action)?.blockOnAuditFailure).toBe(false);
    }
    const mode = await port.getSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE);
    expect(mode?.value).toBe("audit-only");
    const retention = await port.getSetting(AUDIT_POLICY_SETTING_RETENTION_DAYS);
    expect(retention?.value).toBe(String(AUDIT_POLICY_PROPOSED_RETENTION_DAYS));
    const policy = await resolveAuditPolicy(port);
    expect(policy.mode).toBe("audit-only");
    expect(policy.retentionDays).toBe(365);
  });

  it("gate: audit-only mode never blocks, even for money actions on audit failure", async () => {
    const { port } = await make();
    const policy = await resolveAuditPolicy(port);
    expect(policy.mode).toBe("audit-only");
    for (const action of AUDIT_POLICY_BLOCKING_ACTIONS) {
      const d = evaluateAuditGate(policy, action, false);
      expect(d.allowed).toBe(true);
      expect(d.blocked).toBe(false);
      expect(d.wouldBlock).toBe(true);
    }
  });

  it("gate: enforcing mode blocks money actions on audit failure, never reads", async () => {
    const { port } = await make();
    await port.setSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE, "enforcing");
    const policy = await resolveAuditPolicy(port);
    expect(policy.mode).toBe("enforcing");
    for (const action of AUDIT_POLICY_BLOCKING_ACTIONS) {
      const d = evaluateAuditGate(policy, action, false);
      expect(d.blocked).toBe(true);
      expect(d.allowed).toBe(false);
    }
    for (const action of AUDIT_POLICY_NON_BLOCKING_ACTIONS) {
      const d = evaluateAuditGate(policy, action, false);
      expect(d.blocked).toBe(false);
      expect(d.allowed).toBe(true);
    }
    // Audit success never blocks, even in enforcing mode.
    for (const action of AUDIT_POLICY_BLOCKING_ACTIONS) {
      const d = evaluateAuditGate(policy, action, true);
      expect(d.blocked).toBe(false);
      expect(d.allowed).toBe(true);
    }
  });

  it("gate: unknown actions never block (operator row required to block)", async () => {
    const { port } = await make();
    await port.setSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE, "enforcing");
    const policy = await resolveAuditPolicy(port);
    const d = evaluateAuditGate(policy, "credit.redeem", false);
    expect(d.blocked).toBe(false);
    expect(d.allowed).toBe(true);
    // And an operator row can add it without a code change.
    await port.setActionPolicy("credit.redeem", true);
    const updated = await resolveAuditPolicy(port);
    expect(evaluateAuditGate(updated, "credit.redeem", false).blocked).toBe(true);
  });

  it("gate: pure evaluator defaults unknown mode strings to audit-only via resolve", async () => {
    const { port } = await make();
    await port.setSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE, "bogus-mode");
    const policy = await resolveAuditPolicy(port);
    expect(policy.mode).toBe("audit-only");
    expect(evaluateAuditGate(policy, "payment.charge", false).blocked).toBe(false);
  });

  it("chain: append links hashes and verification passes; payload key order does not matter", async () => {
    const { port } = await make();
    const first = await port.appendChainEntry({
      tenantId: "tenant-a",
      action: "payment.charge",
      payload: { runId: "run-1", amountUSD: 0.1 },
    });
    expect(first.sequence).toBe(1);
    expect(first.prevHash).toBe("GENESIS");
    const second = await port.appendChainEntry({
      tenantId: "tenant-a",
      action: "payment.charge",
      payload: { amountUSD: 0.1, runId: "run-1" },
    });
    expect(second.sequence).toBe(2);
    expect(second.prevHash).toBe(first.entryHash);
    // Same canonical payload as the first entry but a different
    // link position: payloadHash must match the first row's.
    expect(second.payloadHash).toBe(first.payloadHash);
    const entries = await port.listChainEntries("tenant-a");
    expect(entries).toHaveLength(2);
    const verification = await verifyAuditChain(entries);
    expect(verification.valid).toBe(true);
    expect(verification.brokenIndex).toBeNull();
  });

  it("chain: verification detects a modified row, a deleted middle row, and a sequence swap", async () => {
    const { port } = await make();
    for (let i = 0; i < 3; i++) {
      await port.appendChainEntry({
        tenantId: "tenant-a",
        action: "payment.charge",
        payload: { runId: `run-${i}` },
      });
    }
    const entries = await port.listChainEntries("tenant-a");
    expect((await verifyAuditChain(entries)).valid).toBe(true);

    const modified = entries.map((e) => ({ ...e }));
    modified[1] = { ...modified[1], payloadHash: "tampered-payload-hash" };
    const modifiedCheck = await verifyAuditChain(modified);
    expect(modifiedCheck.valid).toBe(false);
    expect(modifiedCheck.brokenIndex).toBe(1);

    const deletedMiddle = [entries[0], entries[2]];
    const deletedCheck = await verifyAuditChain(deletedMiddle);
    expect(deletedCheck.valid).toBe(false);
    expect(deletedCheck.brokenIndex).toBe(1);

    const swapped = entries.map((e) => ({ ...e }));
    const seq = swapped[0].sequence;
    swapped[0] = { ...swapped[0], sequence: swapped[1].sequence };
    swapped[1] = { ...swapped[1], sequence: seq };
    const swappedCheck = await verifyAuditChain(swapped);
    expect(swappedCheck.valid).toBe(false);
  });

  it("chain: tenant isolation — one tenant's rows are invisible to another", async () => {
    const { port } = await make();
    await port.appendChainEntry({
      tenantId: "tenant-a",
      action: "payment.charge",
      payload: { runId: "run-1" },
    });
    expect(await port.listChainEntries("tenant-b")).toEqual([]);
    expect(await port.getChainHead("tenant-b")).toBeNull();
    expect((await port.getChainHead("tenant-a"))?.sequence).toBe(1);
  });

  it("retention: prune applies the externalized period per tenant and is idempotent", async () => {
    const { port } = await make();
    const now = Date.now();
    await port.appendChainEntry({
      tenantId: "tenant-a",
      action: "payment.charge",
      payload: { runId: "old" },
      createdAtMs: now - 400 * DAY_MS,
    });
    const kept = await port.appendChainEntry({
      tenantId: "tenant-a",
      action: "payment.charge",
      payload: { runId: "new" },
      createdAtMs: now,
    });
    await port.appendChainEntry({
      tenantId: "tenant-b",
      action: "payment.charge",
      payload: { runId: "old-b" },
      createdAtMs: now - 400 * DAY_MS,
    });
    const report = await pruneAuditChainForTenant(port, "tenant-a", { nowMs: now });
    expect(report.skipped).toBe(false);
    expect(report.pruned).toBe(1);
    expect(report.cutoffMs).toBe(now - 365 * DAY_MS);
    const remaining = await port.listChainEntries("tenant-a");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(kept.id);
    // Pruned oldest row becomes the anchor: the surviving chain
    // still verifies (its prevHash is the anchor, unchecked).
    expect((await verifyAuditChain(remaining)).valid).toBe(true);
    // Other tenant untouched.
    expect(await port.listChainEntries("tenant-b")).toHaveLength(1);
    // Second run prunes zero.
    const second = await pruneAuditChainForTenant(port, "tenant-a", { nowMs: now });
    expect(second.pruned).toBe(0);
  });

  it("retention: unset / non-numeric / zero / negative period prunes nothing", async () => {
    const { port } = await make();
    await port.appendChainEntry({
      tenantId: "tenant-a",
      action: "payment.charge",
      payload: { runId: "old" },
      createdAtMs: Date.now() - 4000 * DAY_MS,
    });
    for (const value of ["not-a-number", "0", "-30"]) {
      await port.setSetting(AUDIT_POLICY_SETTING_RETENTION_DAYS, value);
      const report = await pruneAuditChainForTenant(port, "tenant-a");
      expect(report.skipped).toBe(true);
      expect(report.pruned).toBe(0);
      expect(report.cutoffMs).toBeNull();
      expect(await port.listChainEntries("tenant-a")).toHaveLength(1);
    }
  });

  it("retention: per-run cap stops the prune early and reports capped", async () => {
    const { port } = await make();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await port.appendChainEntry({
        tenantId: "tenant-a",
        action: "payment.charge",
        payload: { runId: `old-${i}` },
        createdAtMs: now - 400 * DAY_MS,
      });
    }
    const report = await pruneAuditChainForTenant(port, "tenant-a", {
      nowMs: now,
      batchSize: 2,
      maxPerRun: 2,
    });
    expect(report.pruned).toBe(2);
    expect(report.capped).toBe(true);
    expect(await port.listChainEntries("tenant-a")).toHaveLength(1);
  });
});

describe("audit-policy D1 seeds (#2183) — re-ensure never overwrites an operator edit", () => {
  it("operator edit survives ensureAuditPolicySchema", async () => {
    const { port, reensure } = await makeD1Store();
    await port.setActionPolicy("payment.charge", false);
    await port.setSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE, "enforcing");
    await reensure!();
    expect((await port.getActionPolicy("payment.charge"))?.blockOnAuditFailure).toBe(false);
    expect(
      (await port.getSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE))?.value,
    ).toBe("enforcing");
  });
});

describe("audit-policy gate helper (#2183, enforcement forced ON by #3156)", () => {
  it("stored audit-only mode is overridden to enforcing; a failed audit write blocks", async () => {
    const port = new InMemoryAuditPolicyAdapter();
    // The seed mode is audit-only, but #3156 forces enforcing: the
    // stored setting no longer disables enforcement.
    const seededAuditOnly = await checkAuditGate(async () => port, "payment.charge", false);
    expect(seededAuditOnly.blocked).toBe(true);
    expect(seededAuditOnly.allowed).toBe(false);
    expect(seededAuditOnly.mode).toBe("enforcing");
    await port.setSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE, "enforcing");
    const enforcing = await checkAuditGate(async () => port, "payment.charge", false);
    expect(enforcing.blocked).toBe(true);
    expect(enforcing.allowed).toBe(false);
    // A successful audit write still passes the gate.
    const written = await checkAuditGate(async () => port, "payment.charge", true);
    expect(written.blocked).toBe(false);
    expect(written.allowed).toBe(true);
    const read = await checkAuditGate(async () => port, "audit.read", false);
    expect(read.allowed).toBe(true);
    expect(read.blocked).toBe(false);
  });

  it("null adapter and throwing port fail closed: block money actions, allow seeded non-blocking reads", async () => {
    const nullDecision = await checkAuditGate(async () => null, "payment.charge", false);
    expect(nullDecision.blocked).toBe(true);
    expect(nullDecision.allowed).toBe(false);
    // Fail-closed regardless of the caller's audit-write report: without
    // the store the gate cannot verify policy or chain evidence.
    const nullWritten = await checkAuditGate(async () => null, "payment.charge", true);
    expect(nullWritten.blocked).toBe(true);
    expect(nullWritten.allowed).toBe(false);
    const nullRead = await checkAuditGate(async () => null, "audit.read", false);
    expect(nullRead.allowed).toBe(true);
    expect(nullRead.blocked).toBe(false);
    const nullUnknown = await checkAuditGate(async () => null, "payment.invoice", false);
    expect(nullUnknown.blocked).toBe(true);
    expect(nullUnknown.allowed).toBe(false);
    const throwingPort = {
      async listActionPolicies(): Promise<never> {
        throw new Error("D1 unavailable");
      },
      async getSetting(): Promise<never> {
        throw new Error("D1 unavailable");
      },
      async appendChainEntry(): Promise<never> {
        throw new Error("D1 unavailable");
      },
    } as unknown as AuditPolicyPort;
    const throwingDecision = await checkAuditGate(
      async () => throwingPort,
      "payment.charge",
      false,
    );
    expect(throwingDecision.blocked).toBe(true);
    expect(throwingDecision.allowed).toBe(false);
    const throwingRead = await checkAuditGate(async () => throwingPort, "audit.read", false);
    expect(throwingRead.allowed).toBe(true);
    expect(throwingRead.blocked).toBe(false);
    await expect(
      appendAuditChainBestEffort(async () => throwingPort, {
        tenantId: "tenant-a",
        action: "payment.charge",
        payload: { runId: "run-1" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      appendAuditChainBestEffort(async () => null, {
        tenantId: "tenant-a",
        action: "payment.charge",
        payload: { runId: "run-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("pure evaluator covers all four corners without a store", () => {
    const auditOnly: AuditPolicy = {
      mode: "audit-only",
      retentionDays: 365,
      blockingActions: new Set(["payment.charge"]),
    };
    const enforcing: AuditPolicy = { ...auditOnly, mode: "enforcing" };
    expect(evaluateAuditGate(auditOnly, "payment.charge", false).wouldBlock).toBe(true);
    expect(evaluateAuditGate(enforcing, "payment.charge", false).blocked).toBe(true);
    expect(evaluateAuditGate(enforcing, "payment.charge", true).blocked).toBe(false);
    expect(evaluateAuditGate(enforcing, "audit.read", false).blocked).toBe(false);
  });
});

describe("audit-policy structural pins (#2183)", () => {
  function importLines(file: string): string[] {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
  }

  it("port and gate-helper modules import no store client", () => {
    for (const file of ["data/auditPolicyPorts.ts", "services/auditGate.ts"]) {
      const imports = importLines(file).join("\n");
      expect(imports).not.toContain("drizzle-orm");
      expect(imports).not.toContain("D1Database");
      expect(imports).not.toContain("d1AuditPolicyAdapter");
      expect(imports).not.toContain("inMemoryAuditPolicyAdapter");
    }
  });

  it("migration DDL and Drizzle schema agree on columns for all three tables", () => {
    for (const [table, mapping] of [
      ["agent_audit_policy_actions", agentAuditPolicyActions],
      ["agent_audit_policy_settings", agentAuditPolicySettings],
      ["agent_audit_chain", agentAuditChain],
    ] as const) {
      const rawColumns = getTableConfig(mapping).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = MIGRATION_0016_AUDIT_POLICY.sql.split(
        `CREATE TABLE IF NOT EXISTS ${table} (`,
      )[1].split(");")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    }
  });
});
