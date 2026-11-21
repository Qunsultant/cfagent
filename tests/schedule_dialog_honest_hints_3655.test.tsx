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
 *
 * Issue #5879 (one-schedule programme) RECONCILES this pin with closed
 * #5187/#5189: the form showed broker/mode TWICE — this display-only
 * pair plus, for options schedules, the editable RunTargetFields pair.
 * The dedupe keeps ONE broker/mode/account selection, shown once:
 * the display-only pair is replaced by a single tenant-default line
 * (#sched-tenant-default) carrying the same honest-hint contract
 * (live default + re-resolution, never "Recorded on the schedule at
 * creation"), and the #5189 override pair stays, labelled as an
 * override of that tenant default. The pins below are updated in the
 * #5879 PR to the new shape; the contract they freeze is unchanged.
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
import type { CreatableJob } from "../src/client/scheduledOptionsManager/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderModal(jobType: CreatableJob = "marketScreen") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = () => {};
  const props: ScheduleFormModalProps = {
    editingScheduleId: null,
    submitting: false,
    setModalOpen: noop,
    handleCreateSchedule: async () => {},
    jobType,
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
    brokerId: "",
    setBrokerId: noop,
    mode: "",
    setMode: noop,
    accountId: "",
    setAccountId: noop,
    // Issue #5879: the modal derives the tenant broker from
    // useTenantProviders, not from this prop — the prop is left
    // unset here on purpose, so the render proves the derivation.
    tenantBrokerId: undefined,
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
  it("shows broker/mode once: no display-only pair anymore (#5879)", () => {
    renderModal();
    const el = document;
    expect(el.querySelector("#sched-broker")).toBeNull();
    expect(el.querySelector("#sched-mode")).toBeNull();
  });

  it("shows the live tenant broker/mode on one tenant-default line (#5879)", () => {
    renderModal();
    const el = document;
    const line = el.querySelector("#sched-tenant-default");
    expect(line).not.toBeNull();
    const text = line!.textContent ?? "";
    // Alpaca here, never a hard-coded etrade default.
    expect(text).toContain("Alpaca");
    expect(text).not.toContain("E*TRADE");
    expect(text).toContain(getBrokerEnvironment() === "TEST" ? "Paper" : "Live");
  });

  it("tenant-default line states the live default and fire-time re-resolution (#5879)", () => {
    renderModal();
    const el = document;
    const text = el.querySelector("#sched-tenant-default")?.textContent ?? "";
    expect(text).toContain("live default");
    expect(text).toContain("re-resolved");
    expect(text).not.toContain("Recorded on the schedule at creation");
  });

  it("non-options jobs show no per-schedule override pair (#5879)", () => {
    renderModal("marketScreen");
    const el = document;
    expect(el.querySelector("#sched-run-broker")).toBeNull();
    expect(el.querySelector("#sched-run-mode")).toBeNull();
  });

  it("options jobs keep the single override pair, labelled as an override (#5879)", () => {
    renderModal("optionsAnalysis");
    const el = document;
    expect(el.querySelector("#sched-run-broker")).not.toBeNull();
    expect(el.querySelector("#sched-run-mode")).not.toBeNull();
    // The tenant default is still shown exactly once, above the override.
    expect(el.querySelectorAll("#sched-tenant-default")).toHaveLength(1);
    const brokerHint = el.querySelector("#sched-run-broker-msg")?.textContent ?? "";
    expect(brokerHint).toContain("Override");
    expect(brokerHint).toContain("Tenant default (Alpaca)");
    const modeHint = el.querySelector("#sched-run-mode-msg")?.textContent ?? "";
    expect(modeHint).toContain("re-resolved");
  });

  it("options override defaults to the tenant default, named (#5879)", () => {
    renderModal("optionsAnalysis");
    const el = document;
    const select = el.querySelector<HTMLSelectElement>("#sched-run-broker");
    expect(select).not.toBeNull();
    expect(select!.value).toBe("");
    expect(select!.options[0]?.textContent).toContain("Tenant default (Alpaca)");
  });
});
