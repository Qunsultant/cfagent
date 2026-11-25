/**
 * Issue #6102 — the checkpointed audit-chain verifier, re-anchored on D1.
 *
 * The nightly verifier's checkpoint names a chain tail (tailRowId /
 * tailHash) in mas_settings. Before #6102 that tail named the DO chain;
 * after cutover the rows live in D1, so a DO tail would window an empty
 * read on D1 and silently verify nothing forever. The fix: the record
 * carries a `chain: "do" | "d1"` marker, and the D1 verifier treats a
 * DO (or pre-#6102 marker-less) checkpoint as no checkpoint — one strict
 * full verification, genesis-anchored on the D1 chain, then a `d1`
 * record is persisted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import {
  AUDIT_CHAIN_LAST_VERIFICATION_KEY,
  verifyStoredAuditChainAndAlertCheckpointedD1,
} from "../src/services/auditChainVerification";
import { verifyStoredAuditChainAndAlertD1 } from "../src/services/auditTamperAlert";
import type { AuditEvent } from "../src/types";

function makeD1() {
  const mock = new MockD1Database();
  const store = new D1AuditEventStore(createD1AuditEventDb(mock as never));
  return { mock, store };
}

async function seedEvent(
  store: D1AuditEventStore,
  id: string,
  type = "TEST_EVENT",
): Promise<void> {
  await store.create({
    id,
    sessionId: "s1",
    type,
    agent: "orchestrator",
    payload: { n: id },
    createdAt: new Date().toISOString(),
  });
}

describe("D1 checkpointed chain verification (#6102)", () => {
  let mock: MockD1Database;
  let store: D1AuditEventStore;
  let settings: Map<string, string>;

  beforeEach(() => {
    ({ mock, store } = makeD1());
    settings = new Map();
  });

  const readSetting = (key: string): string | null => settings.get(key) ?? null;
  const writeSetting = (key: string, value: string): void => {
    settings.set(key, value);
  };
  const run = () =>
    verifyStoredAuditChainAndAlertCheckpointedD1(store, readSetting, writeSetting);

  it("verifies the D1 chain from genesis on the first run and persists a d1 checkpoint", async () => {
    await seedEvent(store, "e1");
    await seedEvent(store, "e2");

    const result = await run();

    expect(result).toMatchObject({
      valid: true,
      alertRecorded: false,
      windowed: false,
      rowsChecked: 2,
    });
    expect(result.checkpoint).toMatchObject({
      valid: true,
      rowsChecked: 2,
      tailRowId: 2,
      anchorKind: "genesis",
      chain: "d1",
    });
    expect(result.checkpoint.tailHash).toBeTruthy();
    const stored = JSON.parse(
      settings.get(AUDIT_CHAIN_LAST_VERIFICATION_KEY) as string,
    ) as Record<string, unknown>;
    expect(stored.chain).toBe("d1");
  });

  it("verifies windowed on the second run — only the new rows", async () => {
    await seedEvent(store, "e1");
    await seedEvent(store, "e2");
    await run();
    await seedEvent(store, "e3");

    const second = await run();

    expect(second).toMatchObject({
      valid: true,
      windowed: true,
      rowsChecked: 1,
    });
    expect(second.checkpoint).toMatchObject({
      tailRowId: 3,
      anchorKind: "checkpoint",
      chain: "d1",
    });
  });

  it("re-anchors from D1 genesis when the stored checkpoint names the DO chain (cutover)", async () => {
    await seedEvent(store, "e1");
    await seedEvent(store, "e2");
    // The pre-cutover checkpoint: a DO tail (rowid 99 in the DO table)
    // that names nothing in D1. Without the re-anchor this run would
    // window `rowid > 99` on D1, read zero rows, and report valid.
    settings.set(
      AUDIT_CHAIN_LAST_VERIFICATION_KEY,
      JSON.stringify({
        verifiedAt: "2026-11-24T04:00:00.000Z",
        valid: true,
        rowsChecked: 40,
        tailRowId: 99,
        tailHash: "do-tail-hash",
        anchorKind: "checkpoint",
        brokenIndex: null,
        brokenRowId: null,
        reason: null,
        chain: "do",
      }),
    );

    const result = await run();

    expect(result).toMatchObject({
      valid: true,
      windowed: false,
      rowsChecked: 2,
    });
    expect(result.checkpoint).toMatchObject({
      tailRowId: 2,
      anchorKind: "genesis",
      chain: "d1",
    });
  });

  it("re-anchors from D1 genesis for a pre-#6102 checkpoint with no chain marker", async () => {
    await seedEvent(store, "e1");
    settings.set(
      AUDIT_CHAIN_LAST_VERIFICATION_KEY,
      JSON.stringify({
        verifiedAt: "2026-11-24T04:00:00.000Z",
        valid: true,
        rowsChecked: 40,
        tailRowId: 99,
        tailHash: "do-tail-hash",
        anchorKind: "checkpoint",
        brokenIndex: null,
        brokenRowId: null,
        reason: null,
      }),
    );

    const result = await run();

    expect(result).toMatchObject({ valid: true, windowed: false, rowsChecked: 1 });
    expect(result.checkpoint.chain).toBe("d1");
  });

  it("records a blocking D1 alert on a tampered post-checkpoint row and does not advance the tail", async () => {
    await seedEvent(store, "e1");
    await seedEvent(store, "e2");
    await run();
    await seedEvent(store, "e3");
    // Sabotage the post-checkpoint row's payload in place (bypassing
    // the store). (Tampering a row at or before the checkpoint tail is
    // outside the windowed read by design — the tail is already
    // verified; the full re-anchor is what re-checks the prefix.)
    mock.sqlite
      .prepare("UPDATE mas_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ n: "tampered" }), "e3");

    const result = await run();

    expect(result).toMatchObject({
      valid: false,
      brokenIndex: 0,
      alertRecorded: true,
    });
    expect(result.alertId).toMatch(/^tamper_/);
    expect(result.checkpoint.tailRowId).toBe(2);
    expect(result.checkpoint.valid).toBe(false);
    const alerts = await store.findMany({ where: { type: "audit.tamper_detected" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(result.alertId);
  });

  it("fallback full verify (no checkpoint context) reads the D1 chain and alerts in D1", async () => {
    await seedEvent(store, "e1");
    const ok = await verifyStoredAuditChainAndAlertD1(store);
    expect(ok).toMatchObject({ valid: true, alertRecorded: false });

    mock.sqlite
      .prepare("UPDATE mas_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ n: "tampered" }), "e1");
    const broken = await verifyStoredAuditChainAndAlertD1(store);
    expect(broken).toMatchObject({ valid: false, brokenIndex: 0, alertRecorded: true });
    expect(broken.alertId).toMatch(/^tamper_/);
    const alerts = await store.findMany({ where: { type: "audit.tamper_detected" } });
    expect(alerts).toHaveLength(1);
  });
});
