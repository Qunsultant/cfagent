// @vitest-environment node
/**
 * Issue #2390 (#1976 step 4g, gate G-7 ruled 2026-10-29) —
 * CHARACTERIZATION for the mas_settings ownership slice. Written
 * against the PRISTINE (pre-slice) code and required to stay
 * green, byte-for-byte in substance, after the rewire: every
 * assertion here describes behaviour the four legacy writers
 * exhibit TODAY, over their real call paths.
 *
 * The population under characterization:
 *  - reportDispatch's writeSetting/readSettingRaw doors (the
 *    ctx.writeSetting / ctx.readSettingRaw route surface),
 *    including readSettingRaw's fail-soft null and the HITL
 *    toggle's default-ON semantics;
 *  - screeningFlags' settingReadFromSql/settingWriteFromSql
 *    factories — ensure-on-every-call (a read on a FRESH
 *    instance, no table anywhere, returns null rather than
 *    throwing), the DELETE+INSERT write idiom, and the
 *    corpus-sync marker write through the same factory the
 *    knowledgeCorpus route uses;
 *  - governedHalt's setGovernedHalt dual-write protocol —
 *    ORDER evidence (SET: mirror before DO; CLEAR: DO before
 *    mirror) and partial-failure behaviour (as found: errors
 *    surface, never swallowed; the tick-facing mirror is left
 *    halted or the system unchanged);
 *  - the enrichment adapter's killswitch write/read pair,
 *    including its fail-closed read;
 *  - the adaptation kill-switch read path seeing governedHalt's
 *    DO write (the two kill-switch domains share the table).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  readSettingRaw,
  writeSetting,
  getReportDispatchHitl,
  setReportDispatchHitl,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import {
  settingReadFromSql,
  settingWriteFromSql,
  setScreeningSetting,
  readScreeningControls,
  SCREENING_FLAG_KEYS,
} from "../src/services/screeningFlags";
import { CORPUS_SYNC_LAST_RUN_KEY } from "../src/services/corpusSync";
import {
  setGovernedHalt,
  seedGovernanceHalt,
  type DoSql,
} from "../src/data/governedHalt";
import { InMemoryGovernanceAdapter } from "../src/data/inMemoryGovernanceAdapter";
import type {
  GovernanceHaltRow,
  GovernanceProjectionWriter,
} from "../src/data/governancePorts";
import {
  ADAPTATION_KILL_SWITCH_KEY,
  isAdaptationHalted,
} from "../src/services/adaptationAudit";
import { SqlEnrichmentStore } from "../src/data/doSqliteEnrichmentAdapter";
import { ENRICHMENT_KILLSWITCH_KEY } from "../src/enrichment/enrichmentPorts";

/** node:sqlite-backed SqlStorage double (step-4d harness shape). */
class SqliteTestStorage {
  private db = new DatabaseSync(":memory:");
  exec(query: string, ...args: unknown[]): unknown[] {
    const stmt = this.db.prepare(query);
    const verb = query.trimStart().slice(0, 6).toUpperCase();
    if (verb === "SELECT" || query.trimStart().toUpperCase().startsWith("PRAGMA")) {
      return stmt.all(...(args as any[])) as unknown[];
    }
    const info = stmt.run(...(args as any[]));
    return [{ rowsWritten: Number(info.changes) }];
  }
  tableNames(): string[] {
    const rows = this.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }
  raw(query: string, ...args: unknown[]): unknown[] {
    return this.exec(query, ...args);
  }
}

const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)";

/** A reportDispatch ctx whose ensureTables mirrors production:
 *  the orchestrator's ensure runs (mas_settings DDL included) and
 *  the instance sql handle comes back. */
function dispatchCtx(storage: SqliteTestStorage): ReportDispatchContext {
  return {
    ensureTables: () => {
      storage.exec(SETTINGS_DDL);
      return storage as never;
    },
    reportDispatchHitlKey: "report_dispatch_hitl",
    reportConfirmationTtlMs: 15 * 60 * 1000,
  } as unknown as ReportDispatchContext;
}

