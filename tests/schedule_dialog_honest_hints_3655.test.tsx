/** @vitest-environment jsdom */
/**
 * Issue #3655 — S4a, narrowed by D1 (user, 2026-11-13): broker/mode at
 * schedule creation DEFAULT to live tenant selections, NOT pinned.
 *
 * The live-default half is already on main (dialog shows the live
 * selections; fire-time re-resolution stands in scheduledTasks.ts).
 * The remaining S4a scope is the honest hints plus confirming the
 * selects stay display-only. Render-level pins:
 *
 *  - #sched-broker is disabled (display-only) and shows the live
 *    tenant broker selection — alpaca here, never a hard-coded
 *    etrade default.
 *  - #sched-mode is disabled (display-only) and shows the live/paper
 *    mode derived from the broker environment.
 *  - Both hints state the live default + re-resolution semantics —
 *    the values are re-resolved from the tenant's live selections
 *    when the schedule fires, so a later change in Settings applies
 *    to future runs without re-arming — and do NOT claim the values
 *    are "Recorded on the schedule at creation" (that overstates:
 *    the recorded value does not bind the run).
 *
 * Harness follows tests/stock_criteria_panel.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ScheduleFormModal,
  type ScheduleFormModalProps,
} from "../src/client/scheduledOptionsManager/ScheduleFormModal";
import {
  setTenantProvidersStateForTest,
  resetTenantProvidersStateForTest,
} from "../src/client/tenantProviders";
import { getBrokerEnvironment } from "../src/client/brokerEnvironment";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderModal() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = () => {};
  const props: ScheduleFormModalProps = {
    editingScheduleId: null,
    submitting: false,
    setModalOpen: noop,
    handleCreateSchedule: async () => {},
    jobType: "marketScreen",
    setJobType: noop,
    targetUniverse: "NASDAQ100",
    setTargetUniverse: noop,
    targetSymbols: "",
    setTargetSymbols: noop,
    maxItems: 0,
    setMaxItems: noop,
    sector: "ALL",
    setSector: noop,
    minPrice: "",
    setMinPrice: noop,
    maxPrice: "",
    setMaxPrice: noop,
    minMarketCap: "",
    setMinMarketCap: noop,
    maxPe: "",
    setMaxPe: noop,
    trendFilter: "",
    setTrendFilter: noop,
    presetId: "",
    setPresetId: noop,
    discoveryInputModel: "saved-request",
    setDiscoveryInputModel: noop,
    discoveryRequests: [],
    setDiscoveryRequests: noop,
    updateDiscoveryRequest: noop,
    derivedSource: "symbols",
    setDerivedSource: noop,
    derivedSymbolsText: "",
    setDerivedSymbolsText: noop,
    derivedWatchlistName: "",
    setDerivedWatchlistName: noop,
    derivedProfileId: "",
    setDerivedProfileId: noop,
    profiles: [],
    profilesError: null,
    selectedDerivedProfileReason: null,
    noViewDraft: {
      symbolsText: "",
      maxPlannedLoss: "",
      minRewardRisk: "",
      minProbabilityOfProfit: "",
      minDte: "",
      maxDte: "",
      riskProfile: "balanced",
    },
    updateNoViewDraft: noop,
    noViewDivergent: false,
    scheduleType: "interval",
    setScheduleType: noop,
    intervalSeconds: 3600,
    setIntervalSeconds: noop,
    cronExpression: "",
    setCronExpression: noop,
    delaySeconds: 0,
    setDelaySeconds: noop,
    scheduledDate: "",
    setScheduledDate: noop,
    thesis: "neutral",
    setThesis: noop,
    riskProfile: "balanced",
    setRiskProfile: noop,
    pushToSlack: false,
    setPushToSlack: noop,
    slackChannel: "",
    setSlackChannel: noop,
    emailTo: "",
    setEmailTo: noop,
    webhookUrl: "",
    setWebhookUrl: noop,
  };
  act(() => {
    root.render(<ScheduleFormModal {...props} />);
  });
  // The Modal portals its dialog to document.body, so the selects and
  // hints live on document, not inside the mount container.
  return document;
}

beforeEach(() => {
  // Live tenant selections: a non-etrade broker proves the dialog
  // reflects the tenant, not a hard-coded default.
  setTenantProvidersStateForTest({ brokerId: "alpaca", dataProviderId: "yahoo" });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  resetTenantProvidersStateForTest();
});

describe("Issue #3655 S4a — schedule dialog broker/mode honest hints", () => {
  it("broker select is display-only and shows the live tenant broker", () => {
    renderModal();
    const el = document;
    const select = el.querySelector<HTMLSelectElement>("#sched-broker");
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(true);
    expect(select!.value).toBe("alpaca");
  });

  it("mode select is display-only and shows the live environment mode", () => {
    renderModal();
    const el = document;
    const select = el.querySelector<HTMLSelectElement>("#sched-mode");
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(true);
    expect(select!.value).toBe(getBrokerEnvironment() === "TEST" ? "paper" : "live");
  });

  it("broker hint states the live default and fire-time re-resolution", () => {
    renderModal();
    const el = document;
    const hint = el.querySelector("#sched-broker-msg")?.textContent ?? "";
    expect(hint).toContain("live default");
    expect(hint).toContain("re-resolved");
    expect(hint).not.toContain("Recorded on the schedule at creation");
  });

  it("mode hint states the live default and fire-time re-resolution", () => {
    renderModal();
    const el = document;
    const hint = el.querySelector("#sched-mode-msg")?.textContent ?? "";
    expect(hint).toContain("live default");
    expect(hint).toContain("re-resolved");
    expect(hint).not.toContain("Recorded on the schedule at creation");
  });
});
