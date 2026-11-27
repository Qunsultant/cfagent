// @vitest-environment node
/**
 * Issue #2347 (#1976 step 3c, ADR 0022 D-C.3 / D-F2) — the canonical
 * report fan-out contract, as re-shaped by #6101 step 8.
 *
 * THE CHANGE (named, disclosed): the recorded-on-the-row half of the
 * contract ENDS with the DO row. D1 agent_reports carries no fan-out
 * column, so a read always returns fanoutOutcome: null. What survives:
 *
 *  1. The store RESULT carries the fan-out outcome as known at return
 *     time (body leg settled pre-insert; index legs fire-and-forget,
 *     so an attempted leg reads "pending" on the result). Codes stay
 *     catalogued (DataFoundationCode REPORT_FANOUT_STORED /
 *     _DEGRADED); only "failed" or "inline_fallback" degrade.
 *  2. Per-leg fault injection: R2 put throws -> body
 *     inline_fallback + DEGRADED on the result, row complete inline;
 *     a settled index-leg failure is NO LONGER recorded anywhere on
 *     the row — it is logged once as a
 *     `scheduledReports.fanout_leg_failed` warn event (target + code),
 *     never silent, never thrown into the store's path. A leg that
 *     never attempts (no bindings / flag OFF) makes zero calls and
 *     is never fabricated as "indexed".
 *  3. Row INSERT throws -> null result, no row, the
 *     storeReportAtGeneration.failed error event with the
 *     REPORT_FANOUT_FAILED code (the failed member: nothing to
 *     record on).
 *  4. Ordering: the R2 put still precedes the insert, and the
 *     result already names the body leg (stored_r2 / body "r2") —
 *     a row never claims a body it does not have: a failed put
 *     returns inline_fallback with the body inline, never stored_r2.
 *  5. Seam parity: exactly ONE D1 agent_reports insert exists in
 *     src/ (the adapter's recordReport, carrying bodyR2Key);
 *     persistScheduledReportSql is DELETED (its tests with it).
 *  6. Dedupe: a redelivery returns created:false + outcome
 *     "deduped" on the result and re-fires the legs; one reportId.
 *
 * DOUBLES: shared MockD1Database (node:sqlite-backed) for the D1
 * seam; the leg doubles (Vectorize / AI Search / R2 bucket) are
 * unchanged from the pre-#6101 file.
 *
 * #CDO-mha7
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/actors/thinkAdapter", () => ({
  PortThink: class MockPortThink {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import {
  getCanonicalReport,
  listScheduledReports,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { DataFoundationCode } from "../src/aspects/errorCodes";
import { MockD1Database } from "./mock-d1";

type D1Database = any;

const flush = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function d1() {
  const mock = new MockD1Database();
  return { mock, env: { AGENT_DB: mock as unknown as D1Database } };
}

function input(over: Partial<ScheduledReportInput> = {}): ScheduledReportInput {
  return {
    runId: "screener:2026-10-29T01:00:00Z",
    generationId: "gen-3c-contract",
    title: "Fan-out contract report",
    source: "screener",
    summary: "Scanned 10 symbols, 2 matched.",
    body: { opportunities: [{ symbol: "NVDA", structure: "call spread" }] },
    createdAt: "2026-10-29T01:00:00.000Z",
    userLogin: "tenant@example.com",
    ...over,
  };
}

async function rowCount(env: { AGENT_DB: D1Database }): Promise<number> {
  return (await listScheduledReports(env, { limit: 100 })).length;
}

/** Fail the agent_reports INSERT (after the migrations run). */
class FailingInsertD1 extends MockD1Database {
  override prepare(sql: string) {
    const stmt = super.prepare(sql) as {
      bind(...params: unknown[]): {
        run(): Promise<unknown>;
        all(): Promise<unknown>;
        first(): Promise<unknown>;
        raw(): Promise<unknown>;
      };
    };
    if (/INSERT\s+INTO\s+["`]?agent_reports["`]?/i.test(sql)) {
      return {
        bind(...params: unknown[]) {
          const bound = stmt.bind(...params);
          return {
            ...bound,
            async run() {
              throw new Error("simulated insert failure");
            },
          };
        },
      };
    }
    return stmt;
  }
}

// #3515 S3: the seams log via the structured logger, whose fallback
// sink writes every event as one JSON line via console.info.
function structuredEvents(infoSpy: ReturnType<typeof vi.spyOn>) {
  const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
  for (const call of infoSpy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as {
        operation?: unknown;
        level?: unknown;
        fields?: unknown;
      };
      if (parsed && typeof parsed.operation === "string") {
        events.push({
          operation: parsed.operation,
          level: typeof parsed.level === "string" ? parsed.level : "",
          fields:
            parsed.fields && typeof parsed.fields === "object"
              ? (parsed.fields as Record<string, unknown>)
              : {},
        });
      }
    } catch {
      // Non-JSON console.info lines are not structured events.
    }
  }
  return events;
}

function makeVectorEnv(opts: { failUpsert?: boolean } = {}) {
  const upserts: Array<{ id: string }> = [];
  return {
    upserts,
    env: {
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTOR_MEMORY: {
        upsert: async (vectors: Array<{ id: string }>) => {
          if (opts.failUpsert) throw new Error("vectorize upsert boom");
          upserts.push(...vectors);
        },
      },
    },
  };
}

function makeAiSearchEnv(opts: { flag?: string; failUpload?: boolean } = {}) {
  const uploads: Array<{ name: string }> = [];
  const instance = {
    items: {
      upload: async (name: string) => {
        uploads.push({ name });
        if (opts.failUpload) throw new Error("instance items API unavailable");
        return { id: "item-1", key: name, status: "queued" };
      },
    },
  };
  return {
    uploads,
    env: {
      AI_SEARCH: { get: (_name: string) => instance },
      AI_SEARCH_INSTANCE: "test-instance",
      ...(opts.flag ? { AI_SEARCH_REPORT_INDEXING_ENABLED: opts.flag } : {}),
    } as Record<string, unknown>,
  };
}

function makeBucket(opts: { failPut?: boolean } = {}) {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => {
        if (opts.failPut) throw new Error("r2 put boom");
        objects.set(key, String(value));
      },
      get: async (key: string) => {
        const v = objects.get(key);
        return v === undefined ? null : { text: async () => v };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    },
  };
}

describe("3c contract: the store result carries the outcome; the D1 read carries none", () => {
  it("inline seam, no env: stored_inline / STORED on the result, both legs not_attempted-or-pending, read fanoutOutcome null", async () => {
    const { env } = d1();
    const stored = await storeReportAtGeneration(input(), env);
    expect(stored?.fanout.outcome).toBe("stored_inline");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
    expect(stored?.fanout.body).toBe("inline");
    expect(stored?.fanout.vectorize).toBe("not_attempted");
    // Index legs are fire-and-forget: aiSearch reads "pending" at
    // return time (its settle lands nowhere now — no record).
    expect(stored?.fanout.aiSearch).toBe("pending");
    await flush();
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("R2 seam: stored_r2 / body r2 on the result; Vectorize indexed after settle; read fanoutOutcome null", async () => {
    const { env } = d1();
    const { bucket } = makeBucket();
    const { env: vecEnv, upserts } = makeVectorEnv();
    const stored = await storeReportAtGenerationWithR2(
      // Phase 3 (#6550): AI_SEARCH_REPORT_INDEXING_ENABLED lives in
      // environment.config.json (ON in production); this seam asserts
      // the no-AI-search outcome, so the flag is off explicitly.
      { ...env, REPORTS_BUCKET: bucket, ...vecEnv, AI_SEARCH_REPORT_INDEXING_ENABLED: "0" } as never,
      input(),
    );
    expect(stored?.fanout.outcome).toBe("stored_r2");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
    expect(stored?.fanout.body).toBe("r2");
    await flush();
    expect(upserts).toHaveLength(1);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.bodyR2Key).toBeTruthy();
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("AI Search flag ON + configured: upload happens once after settle; result reads pending; read fanoutOutcome null", async () => {
    const { env } = d1();
    const ai = makeAiSearchEnv({ flag: "true" });
    const stored = await storeReportAtGeneration(input(), { ...env, ...ai.env } as never);
    expect(stored?.fanout.aiSearch).toBe("pending");
    await flush();
    expect(ai.uploads).toHaveLength(1);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.fanoutOutcome).toBeNull();
  });
});

describe("3c contract: per-leg fault injection produces the declared result outcome", () => {
  it("R2 put throws -> stored_inline_fallback + DEGRADED on the result, body complete inline, never stored_r2", async () => {
    const { env } = d1();
    const { bucket } = makeBucket({ failPut: true });
    const stored = await storeReportAtGenerationWithR2(
      { ...env, REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(stored?.fanout.outcome).toBe("stored_inline_fallback");
    expect(stored?.fanout.body).toBe("inline_fallback");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
    await flush();
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toContain("NVDA");
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("Vectorize throws -> result stays STORED (leg pending at return), row intact, failure logged once, read fanoutOutcome null", async () => {
    const { env } = d1();
    const { env: vecEnv } = makeVectorEnv({ failUpsert: true });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // Rebase note (#6659/#6550): AI_SEARCH_REPORT_INDEXING_ENABLED
      // now resolves from environment.config.json (ON in production),
      // so a bare env no longer means the AI Search leg is off — it
      // would attempt (no instance here) and log a second
      // fanout_leg_failed. This test pins the Vectorize leg, so the
      // AI Search leg stays off explicitly.
      const stored = await storeReportAtGeneration(input(), { ...env, ...vecEnv, AI_SEARCH_REPORT_INDEXING_ENABLED: "0" } as never);
      expect(stored?.created).toBe(true);
      expect(stored?.fanout.vectorize).toBe("pending");
      expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
      await flush();
      // #6101 step 8: the settled "failed" is NO LONGER recorded on
      // the row (no fan-out column) — the only trace is the warn log.
      const failed = structuredEvents(infoSpy).filter(
        (e) => e.operation === "scheduledReports.fanout_leg_failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.fields.target).toBe("vectorize");
      const hit = await getCanonicalReport(env, stored!.reportId);
      expect(hit?.body).toContain("NVDA");
      expect(hit?.fanoutOutcome).toBeNull();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("AI Search upload throws -> upload attempted once, failure logged with upload_failed, read fanoutOutcome null", async () => {
    const { env } = d1();
    const ai = makeAiSearchEnv({ flag: "on", failUpload: true });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGeneration(input(), { ...env, ...ai.env } as never);
      expect(stored?.fanout.aiSearch).toBe("pending");
      await flush();
      expect(ai.uploads).toHaveLength(1);
      const failed = structuredEvents(infoSpy).filter(
        (e) => e.operation === "scheduledReports.fanout_leg_failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.fields.target).toBe("ai-search");
      expect(failed[0]?.fields.code).toBe("upload_failed");
      const hit = await getCanonicalReport(env, stored!.reportId);
      expect(hit?.fanoutOutcome).toBeNull();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("AI Search flag ON but instance unconfigured -> no upload (never a fabricated indexed), failure logged not_configured", async () => {
    const { env } = d1();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGeneration(
        input(),
        { ...env, AI_SEARCH_REPORT_INDEXING_ENABLED: "true" } as never,
      );
      expect(stored?.fanout.aiSearch).toBe("pending");
      await flush();
      const failed = structuredEvents(infoSpy).filter(
        (e) => e.operation === "scheduledReports.fanout_leg_failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.fields.target).toBe("ai-search");
      expect(failed[0]?.fields.code).toBe("not_configured");
      const hit = await getCanonicalReport(env, stored!.reportId);
      expect(hit?.fanoutOutcome).toBeNull();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("row INSERT throws -> null result, no row, no outcome record (REPORT_FANOUT_FAILED member)", async () => {
    const env = { AGENT_DB: new FailingInsertD1() as unknown as D1Database };
    // #3515 S3: the fan-out failure now travels as a structured
    // storeReportAtGeneration.failed event (level error) on the
    // console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGeneration(input(), env);
      expect(stored).toBeNull();
      expect(await rowCount(env)).toBe(0);
      const failed = structuredEvents(infoSpy).find(
        (e) => e.operation === "storeReportAtGeneration.failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.level).toBe("error");
      expect(failed?.fields.code).toBe(DataFoundationCode.REPORT_FANOUT_FAILED);
      expect(String(failed?.fields.message ?? "")).toContain(
        DataFoundationCode.REPORT_FANOUT_FAILED,
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("flag OFF: zero instance calls AND aiSearch pending on the result (not failed)", async () => {
    const { env } = d1();
    // Phase 3 (#6550): AI_SEARCH_REPORT_INDEXING_ENABLED lives in
    // environment.config.json (ON in production), so a bare env no
    // longer means the flag is off.
    const ai = makeAiSearchEnv({ flag: "0" });
    const stored = await storeReportAtGeneration(input(), { ...env, ...ai.env } as never);
    await flush();
    expect(ai.uploads).toHaveLength(0);
    // #6101 step 8: the settled "not_attempted" has no recorded home
    // anymore — the result reads "pending" (unsettled at return) and
    // the flag discipline shows in zero instance calls, never in a
    // recorded "failed".
    expect(stored?.fanout.aiSearch).toBe("pending");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.fanoutOutcome).toBeNull();
  });
});

describe("3c contract: dedupe on the D1 seam", () => {
  it("redelivery returns outcome deduped and re-fires the legs; one reportId; read fanoutOutcome null", async () => {
    const { env } = d1();
    const { env: vecEnv, upserts } = makeVectorEnv();
    const first = await storeReportAtGeneration(input(), { ...env, ...vecEnv } as never);
    await flush();
    const second = await storeReportAtGeneration(input(), { ...env, ...vecEnv } as never);
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    expect(second?.fanout.outcome).toBe("deduped");
    await flush();
    expect(await rowCount(env)).toBe(1);
    expect(upserts).toHaveLength(2); // legs re-fired on redelivery
    const hit = await getCanonicalReport(env, first!.reportId);
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("first store returns stored_inline / STORED through the one seam", async () => {
    const { env } = d1();
    const stored = await storeReportAtGeneration(input({ generationId: undefined }), env);
    expect(stored?.reportId).toBeTruthy();
    expect(stored?.fanout.outcome).toBe("stored_inline");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
    await flush();
    expect(await rowCount(env)).toBe(1);
  });
});

describe("3c contract: seam-parity source pins", () => {
  const scheduledSrc = readFileSync("src/services/scheduledReports.ts", "utf8");

  it("exactly one D1 agent_reports insert exists in src/, in the adapter's recordReport, carrying bodyR2Key", () => {
    // #6101 step 8: the seam's ONE insert path moved from the DO
    // adapter's INSERT INTO mas_reports to the D1 adapter's
    // Drizzle insert — the invariant is unchanged (exactly ONE
    // insert path, carrying the body pointer), its home is now
    // D1AuditReportAdapter.recordReport, and the seam itself
    // holds no SQL. The fanout_outcome half of the old pin is
    // dead: D1 carries no fan-out column.
    const adapterSrc = readFileSync("src/data/d1AuditReportAdapter.ts", "utf8");
    const insertSites = (adapterSrc.match(/\.insert\(agentReports\)/g) ?? []).length;
    expect(insertSites).toBe(1);
    const insertStart = adapterSrc.indexOf(".insert(agentReports)");
    expect(insertStart).toBeGreaterThan(-1);
    const insertText = adapterSrc.slice(insertStart, insertStart + 1200);
    expect(insertText).toContain("bodyR2Key");
    expect(insertText).toContain("onConflictDoNothing");
    // No INSERT INTO mas_reports text remains anywhere in the seam.
    expect(scheduledSrc).not.toContain("INSERT INTO mas_reports");
    expect(scheduledSrc).not.toContain("INSERT INTO ${TABLE}");
  });

  // DELETED #6101 step 8: "persistScheduledReportSql delegates to the
  // seam and is deprecated with its successor named" — the wrapper is
  // deleted with the DO write; there is nothing left to delegate.

  it("no index leg is fired with a discarded (bare void) result anymore", () => {
    // ADAPTED for #3527 S1 (§7 — in-file justification): the
    // leg invocations moved out of the seam into the publish
    // stage (src/services/documentPublish.ts); the seam's
    // fireFanoutIndexLegs now delegates to publishDocument and
    // consumes the stage's per-target settled outcomes.
    // ADAPTED for #6101 step 8: the outcomes are NO LONGER
    // recorded on the row (recordFanoutLegOutcome deleted with
    // the DO row) — the settled outcomes are consumed by the
    // log-only handler, which is the consumption this pin now
    // asserts: every leg invocation's result still reaches a
    // named sink, none is discarded.
    const stageSrc = readFileSync("src/services/documentPublish.ts", "utf8");
    expect(scheduledSrc).not.toMatch(/void indexCanonicalReport/);
    expect(scheduledSrc).not.toContain("indexCanonicalReport(");
    expect(scheduledSrc).not.toContain("indexCanonicalReportInAiSearch(");
    expect(scheduledSrc).toContain("publishDocument(");
    expect(scheduledSrc).toContain("fireFanoutIndexLegs(");
    expect(scheduledSrc).not.toContain("recordFanoutLegOutcome(");
    expect(scheduledSrc).toContain("scheduledReports.fanout_leg_failed");
    // The stage discards nothing either: no bare-void call
    // expression exists in it, and both default executors are
    // wired as the stage's legs.
    expect(stageSrc).not.toMatch(/void\s+\w+\(/);
    expect(stageSrc).toContain("indexCanonicalReport");
    expect(stageSrc).toContain("indexCanonicalReportInAiSearch");
  });

  it("the outcome codes live in the catalog, not as inline strings in the seam", () => {
    const catalog = readFileSync("src/aspects/errorCodes.ts", "utf8");
    expect(catalog).toContain("REPORT_FANOUT_STORED");
    expect(catalog).toContain("REPORT_FANOUT_DEGRADED");
    expect(catalog).toContain("REPORT_FANOUT_FAILED");
    expect(scheduledSrc).not.toContain('"DATA_REPORT_FANOUT');
  });
});
