/**
 * Pinning test for #5040 — One store per family (D-14, H-3, H-4, H-5, H-6).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("#5040 one store per family", () => {
  it("D-14: wrangler.jsonc defines no legacy kv_namespaces binding", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).not.toMatch(/"kv_namespaces"\s*:/);
  });

  it("H-3: reports canonical store is mas_reports (DO) with D1 agent_reports projection", () => {
    const reports = read("src/services/scheduledReports.ts");
    expect(reports).toContain("mas_reports");
    expect(reports).toContain("canonicalReportStorePorts");
  });

  it("H-4: schedules canonical store is unified_schedules (ScheduleStore)", () => {
    const systems = read("src/services/scheduleSystems.ts");
    expect(systems).toContain("unified_schedules");
  });

  it("H-5: payments canonical ledger is mas_transactions (KV blob ledger retired)", () => {
    const paymentsAgent = read("src/agents/payments-agent.ts");
    expect(paymentsAgent).toContain("retired as a system of record");
    expect(paymentsAgent).toContain("mas_transactions");
  });

  it("H-6: report assets store through reportBlobStore (REPORTS_BUCKET primary)", () => {
    const assetAgent = read("src/agents/report-asset-agent.ts");
    expect(assetAgent).toContain("putReportPdf");
  });
});
