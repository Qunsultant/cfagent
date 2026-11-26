/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
  decideGoalScheduleApproval,
  decideScheduleApproval,
  listPendingGoalScheduleApprovals,
  listPendingScheduleApprovals,
} = vi.hoisted(() => ({
  decideGoalScheduleApproval: vi.fn().mockResolvedValue(undefined),
  decideScheduleApproval: vi.fn().mockResolvedValue(undefined),
  listPendingGoalScheduleApprovals: vi.fn(),
  listPendingScheduleApprovals: vi.fn(),
}));

vi.mock("../src/client/jobsApi", () => ({
  decideGoalScheduleApproval,
  decideScheduleApproval,
  listPendingGoalScheduleApprovals,
  listPendingScheduleApprovals,
}));

vi.mock("../src/client/brokerEnvironment", () => ({
  useBrokerEnvironment: () => "paper",
}));

vi.mock("../src/client/SchedulesPanel", () => ({
  SchedulesPanel: () => <div data-testid="schedules-panel" />,
}));

vi.mock("../src/client/ScheduledGoalsPanel", () => ({
  ScheduledGoalsPanel: () => <div data-testid="goals-panel" />,
}));

vi.mock("../src/client/ScheduleRunLedgerPanel", () => ({
  ScheduleRunLedgerPanel: () => <div data-testid="run-ledger-panel" />,
}));

import { SchedulerCopilotSurface } from "../src/client/chat/SchedulerCopilotSurface";

const scheduleApproval = {
  id: "approval-sdk-1",
  kind: "sdk" as const,
  requestedBy: "requester",
  agentId: "research-agent",
  requestedAt: "2026-01-02T03:04:05.000Z",
  definition: { callback: "autonomousOptionsAnalysis", cron: "0 9 * * *" },
  approvalReasons: ["This schedule exceeds the configured frequency threshold."],
  status: "pending" as const,
};

const goalApproval = {
  ...scheduleApproval,
  id: "approval-goal-1",
  kind: "goal" as const,
  definition: { goalId: "daily-screen", cron: "0 8 * * *" },
  approvalReasons: ["This goal requires approval before it can be armed."],
};

describe("Scheduler Copilot surface (#3122)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listPendingGoalScheduleApprovals.mockResolvedValue([goalApproval]);
    listPendingScheduleApprovals.mockResolvedValue([scheduleApproval]);
    decideGoalScheduleApproval.mockClear();
    decideScheduleApproval.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function openApprovals() {
    await act(async () => {
      root.render(<SchedulerCopilotSurface userLogin="test-user" />);
    });
    const approvalsTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"))
      .find((button) => button.textContent?.includes("Approvals"));
    expect(approvalsTab).toBeDefined();
    await act(async () => {
      approvalsTab!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows schedule and goal approvals with their reasons and definitions", async () => {
    await openApprovals();

    expect(container.textContent).toContain("research-agent");
    expect(container.textContent).toContain("exceeds the configured frequency threshold");
    expect(container.textContent).toContain("daily-screen");
    expect(container.querySelectorAll("details").length).toBe(2);
  });

  it("routes approval decisions through the matching protected endpoint", async () => {
    await openApprovals();

    const approveButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Approve");
    expect(approveButton).toBeDefined();
    await act(async () => {
      approveButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(decideScheduleApproval).toHaveBeenCalledWith(
      "approval-sdk-1",
      "approve",
      "test-user",
    );

    const goalCard = Array.from(container.querySelectorAll<HTMLElement>(".ui-card"))
      .filter((card) => card.textContent?.includes("daily-screen"))
      .pop();
    const rejectButton = Array.from(goalCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.trim() === "Reject");
    expect(rejectButton).toBeDefined();
    await act(async () => {
      rejectButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(decideGoalScheduleApproval).toHaveBeenCalledWith("approval-goal-1", "reject");
  });
});
