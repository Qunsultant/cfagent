/**
 * @vitest-environment jsdom
 * Issue #2838 — PAP editor UI: the IAAA Admin Policy proposals
 * section renders the server's active snapshot as grant toggles,
 * states the approval gate (no effect until approved + promoted),
 * and proposes the edited snapshot. Server enforces; the panel
 * only presents.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PolicyProposalsPanel } from "../src/client/PolicyProposalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVE = {
  version: "iaaa-authorization-1",
  permissions: ["task:read", "task:cancel"],
  roleGrants: {
    "platform-admin": ["audit:read"],
    member: ["task:read", "task:cancel"],
  },
};

const posted: Array<{ url: string; body: unknown }> = [];

vi.mock("../src/client/apiFetch", () => ({
  apiFetch: vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") posted.push({ url, body });
    if (url === "/api/iaaa/policy-proposals") {
      return Response.json({ ok: true, proposals: [], skippedCorrupt: 0 });
    }
    if (url === "/api/iaaa/policy-proposals/active") {
      return Response.json({ ok: true, active: ACTIVE, source: "compiled" });
    }
    if (url === "/api/iaaa/policy-proposals/propose") {
      return Response.json({
        ok: true,
        proposal: {
          proposalId: "prop-1",
          status: "proposed",
          proposer: "admin-1",
          proposedSnapshot: body.snapshot,
          beforeRef: "iaaa-authorization-1:aaaa",
          afterRef: "iaaa-authorization-1:bbbb",
          tenantScope: "platform",
          correlationId: "corr-1",
          createdAtMs: 1000,
        },
      });
    }
    return new Response("not found", { status: 404 });
  }),
}));

let container: HTMLDivElement;
let root: Root;

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PolicyProposalsPanel />);
  });
  // Let the load() promise chain settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  posted.length = 0;
});

describe("PolicyProposalsPanel (#2838)", () => {
  it("renders the approval gate note and the server's grants as toggles", async () => {
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("no effect until a");
    expect(text).toContain("different platform admin approves");
    expect(text).toContain("member");
    expect(text).toContain("task:cancel");
    expect(text).toContain("No policy proposals");
  });

  it("proposes the edited snapshot (unchecking a grant) to the server", async () => {
    await renderPanel();
    const checkboxes = [...container.querySelectorAll("input[type=checkbox]")];
    // The member's task:cancel box is the CHECKED one (platform-admin's
    // is unchecked); find by checked state, not label alone.
    const cancelBox = checkboxes.find((box) => {
      const label = box.closest("label")?.textContent ?? "";
      return label.includes("task:cancel") && (box as HTMLInputElement).checked;
    });
    expect(cancelBox).toBeDefined();
    await act(async () => {
      cancelBox!.click();
    });
    const proposeButton = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Propose change"),
    );
    expect(proposeButton).toBeDefined();
    await act(async () => {
      proposeButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const proposeCall = posted.find((p) => p.url.endsWith("/propose"));
    expect(proposeCall).toBeDefined();
    const snapshot = (proposeCall!.body as { snapshot: typeof ACTIVE }).snapshot;
    expect(snapshot.roleGrants.member).not.toContain("task:cancel");
    expect(snapshot.roleGrants.member).toContain("task:read");
  });
});
