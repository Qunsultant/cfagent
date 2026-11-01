/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServiceTokensPanel } from "../src/client/ServiceTokensPanel";
import {
  fetchServiceTokens,
  mintServiceToken,
  rotateServiceToken,
  revokeServiceToken,
} from "../src/client/serviceTokensApi";

vi.mock("../src/client/serviceTokensApi", () => ({
  fetchServiceTokens: vi.fn(),
  mintServiceToken: vi.fn(),
  rotateServiceToken: vi.fn(),
  revokeServiceToken: vi.fn(),
  fmtServiceTokenTime: (ms: number | null) => (ms === null ? "Never" : `t${ms}`),
}));

const mockedFetch = vi.mocked(fetchServiceTokens);
const mockedMint = vi.mocked(mintServiceToken);
const mockedRotate = vi.mocked(rotateServiceToken);
const mockedRevoke = vi.mocked(revokeServiceToken);

let container: HTMLDivElement;
let root: Root;

const TOKEN = {
  id: "svctok_abc123",
  label: "automation",
  prefix: "svc_Ab3dEf7h",
  serviceLogin: "svc-background",
  serviceInternalUserId: "service:svc-background",
  tier: "platform",
  tenantId: null,
  roles: ["member"],
  expiresAtMs: 1_900_000_000_000,
  revokedAtMs: null,
  createdBy: "admin-id-1",
  createdAtMs: 1_800_000_000_000,
  lastUsedAtMs: null,
};

function bodyText(): string {
  return document.body.textContent ?? "";
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ServiceTokensPanel />);
  });
}

async function click(label: string) {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) {
    throw new Error(
      `No button labelled "${label}" (found: ${buttons.map((b) => b.textContent).join(" | ")})`,
    );
  }
  await act(async () => {
    (target as HTMLElement).click();
  });
}

function setInput(id: string, value: string) {
  const el = document.body.querySelector(`#${id}`) as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  if (!el) throw new Error(`No input #${id}`);
  // React controlled inputs ignore plain .value assignment in jsdom;
  // drive the native setter so React's onChange fires.
  const proto =
    el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("issue #2681: ServiceTokensPanel", () => {
  it("lists tokens and mints a new one, showing the secret exactly once", async () => {
    mockedFetch.mockResolvedValue([]);
    await renderPanel();
    expect(bodyText()).toContain("No service tokens yet");

    mockedFetch.mockResolvedValue([TOKEN]);
    mockedMint.mockResolvedValue({
      token: TOKEN,
      secret: "svc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS",
    });
    setInput("stp-label", "automation");
    await click("Create token");
    expect(mockedMint).toHaveBeenCalledWith(
      expect.objectContaining({ label: "automation", tier: "platform", roles: ["member"] }),
    );
    expect(bodyText()).toContain("svc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS");
    expect(bodyText()).toContain("You won't see this token again");
  });

  it("requires a tenant id for tenant tokens before calling the API", async () => {
    mockedFetch.mockResolvedValue([]);
    await renderPanel();
    setInput("stp-tier", "tenant");
    setInput("stp-label", "t");
    await click("Create token");
    expect(mockedMint).not.toHaveBeenCalled();
    expect(bodyText()).toContain("Tenant id is required");
  });

  it("rotates and revokes through the real API functions", async () => {
    mockedFetch.mockResolvedValue([TOKEN]);
    mockedRotate.mockResolvedValue({
      token: TOKEN,
      secret: "svc_ROTATEDabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
    });
    await renderPanel();
    await click("Rotate");
    expect(mockedRotate).toHaveBeenCalledWith("svctok_abc123", expect.any(Number));
    expect(bodyText()).toContain("svc_ROTATEDabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN");

    mockedRevoke.mockResolvedValue(undefined);
    mockedFetch.mockResolvedValue([{ ...TOKEN, revokedAtMs: 1_800_000_000_001 }]);
    await click("Revoke");
    await click("Confirm revoke");
    expect(mockedRevoke).toHaveBeenCalledWith("svctok_abc123");
  });
});
