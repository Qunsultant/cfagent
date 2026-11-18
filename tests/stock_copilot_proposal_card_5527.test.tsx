/** @vitest-environment jsdom */

/**
 * Issue #5527 — a proposal card can be filed from the panel, with an explicit
 * approval step.
 *
 * The MCP dispatch (#5057) is not callable from the browser, so the panel
 * reads the proposals through the introspection route and files through
 * `POST /api/stock-copilot/proposals/file`. The confirmation step is the
 * point: a single unconfirmed click would turn HITL into a rubber stamp.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  proposals: [
    {
      gapId: "GAP_STATIC_UNIVERSE_BOTTLENECK",
      title: "Dynamic Momentum Universe Expansion",
      diagnosis: "The watch universe is static.",
      readiness: "suggestion",
      governedPathway: {
        targetIssueTitle: "[Stock Copilot] Dynamic Universe",
        lane: "lane:clo-arsi",
        actionablePlan: "Draft and publish an issue.",
      },
    },
  ],
  fileCalls: [] as string[],
  fileResult: { gapId: "GAP_STATIC_UNIVERSE_BOTTLENECK", number: 6001, url: "https://github.com/o/r/issues/6001" },
  fileError: null as string | null,
}));

vi.mock("../src/client/stockCopilotApi", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    fetchStockCopilotStatus: vi.fn(async () => ({
      flagEnabled: true,
      paused: false,
      marketOpen: true,
      currentSession: "regular",
      enabledSessions: ["regular"],
      status: "live",
      selectionResolved: true,
      activeBroker: "alpaca",
      activeMode: "paper",
      userLogin: "owner",
      controlUpdatedAt: null,
      openPositions: [],
      closedPositions: [],
      activity: [],
    })),
    setStockCopilotPaused: vi.fn(async () => ({ ok: true, paused: false })),
    setStockCopilotSessions: vi.fn(async () => ({ ok: true, sessions: [] })),
    fetchStockCopilotProposals: vi.fn(async () => api.proposals),
    fileStockCopilotProposal: vi.fn(async (gapId: string) => {
      api.fileCalls.push(gapId);
      if (api.fileError) throw new Error(api.fileError);
      return api.fileResult;
    }),
  };
});

import { StockCopilotPanel } from "../src/client/StockCopilotPanel";
import { ToastProvider } from "../src/client/components/ui";

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

let mounted: Root | null = null;

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <StockCopilotPanel />
      </ToastProvider>,
    );
  });
  await flush();
  mounted = root;
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  const el = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!el) throw new Error(`button "${text}" not found`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  api.fileCalls = [];
  api.fileError = null;
  vi.clearAllMocks();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.unmount());
    mounted = null;
  }
  document.body.innerHTML = "";
});

describe("Issue #5527 — file a proposal from the panel", () => {
  it("loads proposals on request, not on mount", async () => {
    const container = await render();
    expect(container.textContent).toContain("Governed proposals");
    expect(container.textContent).not.toContain("Dynamic Momentum Universe Expansion");

    await act(async () => {
      buttonByText(container, "Review proposals").click();
    });
    await flush();

    expect(container.textContent).toContain("Dynamic Momentum Universe Expansion");
  });

  it("requires a confirmation before filing", async () => {
    const container = await render();
    await act(async () => {
      buttonByText(container, "Review proposals").click();
    });
    await flush();

    await act(async () => {
      buttonByText(container, "File this proposal").click();
    });
    await flush();

    expect(container.textContent).toContain("File as a GitHub issue?");
    expect(api.fileCalls).toHaveLength(0);

    await act(async () => {
      buttonByText(container, "Cancel").click();
    });
    await flush();

    expect(api.fileCalls).toHaveLength(0);
    expect(container.textContent).toContain("File this proposal");
  });

  it("files on confirm and shows the issue link", async () => {
    const container = await render();
    await act(async () => {
      buttonByText(container, "Review proposals").click();
    });
    await flush();

    await act(async () => {
      buttonByText(container, "File this proposal").click();
    });
    await flush();
    await act(async () => {
      buttonByText(container, "Confirm").click();
    });
    await flush();

    expect(api.fileCalls).toEqual(["GAP_STATIC_UNIVERSE_BOTTLENECK"]);
    expect(container.textContent).toContain("Filed #6001");
    expect(container.textContent).toContain("Open issue");
  });

  it("shows the server's refusal text when filing fails", async () => {
    api.fileError = "no GitHub issue token is configured (GITHUB_ISSUE_TOKEN)";
    const container = await render();
    await act(async () => {
      buttonByText(container, "Review proposals").click();
    });
    await flush();
    await act(async () => {
      buttonByText(container, "File this proposal").click();
    });
    await flush();
    await act(async () => {
      buttonByText(container, "Confirm").click();
    });
    await flush();

    expect(container.textContent).toContain("GITHUB_ISSUE_TOKEN");
    expect(container.textContent).not.toContain("Filed #");
  });
});
