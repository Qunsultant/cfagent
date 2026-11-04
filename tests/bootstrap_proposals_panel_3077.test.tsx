/**
 * @vitest-environment jsdom
 * Issue #3077 (#945 Q3) — bootstrap proposals UI: the IAAA Admin
 * Bootstrap proposals section renders the current list, the
 * divergence note, and the proposal form; it states the approval
 * gate (no effect until approved, and approval changes nothing
 * until application is confirmed) and proposes a change to the
 * server. Server enforces; the panel only presents.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BootstrapProposalsPanel } from "../src/client/BootstrapProposalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const posted: Array<{ url: string; body: unknown }> = [];

vi.mock("../src/client/apiFetch", () => ({
  apiFetch: vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") posted.push({ url, body });
    if (url === "/api/iaaa/bootstrap-proposals") {
      return Response.json({ ok: true, proposals: [], skippedCorrupt: 0 });
    }
    if (url === "/api/iaaa/bootstrap-proposals/current") {
      return Response.json({
        ok: true,
        entries: ["platform:11111111-1111-4111-8111-111111111111"],
        resolvedInternalUserIds: ["11111111-1111-4111-8111-111111111111"],
        unresolvedEntries: [],
        divergence: [
          {
            internalUserId: "22222222-2222-4222-8222-222222222222",
            membershipId: "m9",
            roles: ["tenant-admin"],
            grantedVia: "system:bootstrap",
          },
        ],
      });
    }
    if (url === "/api/iaaa/bootstrap-proposals/propose") {
      return Response.json({
        ok: true,
        proposal: {
          proposalId: "prop-1",
          status: "proposed",
          action: body.action,
          identifier: body.identifier,
          reason: body.reason,
          proposer: "admin-1",
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
    root.render(<BootstrapProposalsPanel />);
  });
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

describe("BootstrapProposalsPanel (#3077)", () => {
  it("renders the approval gate note, the current list, and the divergence note", async () => {
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("changes nothing until a different");
    expect(text).toContain("platform admin approves it");
    expect(text).toContain("platform:11111111-1111-4111-8111-111111111111");
    expect(text).toContain("no longer listed");
    expect(text).toContain("22222222-2222-4222-8222-222222222222");
    expect(text).toContain("No bootstrap proposals");
  });

  it("proposes an add change to the server", async () => {
    await renderPanel();
    const inputs = [...container.querySelectorAll("input")];
    const identifierInput = inputs.find(
      (el) => el.getAttribute("aria-label") === "Bootstrap identifier",
    ) as HTMLInputElement | undefined;
    const reasonInput = inputs.find(
      (el) => el.getAttribute("aria-label") === "Proposal reason",
    ) as HTMLInputElement | undefined;
    expect(identifierInput).toBeDefined();
    expect(reasonInput).toBeDefined();
    // React controlled inputs: set through the native setter so the
    // input event registers as a change.
    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(identifierInput!, "33333333-3333-4333-8333-333333333333");
      setValue(reasonInput!, "onboard third admin");
    });
    const proposeButton = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Propose"),
    );
    expect(proposeButton).toBeDefined();
    await act(async () => {
      proposeButton!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const proposeCall = posted.find((p) => p.url.endsWith("/propose"));
    expect(proposeCall).toBeDefined();
    expect((proposeCall!.body as { action: string }).action).toBe("add");
    expect((proposeCall!.body as { identifier: string }).identifier).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect((proposeCall!.body as { reason: string }).reason).toBe("onboard third admin");
  });
});
