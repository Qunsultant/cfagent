// @vitest-environment jsdom
/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — approved-free
 * quota API + section tests.
 *
 * TDD RED first: the routes exist; this suite pins the client
 * contract — typed parsing, operator detection via GET /operators,
 * the read-only view for non-operators, the operator editor with
 * lookup, and the fresh-read-after-save rule (the POST answer is
 * never rendered as state).
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getApprovedFreeQuota,
  setApprovedFreeQuotaCap,
  setApprovedFreeQuotaSettings,
  isStoreOperator,
  ApprovedFreeQuotaApiError,
  type ApprovedFreeQuotaState,
} from "../src/client/approvedFreeQuotaApi";
import { ApprovedFreeQuotaSection } from "../src/client/ApprovedFreeQuotaSection";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
import { isGrantExpired } from "../src/client/approvedFreeQuotaApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/payments/agentic/commercial";
const MARKER = "typed server detail marker";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: MARKER }) };
}

function makeQuota(overrides: Partial<ApprovedFreeQuotaState> = {}): ApprovedFreeQuotaState {
  return {
    userId: "u1",
    tenantId: "t1",
    settings: {
      windowKind: "month",
      atLimitAction: "upgrade_or_buy_credits",
      updatedAtMs: 1_800_000_000_000,
      updatedBy: "op1",
    },
    period: "2026-11",
    families: [
      { family: "stock", cap: 10, used: 3, remaining: 7, period: "2026-11" },
      { family: "goal", cap: 10, used: 0, remaining: 10, period: "2026-11" },
      { family: "options", cap: 10, used: 10, remaining: 0, period: "2026-11" },
      { family: "strategy", cap: null, used: 0, remaining: null, period: "2026-11" },
    ],
    grant: { active: true, expiresAtMs: null },
    ...overrides,
  };
}

interface MockState {
  quota: ApprovedFreeQuotaState;
  quotaStatus: number | null;
  operatorsStatus: number;
  posts: unknown[];
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    quota: makeQuota(),
    quotaStatus: null,
    operatorsStatus: 200,
    posts: [],
    ...overrides,
  };
}

function quotaFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith(`${BASE}/approved-free-quota`) && method === "GET") {
      if (state.quotaStatus) return err(state.quotaStatus);
      const query = url.includes("?") ? new URL(url, "https://x") : null;
      const userId = query?.searchParams.get("userId");
      if (userId === "u2") return err(403);
      return ok({ ...state.quota, userId: userId ?? state.quota.userId });
    }
    if (url === `${BASE}/operators` && method === "GET") {
      if (state.operatorsStatus !== 200) return err(state.operatorsStatus);
      return ok({ operators: [{ login: "op1", source: "env", addedBy: null, addedAtMs: null }] });
    }
    if (url === `${BASE}/approved-free-quota` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.posts.push(body);
      // AOP: the server answers with the catalog-coded success.
      const code = "SUCCESS_APPROVED_FREE_QUOTA_UPDATED";
      const message = resolveOutcome(code).businessMessage;
      if (typeof body.family === "string" && typeof body.capRuns === "number") {
        const row = state.quota.families.find((entry) => entry.family === body.family);
        if (row) {
          row.cap = body.capRuns;
          row.remaining = Math.max(0, body.capRuns - row.used);
        }
        return ok({ family: body.family, capRuns: body.capRuns, code, message });
      }
      if (body.windowKind === "month" || body.windowKind === "week") {
        if (state.quota.settings) state.quota.settings.windowKind = body.windowKind;
        return ok({ settings: { ...state.quota.settings }, code, message });
      }
      if (body.atLimitAction === "upgrade_or_buy_credits" || body.atLimitAction === "stop") {
        if (state.quota.settings) state.quota.settings.atLimitAction = body.atLimitAction;
        return ok({ settings: { ...state.quota.settings }, code, message });
      }
      return err(400);
    }
    return err(404);
  };
}

