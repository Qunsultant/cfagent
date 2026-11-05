/**
 * Issue #2599 (F4): serve is per format, not per PDF.
 *
 * A failed PDF leg must not suppress successful XLSX/CSV
 * delivery: the followup.report serve job adopts the tabular
 * artifacts (status ready, perFormat pdf: failed, coded pdfNote)
 * and chains deliveries for them. When every format failed, serve
 * still skips with the coded PDF reason, as before.
 *
 * Executor-level pins through executeAsyncJob with a fake-SQL
 * context (same idiom as tests/consolidation_c3_stage_chain.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";

type Row = Record<string, unknown>;

class FakeSql {
  tables: Record<string, Row[]> = { mas_async_jobs: [], mas_screening_activity: [] };

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Row> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Row[], rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    if (/^DELETE FROM/i.test(q)) return wrap([]);
    const tableMatch = q.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    const table = tableMatch?.[1] ?? "";
    if (/^INSERT (?:OR REPLACE )?INTO/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Row = {};
      let ai = 0;
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      }
      // Issue #3264: INSERT OR REPLACE upserts by the first column
      // (the id) — the outcome sink's record path relies on it.
      if (/^INSERT OR REPLACE INTO/i.test(q)) {
        const first = cols[0];
        this.tables[table] = (this.tables[table] ?? []).filter((r) => r[first] !== row[first]);
      }
      (this.tables[table] ??= []).push(row);
      return wrap([], 1);
    }
    if (/^UPDATE/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const assigns = setPart.split(",").map((s) => s.trim());
      let ai = 0;
      const updates: Array<[string, unknown]> = assigns.map((a) => {
        const eq = a.indexOf("=");
        const col = a.slice(0, eq).trim();
        const expr = a.slice(eq + 1).trim();
        return [col, expr === "?" ? args[ai++] : expr.replace(/^'|'$/g, "")] as [string, unknown];
      });
      const wherePart = q.split(/ WHERE /i)[1] ?? "";
      const conds: Array<[string, unknown]> = [];
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) conds.push([m[1], m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "")]);
      }
      let written = 0;
      for (const row of this.tables[table] ?? []) {
        if (conds.every(([c, v]) => row[c] === v)) {
          for (const [col, val] of updates) row[col] = val;
          written++;
        }
      }
      return wrap([], written);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM (\w+)/i);
      if (!listMatch) return wrap([]);
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...(this.tables[listMatch[2]] ?? [])];
      const wherePart = (q.split(/ WHERE /i)[1] ?? "").split(/ ORDER BY /i)[0];
      let ai = 0;
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) {
          const val = m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "");
          rows = rows.filter((r) => r[m[1]] === val);
        }
      }
      if (/ORDER BY created_at DESC/i.test(q)) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (/ORDER BY created_at ASC/i.test(q)) rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const limitMatch = q.match(/LIMIT (\?|\d+)/i);
      if (limitMatch) {
        const n = limitMatch[1] === "?" ? Number(args[ai++]) : Number(limitMatch[1]);
        if (Number.isFinite(n)) rows = rows.slice(0, n);
      }
      // Issue #3264: SELECT * returns full rows (the outcome sink
      // reads them back to merge); COUNT(*) returns the row count.
      if (cols.length === 1 && cols[0] === "*") return wrap(rows);
      if (cols.length === 1 && /^COUNT\(\*\)/i.test(cols[0])) {
        const alias = cols[0].match(/ AS (\w+)/i)?.[1] ?? "count";
        return wrap([{ [alias]: rows.length }]);
      }
      return wrap(rows.map((row) => {
        const out: Row = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      }));
    }
    throw new Error(`FakeSql: unsupported: ${q.slice(0, 90)}`);
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }
}

export interface ServeCaptures {
  /** Canonical rows the serve record wrote (storeCanonicalReport inputs). */
  canonical: Array<Record<string, unknown>>;
  /** DO-storage history (recordOptionsRun's options:last_runs key). */
  history: Map<string, unknown>;
}

