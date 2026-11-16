/** @vitest-environment jsdom */
/**
 * Issue #2469 (Agent Mesh S20, programme #2225 G9) — the Agents panel.
 *
 * The panel renders ONLY what GET /api/agents/registry serves, and
 * that payload is the G0 registry (see mesh_agents_view_s20_2469
 * .test.ts for the payload drift pin). These pins use the real
 * built payload as the fetch fixture — no hand-maintained fleet
 * fixture exists anywhere in the view's test path either.
 *
 * Pins:
 *  - the panel fetches the registry route on mount;
 *  - every registered class renders in the fleet table with its
 *    recorded status; the degraded classes show their recorded
 *    reason, not a generic label;
 *  - selecting a fleet row shows that class's census doors and
 *    identity/credential posture in the detail card;
 *  - the workflows / channels / tool families / programme sections
 *    render from the same payload;
 *  - a failed load is stated as an error, never rendered as an
 *    empty fleet.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentsPanel } from "../src/client/AgentsPanel";
import { buildMeshRegistryView } from "../src/services/meshRegistryView";
import { MESH_AGENTS } from "../src/agents/registry";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root | null = null;
let status = 200;
let fetchCalls: string[] = [];

function stubFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown) => {
    fetchCalls.push(String(input));
    if (status !== 200) return Response.json({ error: "boom" }, { status });
    return Response.json(buildMeshRegistryView());
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel() {
  root = createRoot(container);
  await act(async () => {
    root.render(<AgentsPanel />);
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  status = 200;
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("AgentsPanel", () => {
  it("fetches the registry route on mount", async () => {
    await renderPanel();
    expect(fetchCalls).toEqual(["/api/agents/registry"]);
  });

  it("renders every registered class in the fleet table", async () => {
    await renderPanel();
    for (const agent of MESH_AGENTS) {
      expect(container.textContent, agent.className).toContain(agent.className);
    }
  });

  it("shows the degraded classes with their recorded reasons", async () => {
    await renderPanel();
    const sandbox = MESH_AGENTS.find((a) => a.className === "SandboxAgent")!;
    expect(sandbox.status).toBe("degraded");
    expect(container.textContent).toContain("degraded");
    expect(container.textContent).toContain(sandbox.statusReason);
    const aiSearch = MESH_AGENTS.find((a) => a.className === "AiSearchAgent")!;
    expect(container.textContent).toContain(aiSearch.statusReason);
  });

  it("shows the selected class's doors and credential posture in the detail card", async () => {
    await renderPanel();
    const row = [...container.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("SandboxAgent"),
    );
    expect(row, "SandboxAgent fleet row").toBeDefined();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    // The detail card is the Stack holding the selected class's
    // "Recorded status:" line — the fleet table never renders that text.
    const detail = [...container.querySelectorAll(".ui-stack")].find((el) =>
      el.textContent?.includes("Recorded status:"),
    );
    expect(detail, "detail card").not.toBeNull();
    expect(detail!.textContent).toContain("SandboxAgent");
    // Its identity record's per-surface credential env name (S16).
    expect(detail!.textContent).toContain("A2A_TOKEN_SANDBOX");
    // A census verdict for the class is visible in the detail.
    expect(detail!.textContent).toContain("not-exposed");
  });

  it("renders the workflows, channels, tool families, and programme sections", async () => {
    await renderPanel();
    expect(container.textContent).toContain("ScreenerScreenWorkflow");
    expect(container.textContent).toContain("NLQ webhook");
    expect(container.textContent).toContain("agent-skills");
    expect(container.textContent).toContain("proven");
  });

  it("states a failed load as an error, not an empty fleet", async () => {
    status = 500;
    await renderPanel();
    expect(container.textContent).toContain("could not be loaded");
    expect(container.textContent).not.toContain("OrchestratorAgent");
  });
});