describe("approved-free quota api", () => {
  it("GET parses the full state; a userId reads that account", async () => {
    const state = freshState();
    (globalThis as any).fetch = vi.fn(quotaFetch(state));
    const own = await getApprovedFreeQuota();
    expect(own.userId).toBe("u1");
    expect(own.settings?.windowKind).toBe("month");
    expect(own.families.find((row) => row.family === "options")).toMatchObject({
      cap: 10,
      used: 10,
      remaining: 0,
    });
    expect(own.grant.active).toBe(true);
  });

  it("GET surfaces the HTTP status on failure and rejects a malformed shape", async () => {
    const forbidden = freshState({ quotaStatus: 403 });
    (globalThis as any).fetch = vi.fn(quotaFetch(forbidden));
    await expect(getApprovedFreeQuota()).rejects.toMatchObject({ status: 403 });
    (globalThis as any).fetch = vi.fn(async () => ok({ userId: 42 }));
    await expect(getApprovedFreeQuota()).rejects.toBeInstanceOf(ApprovedFreeQuotaApiError);
  });

  it("POST cap and settings post one thing per call and return the parsed answer", async () => {
    const state = freshState();
    (globalThis as any).fetch = vi.fn(quotaFetch(state));
    await expect(setApprovedFreeQuotaCap("goal", 2)).resolves.toEqual({
      family: "goal",
      capRuns: 2,
      code: "SUCCESS_APPROVED_FREE_QUOTA_UPDATED",
      message: resolveOutcome("SUCCESS_APPROVED_FREE_QUOTA_UPDATED").businessMessage,
    });
    await expect(setApprovedFreeQuotaSettings({ windowKind: "week" })).resolves.toMatchObject({
      settings: { windowKind: "week" },
      code: "SUCCESS_APPROVED_FREE_QUOTA_UPDATED",
    });
    expect(state.posts).toEqual([
      { family: "goal", capRuns: 2 },
      { windowKind: "week" },
    ]);
  });

  it("operator detection is true on GET /operators success and false on 403", async () => {
    const asOperator = freshState({ operatorsStatus: 200 });
    (globalThis as any).fetch = vi.fn(quotaFetch(asOperator));
    await expect(isStoreOperator()).resolves.toBe(true);
    const asViewer = freshState({ operatorsStatus: 403 });
    (globalThis as any).fetch = vi.fn(quotaFetch(asViewer));
    await expect(isStoreOperator()).resolves.toBe(false);
  });

  it("isGrantExpired distinguishes an expired grant from a never-granted account", () => {
    expect(isGrantExpired({ active: true, expiresAtMs: null })).toBe(false);
    expect(isGrantExpired({ active: false, expiresAtMs: null })).toBe(false);
    expect(isGrantExpired({ active: false, expiresAtMs: 1_700_000_000_000 })).toBe(true);
    expect(isGrantExpired({ active: true, expiresAtMs: 1_700_000_000_000 })).toBe(false);
  });
});

