/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServiceUserSection } from "../src/client/ServiceUserSection";
import {
  completeServiceEtradeAuth,
  fetchServiceUserStatus,
  provisionPlatformTier,
  revokeServiceEtradeToken,
  startServiceEtradeAuth,
} from "../src/client/serviceUserApi";

vi.mock("../src/client/serviceUserApi", () => ({
  fetchServiceUserStatus: vi.fn(),
  provisionPlatformTier: vi.fn(),
  startServiceEtradeAuth: vi.fn(),
  completeServiceEtradeAuth: vi.fn(),
  revokeServiceEtradeToken: vi.fn(),
  ServiceUserApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockedFetch = vi.mocked(fetchServiceUserStatus);
const mockedProvision = vi.mocked(provisionPlatformTier);
const mockedStart = vi.mocked(startServiceEtradeAuth);
const mockedComplete = vi.mocked(completeServiceEtradeAuth);
const mockedRevoke = vi.mocked(revokeServiceEtradeToken);

let container: HTMLDivElement;
let root: Root;

const STATUS_PROVISIONED = {
  serviceUser: "svc-background",
  serviceInternalUserId: "service:svc-background",
  platform: { membershipId: "m-1", roles: ["member"] },
  tenants: ["primary"],
};

const STATUS_UNPROVISIONED = {
  ...STATUS_PROVISIONED,
  platform: null,
  tenants: [],
};

const PROVISIONING_TOKEN_MISSING = {
  complete: false,
  checklist: [
    {
      id: "service_login_configured",
      label: "SERVICE_USER_LOGIN is configured",
      status: "pass",
      detail: "Configured login: svc-background.",
    },
    {
      id: "platform_membership_live",
      label: "Platform-tier member binding is live",
      status: "pass",
      detail: "A live, unrevoked, unexpired platform-scope member binding exists.",
    },
    {
      id: "brokerage_token_present",
      label: "Brokerage token is stored for the service identity",
      status: "fail",
      detail: "No stored token for the service identity.",
    },
  ],
  ownerActions: [
    'Authorize svc-background once via the "Authorize service login with E*TRADE" action in the Service User section, so a stored token exists under its login.',
  ],
};

const PROVISIONING_TOKEN_PRESENT = {
  ...PROVISIONING_TOKEN_MISSING,
  complete: true,
  checklist: PROVISIONING_TOKEN_MISSING.checklist.map((item) =>
    item.id === "brokerage_token_present"
      ? { ...item, status: "pass", detail: "A stored token exists for the service identity (presence only; value never exposed)." }
      : item,
  ),
  ownerActions: [],
};

function bodyText(): string {
  return document.body.textContent ?? "";
}

function clickButton(label: string) {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) {
    throw new Error(
      `No button labelled "${label}" (found: ${buttons.map((b) => b.textContent).join(" | ")})`,
    );
  }
  return target;
}

async function renderSection() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ServiceUserSection />);
  });
}

async function click(label: string) {
  await act(async () => {
    (clickButton(label) as HTMLElement).click();
  });
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
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
  vi.unstubAllGlobals();
});

