/**
 * Issue #1888: enrichment store — run persistence, killswitch
 * set/get, fail-closed reads, audit on state change.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryEnrichmentStore,
  SqlEnrichmentStore,
} from "../src/enrichment/enrichmentStore";
import type { EnrichmentRunRecord } from "../src/enrichment/enrichmentPorts";

function run(id: string): EnrichmentRunRecord {
  return {
    id,
    jobId: "job-1",
    stage: "feed",
    provider: "yahoo",
    mode: "yahoo",
    minuteTimeframe: "1Min",
    symbolsRequested: 1,
    symbolsServed: 1,
    barsFetched: 5,
    dailyBars: 2,
    minuteBars: 3,
    fallbacks: 0,
    errors: [],
    partial: false,
    stopped: false,
    breakerState: [],
    killswitchState: "clear",
    createdAt: new Date(0).toISOString(),
    results: [],
  };
}

/** Minimal SQL mock honoring only this slice's statements. */
function mockSql() {
  const runs = new Map<string, string>();
  const settings = new Map<string, string>();
  return {
    runs,
    settings,
    exec(query: string, ...params: unknown[]): Iterable<unknown> {
      // #4385 (#4282 P6b): the adapter's reads moved to the DO DML
      // catalogue's Repository entries, so the Repository's statement
      // shapes arrive here — SELECT * with the LIMIT inlined — instead
      // of the old explicit-column statements with a bound LIMIT.
      // The rows returned are unchanged; only the matched text changes.
      const q = query.replace(/\s+/g, " ").trim();
      if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) return [];
      if (q.startsWith(`INSERT INTO mas_enrichment_runs`)) {
        runs.set(String(params[0]), String(params[4]));
        return [];
      }
      if (q.startsWith("SELECT * FROM mas_enrichment_runs ORDER")) {
        const limit = Number(q.match(/LIMIT (\d+)/)?.[1] ?? 0);
        return [...runs.values()].slice(0, limit).map((record_json) => ({ record_json }));
      }
      if (q.startsWith("SELECT * FROM mas_enrichment_runs WHERE")) {
        const json = runs.get(String(params[0]));
        return json ? [{ record_json: json }] : [];
      }
      if (q.startsWith("SELECT value FROM mas_settings")) {
        const v = settings.get(String(params[0]));
        return v !== undefined ? [{ value: v }] : [];
      }
      if (q.startsWith("DELETE FROM mas_settings")) {
        settings.delete(String(params[0]));
        return [];
      }
      if (q.startsWith("INSERT INTO mas_settings")) {
        settings.set(String(params[0]), String(params[1]));
        return [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    },
  };
}

describe("SqlEnrichmentStore", () => {
  it("persists and lists runs", () => {
    const sql = mockSql();
    const store = new SqlEnrichmentStore(sql);
    store.recordRun(run("enr-1"));
    store.recordRun(run("enr-2"));
    const listed = store.listRuns(10);
    expect(listed).toHaveLength(2);
    expect(store.getRun("enr-1")?.jobId).toBe("job-1");
    expect(store.getRun("missing")).toBeNull();
  });

  it("killswitch defaults clear, sets halted, audits, and clears again (manual only)", () => {
    const sql = mockSql();
    const audits: unknown[] = [];
    const store = new SqlEnrichmentStore(sql, (t, a, p) => {
      audits.push({ t, a, p });
    });
    expect(store.getKillswitchState()).toBe("clear");
    store.setKillswitch("halted", "operator", "testing stop");
    expect(store.getKillswitchState()).toBe("halted");
    expect(audits).toHaveLength(1);
    store.setKillswitch("clear", "operator", "testing resume");
    expect(store.getKillswitchState()).toBe("clear");
    expect(audits).toHaveLength(2);
  });

  it("killswitch read failure fails closed to halted", () => {
    const broken = {
      exec: () => {
        throw new Error("storage down");
      },
    };
    const store = new SqlEnrichmentStore(broken);
    expect(store.getKillswitchState()).toBe("halted");
  });
});

describe("InMemoryEnrichmentStore", () => {
  it("unreadable reads fail closed and sets still audit", () => {
    const store = new InMemoryEnrichmentStore();
    store.unreadable = true;
    expect(store.getKillswitchState()).toBe("halted");
    store.unreadable = false;
    store.setKillswitch("halted", "operator", "reason");
    expect(store.getKillswitchState()).toBe("halted");
    expect(store.auditCalls).toHaveLength(1);
    expect(store.auditCalls[0].payload.state).toBe("halted");
  });
});