function makeCtx(sql: FakeSql, captures?: ServeCaptures): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  // Issue #3264: the record path needs a canonical seam, an outcome
  // sink, and DO history — all captured so the tests can assert the
  // run was recorded, not just that serve skipped.
  const historyStore = captures?.history ?? new Map<string, unknown>();
  const canonicalRows = captures?.canonical ?? [];
  return {
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
    agentCtx: {
      storage: {
        sql: storage,
        get: async (key: string) => historyStore.get(key),
        put: async (key: string, value: unknown) => { historyStore.set(key, value); },
      },
    },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => ({
      events: { create: () => ({}) },
      storeCanonicalReport: (input: Record<string, unknown>) => {
        canonicalRows.push(input);
        return { reportId: `rep-${canonicalRows.length}`, created: true };
      },
      getSql: () => storage,
    }),
    routeRequest: async () => new Response("{}", { status: 200 }),
    nlqSchedulingPort: () => { throw new Error("unused"); },
    nlqStockScreenPort: () => { throw new Error("unused"); },
    followupReportPort: () => ({
      getStockPdf: async (_u: string, key: string) => (key === "k1" ? { fileName: "screen.pdf" } : null),
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true, detail: "sent-1" }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  } as unknown as AsyncJobsContext;
}

const optionsOutcome = (over: Partial<ScreenerRunOutcome> = {}): ScreenerRunOutcome => ({
  kind: "options",
  trigger: "scheduled",
  success: true,
  thesis: "bullish",
  timestamp: "2026-10-24T12:00:00.000Z",
  symbols: ["AAPL"],
  summary: "Options screen — bullish: 1 actionable setup.",
  emailTo: "ops@example.com",
  slackChannel: "stock_screener_channel",
  ...over,
});

async function runServe(outcome: ScreenerRunOutcome): Promise<{
  serve: ReturnType<typeof getAsyncJob>;
  deliveries: Row[];
  canonical: Array<Record<string, unknown>>;
  outcomes: Row[];
  history: Map<string, unknown>;
}> {
  const sql = new FakeSql();
  const captures: ServeCaptures = { canonical: [], history: new Map<string, unknown>() };
  const ctx = makeCtx(sql, captures);
  const { jobId } = await submitAsyncJob(ctx, {
    capability: "followup.report",
    payload: { outcome, userLogin: "alice" },
  } as never);
  await executeAsyncJob(ctx, { jobId });
  return {
    serve: getAsyncJob(ctx, jobId),
    deliveries: sql.rows("mas_async_jobs").filter((r) => r.capability === "followup.deliver"),
    canonical: captures.canonical,
    outcomes: sql.rows("mas_job_outcomes"),
    history: captures.history,
  };
}

describe("F4 per-format serve (#2599)", () => {
  it("failed PDF + generated XLSX/CSV serves ready with tabular artifacts and a coded pdfNote", async () => {
    const { serve, deliveries } = await runServe(optionsOutcome({
      pdfKeys: [],
      pdfStatus: "failed",
      pdfError: "PDF renderer boom",
      xlsxKey: "options:xlsx:1",
      xlsxStatus: "generated",
      csvKey: "options:csv:1",
      csvStatus: "generated",
    }));
    expect(serve?.status).toBe("completed");
    const result = serve?.result as { status?: string; artifacts?: Array<{ kind?: string }>; perFormat?: Record<string, string>; pdfNote?: string };
    expect(result.status).toBe("ready");
    expect((result.artifacts ?? []).map((a) => a.kind).sort()).toEqual(["csv", "xlsx"]);
    expect(result.perFormat?.pdf).toBe("failed");
    expect(result.perFormat?.xlsx).toBe("adopted");
    expect(result.perFormat?.csv).toBe("adopted");
    expect(result.pdfNote).toContain("FAILURE_REPORT_PDF_GENERATION");
    // Deliveries chain for the adopted formats (no skip reason).
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      const payload = JSON.parse(String(d.payload_json));
      expect(payload.skipReason).toBeUndefined();
      expect((payload.artifacts as Array<{ kind?: string }>).map((a) => a.kind).sort()).toEqual(["csv", "xlsx"]);
    }
  });

  it("failed PDF + generated XLSX only still serves (CSV failed stays coded, not blocking)", async () => {
    const { serve } = await runServe(optionsOutcome({
      pdfKeys: [],
      pdfStatus: "failed",
      pdfError: "PDF renderer boom",
      xlsxKey: "options:xlsx:1",
      xlsxStatus: "generated",
      csvStatus: "failed",
      csvError: "CSV boom",
    }));
    const result = serve?.result as { status?: string; artifacts?: Array<{ kind?: string }>; csvNote?: string };
    expect(result.status).toBe("ready");
    expect((result.artifacts ?? []).map((a) => a.kind)).toEqual(["xlsx"]);
    expect(result.csvNote).toContain("FAILURE_REPORT_CSV_GENERATION");
  });

  it("all formats failed still skips with the coded PDF reason (no ready, no fabricated delivery)", async () => {
    const { serve, deliveries } = await runServe(optionsOutcome({
      pdfKeys: [],
      pdfStatus: "failed",
      pdfError: "PDF renderer boom",
      xlsxStatus: "failed",
      xlsxError: "XLSX boom",
      csvStatus: "failed",
      csvError: "CSV boom",
    }));
    const result = serve?.result as { status?: string; reason?: string };
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("FAILURE_REPORT_PDF_GENERATION");
    // Deliveries carry the skip reason (the C3 honesty rule), never a success payload.
    for (const d of deliveries) {
      const payload = JSON.parse(String(d.payload_json));
      expect(payload.skipReason).toContain("FAILURE_REPORT_PDF_GENERATION");
    }
  });
});

