// @vitest-environment jsdom
/**
 * Issue #5102 (F5 of #5094) — audit-record provenance, rendered:
 * every run / trade / report row shows the binding it recorded,
 * MASKED, never the full account id; an unbound row says so
 * explicitly.
 *
 * Surfaces covered (mirrors tests/account_binding_ux_5113.test.tsx):
 *  - the shared row label (`formatRecordBindingLabel`): masked
 *    type + id, "Unbound" when the row recorded none;
 *  - the trade ledger (`LedgerPanel`, props-driven): bound + legacy
 *    rows;
 *  - Docs & Reports (`DocsAndReportsPanel`, `/api/runs` mocked):
 *    bound + legacy rows, via the real `runSummaryFromReport` →
 *    `toDocumentRows` path;
 *  - the run ledger (`ScheduleRunLedgerPanel`, `listAllRuns`
 *    mocked): bound + legacy rows;
 *  - the audit vault card (`AuditEventCard`): the masked binding
 *    cell on a brokered event, no cell on a non-broker event.
 *    NOTE: the card's pre-existing raw-payload `<pre>` still shows
 *    the stored payload (the plan's §5 keeps the full-payload
 *    detail view; showing the full id there is Ceos's display
 *    decision) — so the vault assertions scope to the ADDED cell,
 *    not the whole card's text;
 *  - the run-details modal (`RunDetailsModal`, portaled — assert
 *    on document.body per #1880): the provenance `accountId`
 *    entry renders masked.
 *
 * The F2 badge itself is NOT used on history rows by design: it is
 * store-driven (it shows the binding that is LIVE right now, with
 * a Change affordance for it), while a history row must show the
 * tuple the record STAMPED. Rows render the badge's own label +
 * mask helpers (`formatRecordBindingLabel`) inside a plain Badge.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRecordBindingLabel } from "../src/client/ActiveBindingBadge";
import { maskAccountId } from "../src/config/accountBindings";
import { LedgerPanel } from "../src/client/LedgerPanel";
import { DocsAndReportsPanel } from "../src/client/DocsAndReportsPanel";
import { ScheduleRunLedgerPanel } from "../src/client/ScheduleRunLedgerPanel";
import { AuditEventCard } from "../src/client/components/AuditEventCard";
import { RunDetailsModal } from "../src/client/components/RunDetailsModal";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { runSummaryFromReport } from "../src/services/runSummaries";
import type { TradeRecord } from "../src/types";
import type { AuditLogEvent } from "../src/client/chat/types";
import type { RunDetail } from "../src/services/runDetails";

vi.mock("../src/client/jobsApi", () => ({
  listAllRuns: vi.fn(),
  triggerGoal: vi.fn(),
  triggerResearchRun: vi.fn(),
}));

import { listAllRuns } from "../src/client/jobsApi";

const FULL_ID = "PA-9001234";
const MASKED = maskAccountId(FULL_ID);

let mountedContainer: HTMLDivElement | null = null;
let mountedRoot: ReturnType<typeof createRoot> | null = null;

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  mountedContainer = document.createElement("div");
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  await act(async () => {
    mountedRoot!.render(node);
  });
  return mountedContainer;
}

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot!.unmount();
    });
    mountedRoot = null;
  }
  if (mountedContainer) {
    mountedContainer.remove();
    mountedContainer = null;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("row binding label (#5102)", () => {
  it("renders the masked type + id, never the full id", () => {
    const label = formatRecordBindingLabel({ accountType: "stock", accountId: FULL_ID });
    expect(label).toBe(`Stock ${MASKED}`);
    expect(label).not.toContain(FULL_ID);
    expect(label).toContain("••••");
  });

  it("an unbound row reads Unbound — null, undefined, or empty alike", () => {
    expect(formatRecordBindingLabel(null)).toBe("Unbound");
    expect(formatRecordBindingLabel(undefined)).toBe("Unbound");
    expect(formatRecordBindingLabel({ accountType: null, accountId: null })).toBe("Unbound");
    expect(formatRecordBindingLabel({ accountType: "stock", accountId: "" })).toBe("Unbound");
  });
});

describe("trade ledger rows (#5102)", () => {
  function trade(overrides: Partial<TradeRecord>): TradeRecord {
    return {
      id: "ord-1",
      sessionId: "sess-1",
      symbol: "ACME",
      action: "BUY",
      orderType: "MARKET",
      quantity: 2,
      price: 100,
      totalValue: 200,
      status: "previewed",
      proposerDid: "did:agent:openaimp:alice",
      proofSignature: "sig",
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
      ...overrides,
    } as TradeRecord;
  }

  it("shows the masked account per row; a legacy row reads Unbound; the full id never renders", async () => {
    const container = await mount(
      <LedgerPanel
        orders={[
          trade({
            id: "ord-bound",
            broker: "alpaca",
            mode: "paper",
            accountType: "stock",
            accountId: FULL_ID,
            bindingScope: "copilot",
            bindingSource: "binding",
          }),
          trade({ id: "ord-legacy", broker: "alpaca", mode: "paper" }),
        ]}
        ordersLoading={false}
        fetchOrders={async () => {}}
        setRiskSubject={() => {}}
      />,
    );
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain(`Stock ${MASKED}`);
    expect(container.textContent).toContain("Unbound");
    expect(container.textContent).not.toContain(FULL_ID);
  });
});

describe("Docs & Reports rows (#5102)", () => {
  it("shows the masked account per row; a legacy row reads Unbound; the full id never renders", async () => {
    const bound = runSummaryFromReport({
      id: "rep-5102",
      runId: "sched-5102",
      title: "Stock screen",
      source: "screener",
      summary: "1 completed.",
      body: JSON.stringify({
        success: true,
        mode: "paper",
        provenance: {
          brokerId: "alpaca",
          accountType: "stock",
          accountId: FULL_ID,
          bindingScope: "schedule",
          bindingSource: "binding",
        },
      }),
      createdAt: "2026-11-03T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    const legacy = runSummaryFromReport({
      id: "rep-legacy",
      runId: "sched-legacy",
      title: "Stock screen",
      source: "screener",
      summary: "1 completed.",
      body: JSON.stringify({ success: true }),
      createdAt: "2026-11-02T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ runs: [bound, legacy], storeErrors: {} })),
    );
    const container = await mount(<DocsAndReportsPanel />);
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain(`Stock ${MASKED}`);
    expect(container.textContent).toContain("Unbound");
    expect(container.textContent).not.toContain(FULL_ID);
  });
});

describe("run ledger rows (#5102)", () => {
  it("shows the masked account per row; a legacy row reads Unbound; the full id never renders", async () => {
    const bound = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "sched-5102",
      operation: "autonomousMarketScreen",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      accountType: "stock",
      accountId: FULL_ID,
      bindingScope: "schedule",
      bindingSource: "binding",
    });
    const legacy = buildJobRunRecord({
      system: "scheduled-agent-goal",
      jobId: "test-goal",
      operation: "test.op",
      started: "2026-11-02T00:00:00.000Z",
      finished: "2026-11-02T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    vi.mocked(listAllRuns).mockResolvedValue({ runs: [bound, legacy], partial: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ runs: [], jobs: [] })),
    );
    const container = await mount(<ScheduleRunLedgerPanel />);
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain(`Stock ${MASKED}`);
    expect(container.textContent).toContain("Unbound");
    expect(container.textContent).not.toContain(FULL_ID);
  });
});

describe("audit vault card (#5102)", () => {
  function event(payload: Record<string, unknown>): AuditLogEvent {
    return {
      id: "evt-1",
      type: "broker.account_binding_resolved",
      agent: "trading",
      payload,
      created_at: "2026-11-03T00:00:00.000Z",
    };
  }

  it("a brokered event shows the masked binding cell", async () => {
    const container = await mount(
      <AuditEventCard
        event={event({
          broker: "alpaca",
          mode: "paper",
          accountType: "stock",
          accountId: FULL_ID,
          bindingScope: "schedule",
          bindingSource: "binding",
        })}
      />,
    );
    // Scope to the cell: the pre-existing raw-payload <pre> below it
    // still shows the stored payload by design (§5 keeps the
    // full-payload detail view), so the full-id assertion applies
    // to the badge element, not the whole card.
    const badges = Array.from(container.querySelectorAll("span")).map(
      (el) => el.textContent ?? "",
    );
    expect(badges).toContain(`Stock ${MASKED}`);
    expect(badges.join(" ")).not.toContain(FULL_ID);
    expect(container.textContent).toContain("Account:");
  });

  it("a brokered event with binding fields but no account reads Unbound", async () => {
    const container = await mount(
      <AuditEventCard
        event={event({ bindingScope: "schedule", bindingSource: "binding" })}
      />,
    );
    expect(container.textContent).toContain("Account:");
    expect(container.textContent).toContain("Unbound");
  });

  it("a non-broker event shows no binding cell at all", async () => {
    const container = await mount(
      <AuditEventCard
        event={event({ message: "goal created", goalId: "g-1" })}
      />,
    );
    expect(container.textContent).not.toContain("Account:");
  });
});

describe("run details modal (#5102)", () => {
  it("the provenance accountId entry renders masked, never full", async () => {
    const detail = {
      catalogVersion: "1",
      id: "rep-5102",
      runId: "sched-5102",
      kind: "report",
      source: "options_research",
      title: "Options screen",
      createdAt: "2026-11-03T00:00:00.000Z",
      status: "completed",
      resultCount: 1,
      store: "mas_reports",
      request: [],
      defaultsApplied: [],
      provenance: {
        executionMode: "async",
        syncAsync: "async",
        interface: "schedule",
        parallelism: null,
        parallelCount: null,
        parallelCap: null,
        submittedVia: null,
        deliveredVia: null,
        trigger: "scheduled",
        scheduleId: "sched-5102",
        goalId: null,
        asyncJobId: null,
        brokerId: "alpaca",
        tradingMode: "paper",
        accountType: "stock",
        accountId: FULL_ID,
        bindingScope: "schedule",
        bindingSource: "binding",
      },
      lineage: {
        inputHash: null,
        captureIds: [],
        captures: [],
        engineVersion: null,
        catalogueVersion: null,
        rendererVersions: {},
        store: "mas_reports",
        storageMode: "inline",
        bodyR2Key: null,
        origin: { trigger: null, channel: null, interface: null, actor: null },
      },
      stages: [],
      reasons: [],
      formats: [],
    } as unknown as RunDetail;
    await mount(
      <RunDetailsModal
        open
        onClose={() => {}}
        detail={detail}
        loading={false}
        error={null}
      />,
    );
    // The modal portals to document.body (#1880): assert there.
    expect(document.body.textContent).toContain("Provenance");
    expect(document.body.textContent).toContain(MASKED);
    expect(document.body.textContent).not.toContain(FULL_ID);
  });
});