describe("reportDispatch settings doors (as found)", () => {
  it("writeSetting then readSettingRaw round-trips; overwrite keeps one row", () => {
    const storage = new SqliteTestStorage();
    const ctx = dispatchCtx(storage);
    writeSetting(ctx, "pipeline.key", "v1");
    expect(readSettingRaw(ctx, "pipeline.key")).toBe("v1");
    writeSetting(ctx, "pipeline.key", "v2");
    expect(readSettingRaw(ctx, "pipeline.key")).toBe("v2");
    const rows = storage.raw(
      "SELECT COUNT(*) AS n FROM mas_settings WHERE key = ?",
      "pipeline.key"
    ) as Array<{ n: number }>;
    expect(Number(rows[0].n)).toBe(1);
    expect(readSettingRaw(ctx, "absent.key")).toBeNull();
  });

  it("readSettingRaw is fail-soft: a failing store reads as null", () => {
    const ctx = {
      ensureTables: () => {
        throw new Error("storage gone");
      },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 1000,
    } as unknown as ReportDispatchContext;
    expect(readSettingRaw(ctx, "any.key")).toBeNull();
  });

  it("HITL toggle: unset reads enabled (default ON); explicit 0 disables; 1 re-enables", () => {
    const storage = new SqliteTestStorage();
    const ctx = dispatchCtx(storage);
    expect(getReportDispatchHitl(ctx)).toBe(true);
    setReportDispatchHitl(ctx, false);
    expect(getReportDispatchHitl(ctx)).toBe(false);
    setReportDispatchHitl(ctx, true);
    expect(getReportDispatchHitl(ctx)).toBe(true);
  });
});

describe("screeningFlags factories (as found)", () => {
  it("read on a FRESH instance (no table anywhere) returns null, not a throw", () => {
    const storage = new SqliteTestStorage();
    expect(storage.tableNames()).not.toContain("mas_settings");
    const read = settingReadFromSql(storage as never);
    expect(read(SCREENING_FLAG_KEYS.rolloutStage)).toBeNull();
    // The read itself ensured the table (ensure-on-every-call).
    expect(storage.tableNames()).toContain("mas_settings");
  });

  it("write/read round-trip; controls snapshot reflects the writes", () => {
    const storage = new SqliteTestStorage();
    const read = settingReadFromSql(storage as never);
    const write = settingWriteFromSql(storage as never);
    setScreeningSetting(write, SCREENING_FLAG_KEYS.rolloutStage, "paper");
    write(SCREENING_FLAG_KEYS.channelsEnabled, "on");
    const controls = readScreeningControls(read);
    expect(controls.rolloutStage).toBe("paper");
    expect(controls.channelsEnabled).toBe(true);
    expect(controls.scheduledPaused).toBe(false);
  });

  it("setScreeningSetting rejects an unknown rollout stage before writing", () => {
    const storage = new SqliteTestStorage();
    const write = settingWriteFromSql(storage as never);
    expect(() =>
      setScreeningSetting(write, SCREENING_FLAG_KEYS.rolloutStage, "everywhere")
    ).toThrow(/Invalid rollout stage/);
    expect(
      settingReadFromSql(storage as never)(SCREENING_FLAG_KEYS.rolloutStage)
    ).toBeNull();
  });

  it("corpus-sync marker: the route's factory write is readable back", () => {
    const storage = new SqliteTestStorage();
    settingWriteFromSql(storage as never)(
      CORPUS_SYNC_LAST_RUN_KEY,
      "2026-10-30T00:00:00.000Z"
    );
    expect(settingReadFromSql(storage as never)(CORPUS_SYNC_LAST_RUN_KEY)).toBe(
      "2026-10-30T00:00:00.000Z"
    );
  });
});

/** A DoSql over the sqlite double that records its statement
 *  verbs into a shared order log. */
function recordingDoSql(
  storage: SqliteTestStorage,
  log: string[]
): DoSql & { readValue: () => string | null } {
  return {
    exec(query: string, ...args: unknown[]) {
      const verb = query.trimStart().slice(0, 6).toUpperCase();
      log.push(`do:${verb}`);
      return storage.exec(query, ...args);
    },
    readValue() {
      const rows = storage.raw(
        "SELECT value FROM mas_settings WHERE key = ?",
        ADAPTATION_KILL_SWITCH_KEY
      ) as Array<{ value: string }>;
      return rows[0]?.value ?? null;
    },
  };
}