describe("Keyless options serve records the run (#3264)", () => {
  it("all formats failed still records canonical + history + outcome rows with failed statuses", async () => {
    const { serve, canonical, outcomes, history } = await runServe(optionsOutcome({
      pdfKeys: [],
      pdfStatus: "failed",
      pdfError: "PDF renderer boom",
      xlsxStatus: "failed",
      xlsxError: "XLSX boom",
      csvStatus: "failed",
      csvError: "CSV boom",
      deliveryId: "scheduled:options:chain-1",
    }));
    const result = serve?.result as { status?: string; reason?: string };
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("FAILURE_REPORT_PDF_GENERATION");
    // The run is recorded despite the skip: one canonical row with
    // per-format failures (never a bare "—"), one history row, one
    // job-outcome row keyed by the delivery id (the Workflow Runs entry).
    expect(canonical).toHaveLength(1);
    const body = canonical[0].body as Record<string, unknown>;
    expect(body.trigger).toBe("scheduled");
    expect(body.pdfStatus).toBe("failed");
    expect(body.pdfError).toBe("PDF renderer boom");
    expect(body.xlsxStatus).toBe("failed");
    expect(body.xlsxError).toBe("XLSX boom");
    expect(body.csvStatus).toBe("failed");
    expect(body.csvError).toBe("CSV boom");
    expect(body.pdfKey).toBeNull();
    const runs = history.get("options:last_runs") as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs?.[0].timestamp).toBe("2026-10-24T12:00:00.000Z");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].id).toBe("scheduled:options:chain-1");
    expect(outcomes[0].kind).toBe("options");
    expect(outcomes[0].trigger).toBe("scheduled");
  });

  it("no keys and no carried statuses still records failed legs (never a silent absence)", async () => {
    const { serve, canonical, outcomes } = await runServe(optionsOutcome({
      pdfKeys: [],
      deliveryId: "scheduled:options:chain-2",
    }));
    const result = serve?.result as { status?: string; reason?: string };
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("FAILURE_REPORT_ARTIFACT_MISSING");
    expect(canonical).toHaveLength(1);
    const body = canonical[0].body as Record<string, unknown>;
    expect(body.pdfStatus).toBe("failed");
    expect(body.xlsxStatus).toBe("failed");
    expect(body.csvStatus).toBe("failed");
    expect(String(body.pdfError)).toContain("FAILURE_REPORT_ARTIFACT_MISSING");
    expect(String(body.xlsxError)).toContain("FAILURE_REPORT_ARTIFACT_MISSING");
    expect(String(body.csvError)).toContain("FAILURE_REPORT_ARTIFACT_MISSING");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].id).toBe("scheduled:options:chain-2");
  });

  it("a keyless stock outcome records nothing (the rule is options-only)", async () => {
    const { serve, canonical, outcomes } = await runServe({
      ...optionsOutcome({ pdfKeys: [] }),
      kind: "stock",
    });
    const result = serve?.result as { status?: string; reason?: string };
    expect(result.status).toBe("skipped");
    expect(canonical).toHaveLength(0);
    expect(outcomes).toHaveLength(0);
  });
});
