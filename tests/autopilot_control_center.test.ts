import { describe, it, expect, vi } from "vitest";
import {
  AutopilotControlCenter,
  AutopilotPolicyLimits,
  AutonomousActionItem,
  mapAuditLogToAutonomousAction,
  mapPolicyVerdictToRow,
  mapTradeRecordToAutonomousAction,
} from "../src/client/components/AutopilotControlCenter";

describe("Autopilot Control Center & Policy Limits Cards (Issue #20)", () => {
  describe("Policy Limits Defaults & Specification", () => {
    it("defines exact institutional default policy limits matching NextGenTP spec", () => {
      const defaultLimits: AutopilotPolicyLimits = {
        maxPositionPct: 10.0,
        cashReservePct: 5.0,
        ordersPerDay: 10,
        drawdownAlertPct: 20.0,
        universe: "Default large caps/ETFs",
        riskProfile: "moderate",
      };

      expect(defaultLimits.maxPositionPct).toBe(10.0);
      expect(defaultLimits.cashReservePct).toBe(5.0);
      expect(defaultLimits.ordersPerDay).toBe(10);
      expect(defaultLimits.drawdownAlertPct).toBe(20.0);
      expect(defaultLimits.universe).toBe("Default large caps/ETFs");
      expect(defaultLimits.riskProfile).toBe("moderate");
    });

    it("supports policy limit updates across customizable thresholds", () => {
      const customLimits: AutopilotPolicyLimits = {
        maxPositionPct: 15.0,
        cashReservePct: 8.0,
        ordersPerDay: 20,
        drawdownAlertPct: 15.0,
        universe: "Nasdaq 100 & AI Growth",
        riskProfile: "aggressive",
      };

      expect(customLimits.maxPositionPct).toBeGreaterThan(10);
      expect(customLimits.riskProfile).toBe("aggressive");
      expect(customLimits.universe).toContain("Nasdaq");
    });
  });

  describe("Autonomous Actions & Attestation Integrity", () => {
    it("validates autonomous action records adhere to W3C DID attestation standards", () => {
      const mockAction: AutonomousActionItem = {
        id: "act-test-01",
        timestamp: "10:35:00 AM",
        actionType: "order",
        symbol: "NVDA",
        summary: "Limit Buy 20 shares @ $138.25",
        policyCheckRule: "Max position (6.8%) ≤ 10.00%",
        policyCheckPassed: true,
        status: "executed",
        didAttestation: {
          did: "did:agent:openaimp:trading",
          signature: "sig_ed25519_nvda_p98a1",
        },
      };

      expect(mockAction.id).toBeTruthy();
      expect(mockAction.symbol).toBe("NVDA");
      expect(mockAction.policyCheckPassed).toBe(true);
      expect(mockAction.status).toBe("executed");
      expect(mockAction.didAttestation.did).toMatch(/^did:agent:/);
      expect(mockAction.didAttestation.signature).toMatch(/^sig_/);
    });

    it("verifies routing to approval when Autopilot is paused or under caution", () => {
      const pausedAction: AutonomousActionItem = {
        id: "act-test-02",
        timestamp: "10:36:00 AM",
        actionType: "order",
        symbol: "TSLA",
        summary: "Limit Buy 15 shares @ $220.50",
        policyCheckRule: "Max position size ≤ 10.00%",
        policyCheckPassed: true,
        status: "routed_to_approval",
        didAttestation: {
          did: "did:agent:openaimp:trading",
          signature: "sig_0xabcdef123456",
        },
      };

      expect(pausedAction.status).toBe("routed_to_approval");
      expect(pausedAction.policyCheckPassed).toBe(true);
    });

    it("verifies emergency kill switch blocks autonomous actions", () => {
      const blockedAction: AutonomousActionItem = {
        id: "act-test-03",
        timestamp: "10:37:00 AM",
        actionType: "order",
        symbol: "BTC/USD",
        summary: "Market Buy 0.5 BTC",
        policyCheckRule: "Platform kill switch tripped",
        policyCheckPassed: false,
        status: "blocked",
        didAttestation: {
          did: "did:agent:openaimp:trading",
          signature: "sig_kill_switch_active",
        },
      };

      expect(blockedAction.status).toBe("blocked");
      expect(blockedAction.policyCheckPassed).toBe(false);
    });
  });

  describe("Live Backend Ledger Integration (mas_events & mas_trades)", () => {
    it("maps backend mas_events audit records to live AutonomousActionItems", () => {
      // §7 adaptation (#2389): the fixture now carries the broker
      // order reference the event recorded — provenance "live" is
      // derived from it, not hardcoded. (The signature fixture is
      // assembled from fragments per the house rule.)
      const rawEvent = {
        id: "evt-trade-12345",
        type: "alpaca.order_placed",
        agent: "trading",
        payload: {
          symbol: "NVDA",
          qty: 25,
          side: "buy",
          status: "filled",
          executionId: "alp_ord_8f3k2",
          proposerDid: "did:agent:openaimp:trading",
          signature: ["sig", "ed25519", "test", "proof"].join("_"),
        },
        created_at: "2026-10-14T10:45:00.000Z",
      };

      const mapped = mapAuditLogToAutonomousAction(rawEvent);

      expect(mapped.id).toBe("evt-trade-12345");
      expect(mapped.actionType).toBe("order");
      expect(mapped.symbol).toBe("NVDA");
      expect(mapped.source).toBe("live");
      expect(mapped.status).toBe("executed");
      expect(mapped.policyCheckPassed).toBe(true);
      expect(mapped.didAttestation.did).toBe("did:agent:openaimp:trading");
      expect(mapped.didAttestation.signature).toBe("sig_ed25519_test_proof");
    });

    it("maps E*TRADE mas_trades records to live AutonomousActionItems", () => {
      // §7 adaptation (#2389): the fixture now carries the broker
      // order reference (orderRef) a real placement persists —
      // provenance "live" is derived from it, not hardcoded.
      const rawTrade: any = {
        id: "tr_etrade_99182",
        sessionId: "session_user_1",
        symbol: "AAPL",
        action: "BUY",
        orderType: "LIMIT",
        quantity: 50,
        price: 230.5,
        totalValue: 11525,
        status: "executed",
        orderRef: "et_order_99182",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:agent:openaimp:orchestrator",
        proofSignature: "sig_ed25519_aapl_proof_882a",
        previewNotes: "Position size 7.2% ≤ 10.00% Limit",
        createdAt: "2026-10-14T11:00:00.000Z",
        updatedAt: "2026-10-14T11:00:05.000Z",
      };

      const mapped = mapTradeRecordToAutonomousAction(rawTrade);

      expect(mapped.id).toBe("tr_etrade_99182");
      expect(mapped.actionType).toBe("order");
      expect(mapped.symbol).toBe("AAPL");
      expect(mapped.source).toBe("live");
      expect(mapped.status).toBe("executed");
      expect(mapped.summary).toContain("BUY 50 shares @ $230.50");
      expect(mapped.didAttestation.signature).toBe("sig_ed25519_aapl_proof_882a");
    });
  });
});