function recordingWriter(
  inner: InMemoryGovernanceAdapter,
  log: string[]
): GovernanceProjectionWriter {
  return {
    async recordHalt(row: GovernanceHaltRow) {
      log.push("mirror:recordHalt");
      return inner.recordHalt(row);
    },
  };
}

const HALT_INPUT = {
  tenantId: "primary",
  setBy: "tester",
  reason: "characterization",
  nowMs: 5000,
} as const;

describe("governedHalt dual-write protocol (as found)", () => {
  function freshStore() {
    const storage = new SqliteTestStorage();
    storage.exec(SETTINGS_DDL);
    return storage;
  }

  it("SET order: mirror first, then the DO setting; both read halted after", async () => {
    const storage = freshStore();
    const log: string[] = [];
    const mirror = new InMemoryGovernanceAdapter();
    const doSql = recordingDoSql(storage, log);
    await setGovernedHalt({
      ...HALT_INPUT,
      doSql,
      writer: recordingWriter(mirror, log),
      state: "halted",
    });
    expect(log[0]).toBe("mirror:recordHalt");
    // #4386 (P6c): the DO DELETE now dispatches the Repository
    // delete method through the catalogue, which verifies the
    // removal first (D-E.2) — one SELECT precedes the DELETE.
    // The order the protocol pins (mirror first, then the DO
    // DELETE+INSERT) is unchanged.
    expect(log.slice(1)).toEqual(["do:SELECT", "do:DELETE", "do:INSERT"]);
    expect(doSql.readValue()).toBe("on");
    expect(await mirror.isHalted("primary")).toBe(true);
    // The incumbent tick-facing DO read path sees the halt too.
    expect(isAdaptationHalted(storage as never)).toBe(true);
  });

  it("CLEAR order: DO setting first, then the mirror; both read clear after", async () => {
    const storage = freshStore();
    const mirror = new InMemoryGovernanceAdapter();
    const doSql = recordingDoSql(storage, []);
    await setGovernedHalt({
      ...HALT_INPUT,
      doSql,
      writer: mirror,
      state: "halted",
    });
    const log: string[] = [];
    const doSql2 = recordingDoSql(storage, log);
    await setGovernedHalt({
      ...HALT_INPUT,
      doSql: doSql2,
      writer: recordingWriter(mirror, log),
      state: "clear",
      nowMs: 6000,
    });
    // #4386 (P6c): the DO DELETE's D-E.2 verification SELECT
    // precedes it, and — because this recording fake reports no
    // rowsWritten — the delete verifies the removal with a second
    // SELECT after the DELETE (see the SET test above); the DO leg
    // still runs first, then the mirror.
    expect(log.slice(0, 4)).toEqual([
      "do:SELECT",
      "do:DELETE",
      "do:SELECT",
      "do:INSERT",
    ]);
    expect(log[4]).toBe("mirror:recordHalt");
    expect(doSql2.readValue()).toBe("off");
    expect(await mirror.isHalted("primary")).toBe(false);
    expect(isAdaptationHalted(storage as never)).toBe(false);
  });

  it("SET with a failing mirror: DO untouched, error surfaces", async () => {
    const storage = freshStore();
    const log: string[] = [];
    const doSql = recordingDoSql(storage, log);
    const failing: GovernanceProjectionWriter = {
      async recordHalt() {
        throw new Error("mirror unavailable");
      },
    };
    await expect(
      setGovernedHalt({ ...HALT_INPUT, doSql, writer: failing, state: "halted" })
    ).rejects.toThrow(/mirror unavailable/);
    expect(log).toEqual([]);
    expect(doSql.readValue()).toBeNull();
  });

  it("SET with a failing DO: mirror already halted, error surfaces", async () => {
    const mirror = new InMemoryGovernanceAdapter();
    const failingDo: DoSql = {
      exec() {
        throw new Error("DO unavailable");
      },
    };
    await expect(
      setGovernedHalt({
        ...HALT_INPUT,
        doSql: failingDo,
        writer: mirror,
        state: "halted",
      })
    ).rejects.toThrow(/DO unavailable/);
    expect(await mirror.isHalted("primary")).toBe(true);
  });

  it("CLEAR with a failing mirror: DO cleared first, mirror still halted (safe side)", async () => {
    const storage = freshStore();
    const mirror = new InMemoryGovernanceAdapter();
    const doSql = recordingDoSql(storage, []);
    await setGovernedHalt({
      ...HALT_INPUT,
      doSql,
      writer: mirror,
      state: "halted",
    });
    const failing: GovernanceProjectionWriter = {
      async recordHalt() {
        throw new Error("mirror unavailable");
      },
    };
    await expect(
      setGovernedHalt({
        ...HALT_INPUT,
        doSql,
        writer: failing,
        state: "clear",
        nowMs: 6000,
      })
    ).rejects.toThrow(/mirror unavailable/);
    expect(doSql.readValue()).toBe("off");
    expect(await mirror.isHalted("primary")).toBe(true);
  });

  it("CLEAR with a failing DO: nothing changes (mirror untouched), error surfaces", async () => {
    const mirror = new InMemoryGovernanceAdapter();
    let mirrorCalls = 0;
    const counting: GovernanceProjectionWriter = {
      async recordHalt(row: GovernanceHaltRow) {
        mirrorCalls++;
        return mirror.recordHalt(row);
      },
    };
    const storage = freshStore();
    await setGovernedHalt({
      ...HALT_INPUT,
      doSql: recordingDoSql(storage, []),
      writer: counting,
      state: "halted",
    });
    mirrorCalls = 0;
    const failingDo: DoSql = {
      exec() {
        throw new Error("DO unavailable");
      },
    };
    await expect(
      setGovernedHalt({
        ...HALT_INPUT,
        doSql: failingDo,
        writer: counting,
        state: "clear",
        nowMs: 6000,
      })
    ).rejects.toThrow(/DO unavailable/);
    expect(mirrorCalls).toBe(0);
    expect(await mirror.isHalted("primary")).toBe(true);
  });

  it("seed reads the DO state and never writes the DO setting", async () => {
    const storage = freshStore();
    storage.raw(
      "INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ADAPTATION_KILL_SWITCH_KEY,
      "on",
      "2026-01-01T00:00:00.000Z"
    );
    const mirror = new InMemoryGovernanceAdapter();
    const log: string[] = [];
    const result = await seedGovernanceHalt({
      doSql: recordingDoSql(storage, log),
      writer: mirror,
      tenantId: "primary",
      setBy: "tester",
      nowMs: 7000,
    });
    expect(result).toEqual({ seeded: true, state: "halted" });
    expect(log.filter((e) => e !== "do:SELECT")).toEqual([]);
    const again = await seedGovernanceHalt({
      doSql: recordingDoSql(storage, []),
      writer: mirror,
      tenantId: "primary",
      setBy: "tester",
      nowMs: 8000,
    });
    expect(again.seeded).toBe(false);
  });
});

describe("enrichment killswitch (as found)", () => {
  it("setKillswitch writes the key; getKillswitchState reads it back", () => {
    const storage = new SqliteTestStorage();
    storage.exec(SETTINGS_DDL);
    const store = new SqlEnrichmentStore(storage as never);
    expect(store.getKillswitchState()).toBe("clear");
    expect(store.setKillswitch("halted", "tester", "drill")).toBe("halted");
    expect(store.getKillswitchState()).toBe("halted");
    const rows = storage.raw(
      "SELECT value FROM mas_settings WHERE key = ?",
      ENRICHMENT_KILLSWITCH_KEY
    ) as Array<{ value: string }>;
    expect(rows[0].value).toBe("on");
    store.setKillswitch("clear", "tester", "drill over");
    expect(store.getKillswitchState()).toBe("clear");
  });

  it("killswitch read is fail-closed: a broken store reads halted", () => {
    const broken = {
      exec() {
        throw new Error("storage gone");
      },
    };
    const store = new SqlEnrichmentStore(broken as never);
    expect(store.getKillswitchState()).toBe("halted");
  });
});
