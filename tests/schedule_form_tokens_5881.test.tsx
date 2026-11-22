/** @vitest-environment jsdom */
/**
 * Issue #5881 — Configure New Schedule tokens.css/primitives.css
 * usability pass (one-schedule programme, parent #3121).
 *
 * The create form carried its layout in 13 inline `style={{` props
 * across five files, off-scale lengths (0.3rem / 0.6rem / 0.7rem),
 * a raw <details>/<summary> with no Disclosure primitive in ui/,
 * and hardcoded pixels in the sched-* rules (min-width: 1180px,
 * modal width: min(860px, ...)). This suite pins the converted
 * shape — source scans for the structural claims, renders for the
 * DOM the user gets:
 *
 *  - the five form files contain zero inline styles (their #3047
 *    baselines go to 0);
 *  - scheduledOptions.css carries no px literal except 1px borders;
 *  - no off-scale rem literal survives in the five files;
 *  - the custom-criteria <details> is the ui/ Disclosure primitive;
 *  - the two dead sched-* rules are gone (class + freeze entry);
 *  - the three new bespoke classes exist and are freeze-registered
 *    (wave S-U8, the sched-* family's wave);
 *  - the ui-mt-2 utility exists in primitives.css (the system
 *    sheet, not a bespoke rule); the two off-scale margins use
 *    space-2 (0.5rem) — the MARGIN_RATCHET allows only ui-mt-0/1/2,
 *    so no new utility is added until the utilities slice.
 *
 * Sizes are preserved exactly (px -> rem at 16px root) except the
 * two off-scale margins, which use space-2 (0.5rem) — tightening
 * 2px (0.625rem -> 0.5rem) and 4px (0.75rem -> 0.5rem) — because the
 * margin ratchet forbids new utilities: this is a conformance pass,
 * not a visual redesign.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Disclosure } from "../src/client/components/ui/Disclosure";
import { ScheduleFormModal, type ScheduleFormModalProps } from "../src/client/scheduledOptionsManager/ScheduleFormModal";
import { CadenceFields } from "../src/client/scheduledOptionsManager/CadenceFields";
import { ThesisRiskFields } from "../src/client/scheduledOptionsManager/ThesisRiskFields";
import { NotificationFields } from "../src/client/scheduledOptionsManager/NotificationFields";
import {
  setTenantProvidersStateForTest,
  resetTenantProvidersStateForTest,
} from "../src/client/tenantProviders";
import type { CreatableJob } from "../src/client/scheduledOptionsManager/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORM_FILES = [
  "src/client/scheduledOptionsManager/CadenceFields.tsx",
  "src/client/scheduledOptionsManager/DiscoveryFormSections.tsx",
  "src/client/scheduledOptionsManager/NotificationFields.tsx",
  "src/client/scheduledOptionsManager/ScheduleFormModal.tsx",
  "src/client/scheduledOptionsManager/ThesisRiskFields.tsx",
];
const CSS_FILE = "src/client/scheduledOptions.css";

function read(rel: string): string {
  return readFileSync(join(HERE, rel), "utf8");
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("form has no inline styles (#5881)", () => {
  it("the five form files contain zero style={{ props", () => {
    const offenders = FORM_FILES.filter((f) => read(f).includes("style={{"));
    expect(offenders).toEqual([]);
  });

  it("the five files' #3047 baselines are 0", () => {
    const baselines = JSON.parse(
      read("tests/ux_inline_baselines_3047.json"),
    ) as Record<string, number>;
    for (const f of FORM_FILES) expect(baselines[f]).toBe(0);
  });

  it("no off-scale rem literal survives in the five files", () => {
    for (const f of FORM_FILES) {
      const src = read(f);
      expect(src).not.toContain("0.3rem");
      expect(src).not.toContain("0.6rem");
      expect(src).not.toContain("0.7rem");
    }
  });
});

describe("sched-* rules are token-only (#5881)", () => {
  it("scheduledOptions.css carries no px literal except 1px borders", () => {
    const css = stripCssComments(read(CSS_FILE));
    const px = [...css.matchAll(/([0-9]+(?:\.[0-9]+)?)px/g)].map((m) => m[0]);
    const nonBorder = px.filter((v) => v !== "1px");
    expect(nonBorder).toEqual([]);
    expect(px).toContain("1px");
  });

  it("the converted widths keep their exact sizes (px -> rem at 16px root)", () => {
    const css = read(CSS_FILE);
    // 1180px table floor, 860/520/560px modal widths, 960px modal cap,
    // 680px form cap, 140/220px detail columns, 200/220/260/320px row
    // floors, 260/280px auto-fill floors, 280px payload cap, 3px pause bar.
    for (const rem of [
      "73.75rem", "53.75rem", "60rem", "32.5rem", "35rem", "42.5rem",
      "8.75rem", "13.75rem", "12.5rem", "16.25rem", "20rem", "17.5rem",
      "0.1875rem",
    ]) {
      expect(css).toContain(rem);
    }
    expect(css).not.toContain("1180px");
    expect(css).not.toContain("860px");
  });

  it("the dead sched-* rules are gone", () => {
    const css = read(CSS_FILE);
    expect(css).not.toContain("sched-detail-section-title");
    expect(css).not.toContain("sched-dialog-title");
  });

  it("the three new bespoke classes exist and are freeze-registered (S-U8)", () => {
    const css = read(CSS_FILE);
    const freeze = JSON.parse(
      read("tests/ux_layout_freeze_3136.json"),
    ) as Record<string, { file: string; wave: string }>;
    for (const cls of [
      "sched-form",
      "sched-channel-input",
      "channel-check-card--dimmed",
    ]) {
      expect(css).toContain(`.${cls}`);
      expect(freeze[cls]).toEqual({
        file: "src/client/scheduledOptions.css",
        wave: "S-U8",
      });
    }
    expect(freeze["sched-detail-section-title"]).toBeUndefined();
    expect(freeze["sched-dialog-title"]).toBeUndefined();
  });

  it("the ui-mt-2 utility exists in primitives.css; no new ui-mt-* utility is added", () => {
    const primitives = read("src/client/components/ui/primitives.css");
    expect(primitives).toContain(".ui-mt-2 {");
    expect(primitives).toContain("margin-top: var(--space-2);");
    // The two off-scale margins (0.625rem / 0.75rem) use space-2
    // (0.5rem) instead: the MARGIN_RATCHET in
    // tests/template_rule_of_three_4913.test.ts allows only
    // ui-mt-0/1/2, so ui-mt-2-5 / ui-mt-3 must not exist.
    expect(primitives).not.toContain(".ui-mt-2-5 {");
    expect(primitives).not.toContain(".ui-mt-3 {");
    expect(primitives).not.toContain("margin-top: var(--space-2-5);");
    expect(primitives).not.toContain("margin-top: var(--space-3);");
  });
});

describe("Disclosure primitive (#5881)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("renders a details/summary pair on the ui- classes, closed by default", () => {
    act(() => {
      root.render(
        <Disclosure summary="Custom criteria">body text</Disclosure>,
      );
    });
    const details = container.querySelector("details.ui-disclosure");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    const summary = container.querySelector("summary.ui-disclosure-summary");
    expect(summary?.textContent).toBe("Custom criteria");
    expect(container.textContent).toContain("body text");
  });

  it("defaultOpen opens it; className passes through", () => {
    act(() => {
      root.render(
        <Disclosure summary="S" defaultOpen className="ui-mt-1">
          body
        </Disclosure>,
      );
    });
    const details = container.querySelector("details.ui-disclosure");
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(details?.classList.contains("ui-mt-1")).toBe(true);
  });

  it("the form's custom-criteria section is a Disclosure, not raw details", () => {
    const src = read(
      "src/client/scheduledOptionsManager/ScheduleFormModal.tsx",
    );
    expect(src).not.toContain("<details");
    expect(src).not.toContain("<summary");
    expect(src).toContain("Disclosure");
    expect(src).toContain("from \"../components/ui\"");
  });
});

describe("form renders on primitives and classes (#5881)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setTenantProvidersStateForTest({
      brokerId: "alpaca",
      dataProviderId: "yahoo",
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    resetTenantProvidersStateForTest();
  });

  function renderModal(jobType: CreatableJob = "marketScreen") {
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
    return document;
  }

  it("the form is a sched-form flex column with no inline style inside it", () => {
    const doc = renderModal();
    const form = doc.querySelector("form.sched-form");
    expect(form).not.toBeNull();
    expect(form?.querySelectorAll("[style]").length).toBe(0);
  });

  it("the criteria Disclosure and its Grid keep the same layout on classes", () => {
    const doc = renderModal();
    const details = doc.querySelector("details.ui-disclosure");
    expect(details).not.toBeNull();
    expect(
      details?.querySelector("summary.ui-disclosure-summary")?.textContent,
    ).toContain("Custom Screening Criteria");
    const grid = details?.querySelector(".ui-grid.cols-2.gap-3.ui-mt-2");
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll(".sched-form-group").length).toBe(4);
    const trend = doc.querySelector(".sched-form-group.ui-mt-2");
    expect(trend).not.toBeNull();
  });

  it("CadenceFields and ThesisRiskFields use the 2-column Grid primitive", () => {
    const noop = () => {};
    act(() => {
      root.render(
        <CadenceFields
          scheduleType="interval"
          setScheduleType={noop}
          intervalSeconds={3600}
          setIntervalSeconds={noop}
          cronExpression=""
          setCronExpression={noop}
          delaySeconds={0}
          setDelaySeconds={noop}
          scheduledDate=""
          setScheduledDate={noop}
          subDailyOptIn={false}
          setSubDailyOptIn={noop}
        />,
      );
    });
    expect(
      container.firstElementChild?.classList.contains("ui-grid"),
    ).toBe(true);
    expect(container.firstElementChild?.classList.contains("cols-2")).toBe(
      true,
    );
    expect(container.firstElementChild?.classList.contains("gap-4")).toBe(true);
    act(() => {
      root.render(
        <ThesisRiskFields
          jobType="optionsAnalysis"
          thesis="neutral"
          setThesis={noop}
          riskProfile="balanced"
          setRiskProfile={noop}
        />,
      );
    });
    expect(
      container.firstElementChild?.classList.contains("ui-grid"),
    ).toBe(true);
    expect(container.firstElementChild?.classList.contains("cols-2")).toBe(
      true,
    );
    expect(container.firstElementChild?.classList.contains("gap-4")).toBe(true);
  });

  it("NotificationFields uses the shared channel-input class and the dimmed card", () => {
    const noop = () => {};
    act(() => {
      root.render(
        <NotificationFields
          jobType="marketScreen"
          pushToSlack
          setPushToSlack={noop}
          slackChannel=""
          setSlackChannel={noop}
          emailTo="trader@firm.com"
          setEmailTo={noop}
          webhookUrl="https://api.firm.com/webhooks/screener"
          setWebhookUrl={noop}
        />,
      );
    });
    const inputs = container.querySelectorAll("input.sched-channel-input");
    expect(inputs.length).toBe(3);
    const cards = container.querySelectorAll(".channel-check-card");
    expect(cards.length).toBe(4);
    expect(
      cards[3]?.classList.contains("channel-check-card--dimmed"),
    ).toBe(true);
    const notSet = [...container.querySelectorAll("span.hint")].find((el) =>
      (el.textContent ?? "").includes("Not set"),
    );
    expect(notSet).not.toBeUndefined();
    expect(notSet?.getAttribute("style")).toBeNull();
    expect(container.querySelectorAll("[style]").length).toBe(0);
  });
});
