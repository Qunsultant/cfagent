/** @vitest-environment jsdom */
/**
 * Issue #3655 — S4b (gap map §A, RQ-3a/RQ-5d): the schedule list and
 * detail show which criteria/preset a schedule uses.
 *
 * Live on main (e11ae6f9) before this slice, the detail's Scope
 * section had no "Preset" label at all: a schedule armed from a
 * preset carries presetId and NO frozen filters (by #1499 design —
 * the run resolves the preset's CURRENT criteria at fire time), so
 * its detail showed no criteria whatsoever and never named the
 * preset; the list row's scope showed universe/sector/max only.
 * The preset record (name + criteria) was already fetched for the
 * form via the shared listPresets helper — the detail simply never
 * used it.
 *
 * Pins:
 *  - Detail Scope gains a "Preset" field (stock kind only):
 *    resolved preset name; "<id> (no longer exists)" when the id is
 *    gone; the raw id when the preset list is unavailable (never
 *    invented); "Custom thresholds" when no preset is armed.
 *  - Detail Filters shows the resolved preset's CURRENT criteria
 *    (the criteria the run will use); a custom schedule shows its
 *    stored filters, as today.
 *  - The list row's one-line scope names the preset the same way
 *    ("Preset: <name>" / "<id> (no longer exists)" /
 *    "Custom thresholds").
 *  - The new label stays inside the canonical scope vocabulary
 *    (a subsequence of SCHEDULE_SCOPE_LABEL_ORDER).
 *  - E-13 dialog parity (same form as S4a): the custom-criteria
 *    section states that Min/Max RSI and Min Volume are only
 *    available through a saved preset — the form's custom fields
 *    cover 5 of the 7 panel fields, and the preset-only path was
 *    never stated.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildScheduleDetail,
  scheduleScope,
  SCHEDULE_SCOPE_LABEL_ORDER,
  type PresetRef,
} from "../src/client/scheduledOptionsManager/scheduleDetail";
import type { ScheduledTaskItem } from "../src/client/scheduledOptionsManager/types";
import {
  ScheduleFormModal,
  type ScheduleFormModalProps,
} from "../src/client/scheduledOptionsManager/ScheduleFormModal";
import {
  setTenantProvidersStateForTest,
  resetTenantProvidersStateForTest,
} from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const PRESETS: PresetRef[] = [
  { id: "preset-1", name: "My RSI screen", criteria: { minRsi: 30, maxRsi: 70 } },
  { id: "preset-2", name: "Cheap momentum", criteria: { maxPeRatio: 20, momentum: "bullish_breakout" } },
];

const presetItem: ScheduledTaskItem = {
  id: "sys-market-screen-preset",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 29,
    sector: "Technology",
    presetId: "preset-1",
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const customItem: ScheduledTaskItem = {
  id: "sys-market-screen-custom",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 29,
    sector: "Technology",
    filters: { minPrice: 5, maxPrice: 500 },
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const bareItem: ScheduledTaskItem = {
  id: "sys-market-screen-bare",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    universe: "LEV_ETF",
    maxItems: 29,
    sector: "Technology",
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const gonePresetItem: ScheduledTaskItem = {
  ...presetItem,
  id: "sys-market-screen-gone",
  payload: { ...presetItem.payload, presetId: "preset-9" },
};

const optionsItem: ScheduledTaskItem = {
  id: "user-analysis-1",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: {
    symbols: ["NVDA"],
    thesis: "bullish",
    riskProfile: "balanced",
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 100,
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const ctxWithPresets = { profiles: [], activeEnv: "TEST", userLogin: "trader1", presets: PRESETS };
const ctxNoPresets = { profiles: [], activeEnv: "TEST", userLogin: "trader1" };

function scopeFields(item: ScheduledTaskItem, ctx: any) {
  return buildScheduleDetail(item, ctx).sections.find((s) => s.id === "scope")?.fields ?? [];
}

function scopeValue(item: ScheduledTaskItem, ctx: any, label: string) {
  return scopeFields(item, ctx).find((f) => f.label === label)?.value;
}

describe("Issue #3655 S4b — schedule detail names the preset", () => {
  it("shows the resolved preset name for a preset-armed schedule", () => {
    expect(scopeValue(presetItem, ctxWithPresets, "Preset")).toBe("My RSI screen");
  });

  it("shows the resolved preset's current criteria as the Filters", () => {
    expect(scopeValue(presetItem, ctxWithPresets, "Filters")).toBe("minRsi 30 · maxRsi 70");
  });

  it("names a deleted preset honestly instead of inventing a name", () => {
    expect(scopeValue(gonePresetItem, ctxWithPresets, "Preset")).toBe("preset-9 (no longer exists)");
    expect(scopeValue(gonePresetItem, ctxWithPresets, "Filters")).toBeUndefined();
  });

  it("shows the raw preset id when the preset list is unavailable", () => {
    expect(scopeValue(presetItem, ctxNoPresets, "Preset")).toBe("preset-1");
  });

  it("shows 'Custom thresholds' for a custom schedule, with its stored filters", () => {
    expect(scopeValue(customItem, ctxWithPresets, "Preset")).toBe("Custom thresholds");
    expect(scopeValue(customItem, ctxWithPresets, "Filters")).toBe("minPrice 5 · maxPrice 500");
  });

  it("shows 'Custom thresholds' for a bare schedule with no criteria at all", () => {
    expect(scopeValue(bareItem, ctxWithPresets, "Preset")).toBe("Custom thresholds");
    expect(scopeValue(bareItem, ctxWithPresets, "Filters")).toBeUndefined();
  });

  it("has no Preset field for a non-stock kind", () => {
    expect(scopeValue(optionsItem, ctxWithPresets, "Preset")).toBeUndefined();
  });

  it("keeps the Preset label inside the canonical scope vocabulary, in order", () => {
    const at = SCHEDULE_SCOPE_LABEL_ORDER.indexOf("Preset");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(SCHEDULE_SCOPE_LABEL_ORDER.indexOf("Sector"));
    expect(at).toBeLessThan(SCHEDULE_SCOPE_LABEL_ORDER.indexOf("Filters"));
    const labels = scopeFields(presetItem, ctxWithPresets).map((f) => f.label);
    let cursor = -1;
    for (const label of labels) {
      const pos = SCHEDULE_SCOPE_LABEL_ORDER.indexOf(label);
      expect(pos, `unknown scope label "${label}"`).toBeGreaterThan(-1);
      expect(pos, `scope labels out of canonical order`).toBeGreaterThan(cursor);
      cursor = pos;
    }
  });
});

describe("Issue #3655 S4b — schedule list row names the preset", () => {
  it("names the resolved preset in the row scope", () => {
    expect(scheduleScope(presetItem, [], PRESETS)).toContain("Preset: My RSI screen");
  });

  it("names a deleted preset honestly in the row scope", () => {
    expect(scheduleScope(gonePresetItem, [], PRESETS)).toContain("preset-9 (no longer exists)");
  });

  it("shows the raw preset id in the row scope when the list is unavailable", () => {
    expect(scheduleScope(presetItem, [])).toContain("preset-1");
  });

  it("shows 'Custom thresholds' in the row scope for a custom schedule", () => {
    expect(scheduleScope(customItem, [], PRESETS)).toContain("Custom thresholds");
  });

  it("shows 'Custom thresholds' in the row scope for a bare schedule", () => {
    expect(scheduleScope(bareItem, [], PRESETS)).toContain("Custom thresholds");
  });

  it("leaves non-stock row scopes untouched", () => {
    expect(scheduleScope(optionsItem, [])).toBe("NVDA · max 100");
  });
});

/* ------------------------------------------------------------------ */
/* E-13: the form states the preset-only path for RSI / volume        */
/* ------------------------------------------------------------------ */

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
  // The Modal portals its dialog to document.body, so the section
  // hints live on document, not inside the mount container.
  return document;
}

beforeEach(() => {
  setTenantProvidersStateForTest({ brokerId: "alpaca", dataProviderId: "yahoo" });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  resetTenantProvidersStateForTest();
});

describe("Issue #3655 S4b E-13 — the form states the preset-only path", () => {
  it("states that Min/Max RSI and Min Volume are only available through a saved preset", () => {
    renderModal();
    const note = document.querySelector("#sched-custom-criteria-note")?.textContent ?? "";
    expect(note).toContain("Min/Max RSI");
    expect(note).toContain("Min Volume");
    expect(note).toContain("saved preset");
  });
});