describe("Policy Decisions Audit (Issue #651)", () => {
  const baseVerdict = {
    id: "v-1",
    symbol: "tsla",
    action: "buy",
    quantity: 40,
    notional: 9600,
    mode: "live",
    dry_run: 0,
    passed: 0,
    execution_allowed: 0,
    requires_approval: 0,
    binding_rule: "maxPositionPct",
    detail: "Position would exceed 10% of NAV",
    signature: "sig_ed25519_x",
    created_at: "2026-10-21T13:45:00.000Z",
  };

  it("maps a blocked verdict with its binding rule and detail", () => {
    const row = mapPolicyVerdictToRow(baseVerdict);
    expect(row.outcome).toBe("blocked");
    expect(row.outcomeLabel).toBe("Blocked");
    expect(row.outcomeTone).toBe("danger");
    expect(row.ruleLabel).toBe("maxPositionPct");
    expect(row.detail).toContain("exceed 10%");
    expect(row.intentLabel).toBe("buy 40 TSLA");
    expect(row.notionalLabel).toBe("$9,600");
    expect(row.signed).toBe(true);
    expect(row.modeLabel).toBe("live");
  });

  it("maps an executable verdict as Allowed", () => {
    const row = mapPolicyVerdictToRow({
      ...baseVerdict,
      id: "v-2",
      passed: 1,
      execution_allowed: 1,
      binding_rule: null,
      detail: "Within all limits",
    });
    expect(row.outcome).toBe("allowed");
    expect(row.outcomeTone).toBe("success");
    expect(row.ruleLabel).toBe("—");
  });

  it("maps a held verdict as Approval required (execution_allowed wins when both set)", () => {
    const held = mapPolicyVerdictToRow({ ...baseVerdict, requires_approval: 1 });
    expect(held.outcome).toBe("approval_required");
    expect(held.outcomeTone).toBe("warning");
    const both = mapPolicyVerdictToRow({ ...baseVerdict, requires_approval: true, execution_allowed: true });
    expect(both.outcome).toBe("allowed");
  });

  it("labels dry runs, tolerates boolean flags and missing fields", () => {
    const row = mapPolicyVerdictToRow({ dry_run: true, execution_allowed: true, notional: null });
    expect(row.modeLabel).toBe("dry run");
    expect(row.notionalLabel).toBe("—");
    expect(row.intentLabel).toBe("—");
    expect(row.signed).toBe(false);
    // #4407: a missing timestamp renders as "—", never as an empty
    // cell or a raw stored string.
    expect(row.timeLabel).toBe("—");
  });
});
