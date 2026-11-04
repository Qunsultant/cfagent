/** @vitest-environment jsdom */
/**
 * Issue #2836 — LoggedInUsersPanel (IAAA Admin → Overview,
 * beside Service tokens / Role grants / Policy proposals):
 * per-user list with identity, tenant, recorded login count,
 * first/most-recent/recent login times, and per-user sessions
 * with created/last-seen/expiry/provider plus revoke-with-
 * confirm per session. Server decides every refusal; the panel
 * surfaces it, never hides enforcement.
 *
 * Harness mirrors tests/role_grants_panel_2688.test.tsx: the
 * real api client module is mocked, the panel renders with
 * react-dom/client in jsdom.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoggedInUsersPanel } from "../src/client/LoggedInUsersPanel";
import {
  fetchLoggedInUsers,
  revokeLoggedInSession,
} from "../src/client/loggedInUsersApi";

vi.mock("../src/client/loggedInUsersApi", () => ({
  fetchLoggedInUsers: vi.fn(),
  revokeLoggedInSession: vi.fn(),
  fmtLoggedInTime: (ms: number | null) => (ms === null ? "—" : `t${ms}`),
}));

const mockedFetch = vi.mocked(fetchLoggedInUsers);
const mockedRevoke = vi.mocked(revokeLoggedInSession);

let container: HTMLDivElement;
let root: Root;

const RESPONSE = {
  ok: true,
  scope: "platform",
  users: [
    {
      internalUserId: "v1:alice000000000000000000000000000000000000000001",
      displayLogin: "alice",
      identity: "https://github.com:12345",
      tenantIds: ["primary"],
      loginCount: 4,
      firstLoginMs: 1000,
      mostRecentLoginMs: 4000,
      recentLoginMs: [4000, 3000, 2000, 1000],
      firstSeenMs: 500,
      sessions: [
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          displayLogin: "alice",
          displayName: "Alice A",
          identity: "https://github.com:12345",
          provider: "GitHub",
          providerId: "github",
          providerIssuer: "https://github.com",
          createdMs: 1_799_999_999_000,
          firstCreatedMs: 1_799_999_999_000,
          lastSeenMs: 1_799_999_999_500,
          expiresMs: 1_800_028_799_500,
        },
      ],
    },
    {
      internalUserId: null,
      displayLogin: "legacy-user",
      identity: null,
      tenantIds: [],
      loginCount: null,
      firstLoginMs: null,
      mostRecentLoginMs: null,
      recentLoginMs: [],
      firstSeenMs: null,
      sessions: [
        {
          sessionId: "33333333-3333-4333-8333-333333333333",
          displayLogin: "legacy-user",
          displayName: "Legacy",
          identity: null,
          provider: null,
          providerId: null,
          providerIssuer: null,
          createdMs: 1_799_999_997_000,
          firstCreatedMs: 1_799_999_997_000,
          lastSeenMs: 1_799_999_997_000,
          expiresMs: 1_800_604_797_000,
        },
      ],
    },
  ],
  coverage: {
    loginCountBasis: "retained-auth-login-events",
    loginCountNote: "Counts cover retained events only.",
    lastSeenNote: "Last seen lags true activity by up to 300s.",
    firstSeenNote: "First seen is the first wired-login observation.",
  },
};

function bodyText(): string {
  return document.body.textContent ?? "";
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<LoggedInUsersPanel />);
  });
}

async function click(label: string) {
  const buttons = Array.from(container.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) throw new Error(`button not found: ${label}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(RESPONSE as never);
  mockedRevoke.mockResolvedValue({
    ok: true,
    revokedSessionId: "11111111-1111-4111-8111-111111111111",
    audited: true,
    revokeBoundMs: 60000,
    revokeBoundNote: "Wired sessions deny immediately on fresh reads.",
  } as never);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("LoggedInUsersPanel", () => {
  it("lists users with identity, tenant, recorded count, times, and sessions", async () => {
    await renderPanel();
    const text = bodyText();
    expect(text).toContain("https://github.com:12345");
    expect(text).toContain("primary");
    expect(text).toContain("4");
    expect(text).toContain("t1000");
    expect(text).toContain("t4000");
    expect(text).toContain("GitHub");
    expect(text).toContain("t1799999999500");
    expect(text).toContain("t1800028799500");
    expect(text).toContain("legacy-user");
    expect(text).toContain("Counts cover retained events only.");
  });

  it("revokes a session only after confirm, then reloads with a notice", async () => {
    await renderPanel();
    await click("Revoke");
    expect(bodyText()).toContain("Confirm revoke");
    await click("Confirm revoke");
    expect(mockedRevoke).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(bodyText()).toContain("revoked");
  });

  it("surfaces a fetch failure instead of an empty list", async () => {
    mockedFetch.mockRejectedValue(new Error("Forbidden: listing logged-in users requires admin access."));
    await renderPanel();
    expect(bodyText()).toContain("Forbidden: listing logged-in users requires admin access.");
  });
});