describe("ServiceUserSection", () => {
  it("shows provisioned platform state with the service user and tenant tiers", async () => {
    mockedFetch.mockResolvedValue(STATUS_PROVISIONED);
    await renderSection();
    expect(bodyText()).toContain("svc-background");
    expect(bodyText()).toContain("Provisioned (member)");
    expect(bodyText()).toContain("primary");
  });

  it("shows not-provisioned state with a Provision button", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    await renderSection();
    expect(bodyText()).toContain("Not provisioned");
    expect(bodyText()).toContain("None");
    expect(() => clickButton("Provision platform tier")).not.toThrow();
  });

  it("reports success and re-reads status after a provision", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    mockedProvision.mockResolvedValue({ kind: "provisioned", membershipId: "m-9" });
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("Platform tier provisioned.");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("reports already-provisioned as information, not an error", async () => {
    mockedFetch.mockResolvedValue(STATUS_PROVISIONED);
    mockedProvision.mockResolvedValue({ kind: "alreadyProvisioned", membershipId: "m-1" });
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("Platform tier was already provisioned.");
    expect(bodyText()).not.toContain("Failed to provision");
  });

  it("renders queued-not-done on 202, never success, and does not claim proof", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    mockedProvision.mockResolvedValue({ kind: "queued", jobId: "job-1" });
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("queued as a background job, not completed");
    expect(bodyText()).toContain("only a status read showing the platform tier provisioned counts as done");
    expect(bodyText()).not.toContain("Platform tier provisioned.");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("renders a denied state with no Provision button on status 403", async () => {
    mockedFetch.mockRejectedValue(statusError(403, "Forbidden"));
    await renderSection();
    expect(bodyText()).toContain("not a platform admin");
    expect(document.body.querySelectorAll("button").length).toBe(1);
    expect(bodyText()).toContain("Refresh status");
  });

  it("renders a sign-in state on status 401", async () => {
    mockedFetch.mockRejectedValue(statusError(401, "Unauthorized"));
    await renderSection();
    expect(bodyText()).toContain("Not signed in");
  });

  it("renders the platform-admin denial on provision 403", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    mockedProvision.mockRejectedValue(statusError(403, "Forbidden"));
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("not a platform admin");
  });

  it("renders the brokerage-token checklist item and the authorize action when provisioning is present (#4988)", async () => {
    mockedFetch.mockResolvedValue({
      ...STATUS_PROVISIONED,
      provisioning: PROVISIONING_TOKEN_MISSING,
    });
    await renderSection();
    expect(bodyText()).toContain("Brokerage token is stored for the service identity");
    expect(bodyText()).toContain("Fail");
    expect(() => clickButton("Authorize service login with E*TRADE")).not.toThrow();
    // No revoke button while no token is present.
    expect(bodyText()).not.toContain("Revoke service login token");
  });

  it("runs the authorize flow: start, PIN entry, completion, status re-read (#4988)", async () => {
    mockedFetch
      .mockResolvedValueOnce({ ...STATUS_PROVISIONED, provisioning: PROVISIONING_TOKEN_MISSING })
      .mockResolvedValueOnce({ ...STATUS_PROVISIONED, provisioning: PROVISIONING_TOKEN_PRESENT });
    mockedStart.mockResolvedValue({
      authorizeUrl: "https://us.etrade.com/e/t/etws/authorize?key=k&token=REQTOKEN",
      serviceUser: "svc-background",
    });
    mockedComplete.mockResolvedValue(undefined);
    await renderSection();
    await click("Authorize service login with E*TRADE");
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(bodyText()).toContain("Verifier PIN from E*TRADE");
    expect(bodyText()).toContain("Authorize svc-background at E*TRADE");
    const input = document.body.querySelector("input");
    if (!input) throw new Error("No PIN input rendered");
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(input, "123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Complete authorization");
    expect(mockedComplete).toHaveBeenCalledWith("123456");
    expect(bodyText()).toContain("Service login authorized with E*TRADE.");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("shows the step-up notice, not a silent failure, when authorize is refused for a stale session (#4988)", async () => {
    mockedFetch.mockResolvedValue({
      ...STATUS_PROVISIONED,
      provisioning: PROVISIONING_TOKEN_MISSING,
    });
    mockedStart.mockRejectedValue(
      statusError(403, "Step-up authentication required: please sign in again and retry."),
    );
    await renderSection();
    await click("Authorize service login with E*TRADE");
    expect(bodyText()).toContain("Step-up authentication required");
    expect(bodyText()).not.toContain("Verifier PIN from E*TRADE");
  });

  it("renders the revoke action only when the token is present, and reloads status after revoke (#4988)", async () => {
    mockedFetch
      .mockResolvedValueOnce({ ...STATUS_PROVISIONED, provisioning: PROVISIONING_TOKEN_PRESENT })
      .mockResolvedValueOnce({ ...STATUS_PROVISIONED, provisioning: PROVISIONING_TOKEN_MISSING });
    mockedRevoke.mockResolvedValue(true);
    await renderSection();
    expect(bodyText()).toContain("Brokerage token is stored for the service identity");
    expect(bodyText()).toContain("Pass");
    await click("Revoke service login token");
    expect(mockedRevoke).toHaveBeenCalledTimes(1);
    expect(bodyText()).toContain("Service login token revoked.");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
