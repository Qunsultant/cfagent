/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DelegationContractPreview } from "../src/client/DelegationContractPreview";

import {
  buildDelegationContract,
  type DelegationContractInput,
} from "../src/client/delegationContract";

/**
 * HAX #1 scope disclosure (Qunsultant/cfagent#1773, item 4):
 * the goal-creation form must show a Delegation Contract preview
 * before execution — what will be done, what will not be done,
 * which systems will be accessed, which actions require approval,
 * budget and duration limits, and expected outputs
 * (docs/agents/ux-architecture.md §7). The builder is pure so the
 * contract text is pinned independently of the panel render: the
 * preview may never invent a system, a budget, or an authority the
 * form did not state.
 */

const FULL: DelegationContractInput = {
  goalId: "weekly-report",
  goalName: "Weekly report",
  cron: "0 6 * * *",
  operation: "report.weekly",
  operationAgent: "ReportingAgent",
  operationBlurb: "Builds the weekly report from stored runs.",
  budgetCents: 500,
  timeZone: "UTC",
};

describe("buildDelegationContract (#1773, HAX scope disclosure)", () => {
  it("names the operation, schedule, timezone, and goal in what-will-be-done", () => {
    const contract = buildDelegationContract(FULL);
    expect(contract.willDo.join(" ")).toContain("report.weekly");
    expect(contract.willDo.join(" ")).toContain("0 6 * * *");
    expect(contract.willDo.join(" ")).toContain("UTC");
    expect(contract.willDo.join(" ")).toContain("Weekly report");
    expect(contract.willDo.join(" ")).toContain("weekly-report");
  });

  it("carries the catalog blurb when the operation entry is loaded", () => {
    const contract = buildDelegationContract(FULL);
    expect(contract.willDo.join(" ")).toContain("Builds the weekly report from stored runs.");
  });

  it("never invents a system: an unloaded catalog entry says so", () => {
    const contract = buildDelegationContract({ ...FULL, operationAgent: undefined, operationBlurb: undefined });
    expect(contract.systemsAccessed.join(" ")).toContain("report.weekly");
    expect(contract.systemsAccessed.join(" ")).not.toContain("ReportingAgent");
    expect(contract.systemsAccessed.join(" ")).toMatch(/not loaded/i);
  });

  it("names the implementing agent as the system accessed when known", () => {
    const contract = buildDelegationContract(FULL);
    expect(contract.systemsAccessed.join(" ")).toContain("ReportingAgent");
  });

  it("states what will not be done: no other operation, no other goal, no off-schedule run", () => {
    const contract = buildDelegationContract(FULL);
    const text = contract.willNotDo.join(" ");
    expect(text).toContain("report.weekly");
    expect(text).toMatch(/other goal/i);
    expect(text).toMatch(/outside.*cron|off-schedule/i);
  });

  it("reserves live trade, payment, and publish authority to their own approvals", () => {
    const contract = buildDelegationContract(FULL);
    const text = contract.approvalsRequired.join(" ");
    expect(text).toMatch(/live trade/i);
    expect(text).toMatch(/payment/i);
    expect(text).toMatch(/publish/i);
    expect(text).toMatch(/own approval/i);
  });

  it("formats the budget from budgetCents and states the no-end-date duration", () => {
    const contract = buildDelegationContract(FULL);
    expect(contract.budgetAndDuration.join(" ")).toContain("$5.00");
    expect(contract.budgetAndDuration.join(" ")).toMatch(/no end date/i);
  });

  it("marks unentered fields as not entered instead of inventing values", () => {
    const contract = buildDelegationContract({
      goalId: "",
      goalName: "",
      cron: "",
      operation: "",
      budgetCents: null,
      timeZone: "",
    });
    const text = [
      ...contract.willDo,
      ...contract.systemsAccessed,
      ...contract.budgetAndDuration,
      ...contract.expectedOutputs,
    ].join(" ");
    expect(text).toMatch(/not entered yet/i);
    expect(text).not.toContain("$NaN");
    expect(text).not.toContain("undefined");
  });

  it("states tick outputs are visible in the panel's tick history", () => {
    const contract = buildDelegationContract(FULL);
    expect(contract.expectedOutputs.join(" ")).toMatch(/tick/i);
  });

  it("renders the preview with all six section headings", () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(<DelegationContractPreview contract={buildDelegationContract(FULL)} />);
    });
    try {
      const section = document.querySelector('[aria-label="Delegation contract preview"]');
      expect(section, "preview section must render").not.toBeNull();
      const text = section!.textContent ?? "";
      for (const heading of [
        "What will be done",
        "What will not be done",
        "Which systems will be accessed",
        "Which actions require approval",
        "Budget and duration limits",
        "Expected outputs",
      ]) {
        expect(text).toContain(heading);
      }
      expect(text).toContain("report.weekly");
      expect(text).toContain("$5.00");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = "";
    }
  });

  it("renders every §7 section non-empty", () => {
    const contract = buildDelegationContract(FULL);
    for (const section of [
      contract.willDo,
      contract.willNotDo,
      contract.systemsAccessed,
      contract.approvalsRequired,
      contract.budgetAndDuration,
      contract.expectedOutputs,
    ]) {
      expect(section.length).toBeGreaterThan(0);
      for (const line of section) expect(line.trim().length).toBeGreaterThan(0);
    }
  });
});
