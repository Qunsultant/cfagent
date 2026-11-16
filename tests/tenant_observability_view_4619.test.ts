import { describe, it, expect } from "vitest";
import type { AuditEventRow, AuditReader } from "../src/data/auditReportPorts";
import { auditRowFromDraft } from "../src/data/auditReportProjection";
import { buildTenantObservabilityView } from "../src/observability/tenantObservabilityView";

function makeInMemoryAuditReader(rows: AuditEventRow[]): AuditReader {
  return {
    async listAuditForChain(tenantId, chainId) {
      return rows.filter((r) => r.tenantId === tenantId && r.chainId === chainId);
    },
    async listAuditForTenant(tenantId) {
      return rows.filter((r) => r.tenantId === tenantId);
    },
  };
}

describe("One per-tenant observability view (#4619)", () => {
  it("aggregates runs, deliveries, denials, and fallbacks for one tenant with full provenance tuples", async () => {
    const rows: AuditEventRow[] = [
      auditRowFromDraft(
        {
          tenantId: "tenant-acme",
          workspaceId: "ws-1",
          chainId: "chain-1",
          eventKind: "screener.run",
          subjectType: "api",
          subjectId: "job-1",
          actor: "alice",
          detailJson: JSON.stringify({ providerId: "fmp", brokerId: "none", channel: "api" }),
          occurredAtMs: 1000,
          provenanceWriter: "audit",
          provenanceSourceDo: "ScreenerAgent",
          provenanceSourceVersion: "v1",
        },
        "e1",
        1001,
      ),
      auditRowFromDraft(
        {
          tenantId: "tenant-acme",
          workspaceId: "ws-1",
          chainId: "chain-1",
          eventKind: "delivery.sent",
          subjectType: "slack",
          subjectId: "msg-1",
          actor: "alice",
          detailJson: JSON.stringify({ providerId: "fmp", brokerId: "none", channel: "slack" }),
          occurredAtMs: 2000,
          provenanceWriter: "audit",
          provenanceSourceDo: "DeliveryAgent",
          provenanceSourceVersion: "v1",
        },
        "e2",
        2001,
      ),
      auditRowFromDraft(
        {
          tenantId: "tenant-acme",
          workspaceId: "ws-1",
          chainId: "chain-1",
          eventKind: "access.denied",
          subjectType: "api",
          subjectId: "job-2",
          actor: "bob",
          detailJson: JSON.stringify({ providerId: "polygon", brokerId: "alpaca", channel: "api" }),
          occurredAtMs: 3000,
          provenanceWriter: "audit",
          provenanceSourceDo: "GateAgent",
          provenanceSourceVersion: "v1",
        },
        "e3",
        3001,
      ),
      // Another tenant's event must never appear
      auditRowFromDraft(
        {
          tenantId: "tenant-other",
          workspaceId: "ws-2",
          chainId: "chain-2",
          eventKind: "screener.run",
          subjectType: "api",
          subjectId: "job-9",
          actor: "eve",
          detailJson: JSON.stringify({ providerId: "fmp", brokerId: "none", channel: "api" }),
          occurredAtMs: 4000,
          provenanceWriter: "audit",
          provenanceSourceDo: "ScreenerAgent",
          provenanceSourceVersion: "v1",
        },
        "e4",
        4001,
      ),
    ];

    const view = await buildTenantObservabilityView(
      makeInMemoryAuditReader(rows),
      "tenant-acme",
    );

    expect(view.tenantId).toBe("tenant-acme");
    expect(view.counts).toEqual({
      total: 3,
      run: 1,
      delivery: 1,
      denial: 1,
      fallback: 0,
    });
    expect(view.entries.map((e) => e.id)).toEqual([
      "tenant-acme:e3",
      "tenant-acme:e2",
      "tenant-acme:e1",
    ]);
    expect(view.denials[0].provenance).toEqual({
      tenantId: "tenant-acme",
      userId: "bob",
      providerId: "polygon",
      brokerId: "alpaca",
      channel: "api",
    });
  });

  it("rejects empty tenantId", async () => {
    await expect(
      buildTenantObservabilityView(makeInMemoryAuditReader([]), ""),
    ).rejects.toThrow(/non-empty tenantId/);
  });
});
