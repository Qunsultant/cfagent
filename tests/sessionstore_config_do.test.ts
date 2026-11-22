/**
 * #6191 — the SessionStore's audit ceilings are externalized in
 * config/sessionstore.json, and the DO reads them (not hardcoded
 * constants). This suite proves the wiring at the DO level: with
 * the config mocked to small ceilings, a client that requests
 * LARGE caps is clamped down to the config values, so the store
 * fills at the config total — not at the requested total and not
 * at the old hardcoded 2000/2000/10.
 *
 * The mock overrides only the resolved config (via importOriginal,
 * so the real resolver/defaults stay in place); the DO under test
 * is the real SessionStore over node:sqlite, exactly as
 * audit_store_atomic_1760.test.ts builds it.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("../src/config/sessionStoreConfig", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/config/sessionStoreConfig")>();
  return {
    ...actual,
    // Small ceilings: live 2 + 1 archive segment x 2 = total 4.
    SESSION_STORE_CONFIG: {
      audit: { liveMax: 2, segmentSize: 2, maxSegments: 1 },
      genesis: { oneTime: false },
      schemaVersion: 1,
    },
    SESSION_STORE_CONFIG_ERRORS: [],
  };
});

import { SessionStore } from "../src/security/sessionStore";
import {
  createAtomicAuditStore,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
import {
  recordAuditEvent,
  type CreateIaaaAuditEventInput,
} from "../src/security/iaaaAudit";

function makeDoNamespace() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const stmt = db.prepare(sql);
          if (/^\s*SELECT/i.test(sql)) {
            const rows = stmt.all(...params);
            return {
              toArray: () => rows,
              rowsRead: rows.length,
              rowsWritten: 0,
            };
          }
          const info = stmt.run(...params);
          return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
        },
      },
    },
  };
  const store = new SessionStore(ctx as never, {} as never);
  let queue: Promise<unknown> = Promise.resolve();
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (request: Request) => {
        const run = queue.then(() => store.fetch(request));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    }),
  };
  return { namespace, store };
}

function auditInput(action: string, timestamp: number): CreateIaaaAuditEventInput {
  return {
    timestamp,
    type: "auth.login",
    actorPrincipalId: "user-1",
    actorType: "human",
    initiatingPrincipalId: "user-1",
    tenantId: "tenant-1",
    correlationId: `corr-${action}`,
    action,
    decision: "allow",
    policyVersion: "iaaa-audit-1",
    outcome: "succeeded",
  };
}

describe("sessionstore config wiring (#6191)", () => {
  it("a non-default audit ceiling takes effect in the real SessionStore", async () => {
    const { namespace } = makeDoNamespace();
    // The client requests LARGE caps — the DO must clamp them to
    // the config ceilings (live 2, segment 2, maxSegments 1),
    // so the store fills at 4 events, not at 100 + 100*100.
    const store = createAtomicAuditStore(namespace, {
      liveMax: 100,
      segmentSize: 100,
      maxArchiveSegments: 100,
    });
    for (let i = 0; i < 4; i++) {
      const result = await recordAuditEvent(store, auditInput(`event:${i}`, 3_000_000 + i));
      expect(result.ok).toBe(true);
    }
    const events = await store.list();
    expect(events).toHaveLength(4);
    // The 5th append hits the config total cap (2 + 1*2 = 4).
    const full = await recordAuditEvent(store, auditInput("event:4", 3_000_004));
    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.code).toBe("AUDIT_STORE_FULL");
    }
    // Nothing was deleted by the full signal.
    const after = await store.list();
    expect(after).toHaveLength(4);
    expect(after[0].action).toBe("event:0");
  });
});