describe("approved-free quota section", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  async function renderSection(state: MockState) {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(quotaFetch(state));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(ApprovedFreeQuotaSection));
    });
    await flush();
    return () => {
      (globalThis as any).fetch = prev;
    };
  }

  async function flush() {
    await act(async () => {});
    await act(async () => {});
    await act(async () => {});
    await act(async () => {});
  }

  function text() {
    return container!.textContent ?? "";
  }

  function buttonNamed(fragment: string): HTMLButtonElement | undefined {
    return Array.from(container!.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(fragment),
    ) as HTMLButtonElement | undefined;
  }

  function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto =
      el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  }

  function inputForLabel(fragment: string): HTMLInputElement | undefined {
    const label = Array.from(container!.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").includes(fragment),
    );
    const id = label?.getAttribute("for");
    return (id ? container!.querySelector(`#${id}`) : undefined) as HTMLInputElement | undefined;
  }

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("non-operator sees the own quota read-only, with per-family usage and the grant state", async () => {
    const restore = await renderSection(freshState({ operatorsStatus: 403 }));
    try {
      // A11y (WCAG 2.2 AA): the section title is a heading under the
      // Billing h1, not a plain paragraph.
      expect(container!.querySelector("h2")?.textContent).toBe("Approved-free quota");
      expect(text()).toMatch(/3 of 10 runs used per month — 7 remaining/);
      expect(text()).toMatch(/10 of 10 runs used per month — 0 remaining/);
      expect(text()).toMatch(/No cap set — no approved-free runs for this service/);
      expect(text()).toMatch(/Approved-free grant: active/);
      expect(text()).toMatch(/Only a store operator can change the approved-free quota/);
      expect(buttonNamed("Save")).toBeUndefined();
      expect(buttonNamed("Look up quota")).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("no grant reads as no grant, never as zero", async () => {
    const restore = await renderSection(
      freshState({ operatorsStatus: 403, quota: makeQuota({ grant: { active: false, expiresAtMs: null } }) }),
    );
    try {
      expect(text()).toMatch(/No approved-free grant for this account/);
    } finally {
      restore();
    }
  });

  it("an expired grant renders the catalog-coded expired message, not the no-grant line", async () => {
    const restore = await renderSection(
      freshState({
        operatorsStatus: 403,
        quota: makeQuota({ grant: { active: false, expiresAtMs: 1_700_000_000_000 } }),
      }),
    );
    try {
      // AOP: the message comes FROM the catalog, never hardcoded.
      expect(text()).toContain(resolveOutcome("FAILURE_APPROVED_FREE_QUOTA_EXPIRED").businessMessage);
      expect(text()).not.toContain("No approved-free grant for this account");
    } finally {
      restore();
    }
  });

  it("operator sees the editor and lookup; saving a cap posts and renders the fresh read", async () => {
    const state = freshState({ operatorsStatus: 200 });
    const restore = await renderSection(state);
    try {
      expect(buttonNamed("Save Goal cap")).toBeDefined();
      expect(buttonNamed("Look up quota")).toBeDefined();
      const input = inputForLabel("Goal cap");
      expect(input).toBeDefined();
      await act(async () => {
        setInputValue(input!, "2");
      });
      await act(async () => {
        buttonNamed("Save Goal cap")!.click();
      });
      await flush();
      expect(state.posts).toContainEqual({ family: "goal", capRuns: 2 });
      // AOP: the success note is the POST's catalog-coded message,
      // asserted FROM the catalog — and it announces via role="status".
      expect(text()).toContain(resolveOutcome("SUCCESS_APPROVED_FREE_QUOTA_UPDATED").businessMessage);
      expect(container!.querySelector('[role="status"]')?.textContent).toContain(
        resolveOutcome("SUCCESS_APPROVED_FREE_QUOTA_UPDATED").businessMessage,
      );
      expect(text()).toMatch(/0 of 2 runs used per month — 2 remaining/);
    } finally {
      restore();
    }
  });

  it("operator lookup loads another account; a refused lookup shows the fixed message", async () => {
    const state = freshState({ operatorsStatus: 200 });
    const restore = await renderSection(state);
    try {
      const input = inputForLabel("Look up an account");
      expect(input).toBeDefined();
      await act(async () => {
        setInputValue(input!, "u2");
      });
      await act(async () => {
        buttonNamed("Look up quota")!.click();
      });
      await flush();
      expect(text()).toMatch(/You do not have access to this account's approved-free quota/);
    } finally {
      restore();
    }
  });

  it("a store outage shows the fixed unavailable message, never raw server text", async () => {
    const restore = await renderSection(freshState({ quotaStatus: 503 }));
    try {
      expect(text()).toMatch(/approved-free quota store is unavailable/);
      expect(text()).not.toContain(MARKER);
      // A11y: the load error announces via role="alert" (Notice warning tone).
      expect(container!.querySelector('[role="alert"]')?.textContent).toMatch(
        /approved-free quota store is unavailable/,
      );
    } finally {
      restore();
    }
  });
});
