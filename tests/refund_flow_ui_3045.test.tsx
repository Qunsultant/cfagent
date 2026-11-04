/** @vitest-environment jsdom */
/**
 * Issue #3045 (monetization Phase 2.20, program #2405) — refund flow UI.
 *
 * TDD RED first: this suite imports src/client/refundFlowApi.ts and
 * src/client/RefundFlowSection.tsx, which do not exist yet.
 *
 * Scope (see the live #3045 body): request form, record lifecycle view,
 * and refundId verify in the Billing servicing surface over the
 * EXISTING 2.7 routes only — POST /refunds, POST /refunds/approve,
 * POST /refunds/execute, GET /refunds (list + ?refundId=). No new
 * server route, no policy-value editing, no rail behavior change.
 * Operator action buttons render only when GET /operators succeeds
 * (2.19 rule); otherwise read-only. After every action the section
 * renders ONLY a fresh read, never the POST answer. Failures render as
 * fixed strings; server error bodies are never rendered. The mock
 * error bodies carry a marker string asserted ABSENT from the DOM.
 * ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  requestRefund,
  decideRefund,
  executeRefund,
  getRefund,
  listRefunds,
  RefundFlowApiError,
  type RefundRecord,
  type RefundStatus,
} from "../src/client/refundFlowApi";
import { RefundFlowSection } from "../src/client/RefundFlowSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;
const BASE = "/api/payments/agentic/commercial";
const MARKER = "typed server detail marker";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: MARKER }) };
}

const BASE_POLICY = {
  windowDays: 30,
  approver: "operator_hitl",
  allowPartial: false,
  subscriptionFullEffect: "revoke_immediately",
  subscriptionPartialEffect: "keep_access",
  payPerRunEffect: "none",
  creditEffect: "none",
  approvedKinds: [] as string[],
  approvedBy: null as string | null,
  approvedAtMs: null as number | null,
};

function makeRecord(overrides: Partial<RefundRecord> = {}): RefundRecord {
  return {
    id: "rf-1",
    userId: "owner",
    kind: "subscription",
    originalPaymentRef: "sub-1",
    subscriptionId: "sub-1",
    paymentIntentId: "pi_1",
    family: null,
    originalAmountUSD: 10,
    amountUSD: 10,
    originalPaidAtMs: NOW - 1000,
    reason: "changed my mind",
    status: "requested",
    approverLogin: null,
    decisionNote: null,
    gatewayRefundId: null,
    executedAtMs: null,
    entitlementConsequence: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

interface MockState {
  policy: typeof BASE_POLICY;
  policyStatus: number | null;
  operatorsStatus: number;
  refunds: RefundRecord[];
  listStatus: number | null;
  requestStatus: number | null;
  decideStatus: number | null;
  executeStatus: number | null;
  executePayPerRun422: boolean;
  requestPosts: unknown[];
  decidePosts: unknown[];
  executePosts: unknown[];
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    policy: { ...BASE_POLICY, approvedKinds: [] },
    policyStatus: null,
    operatorsStatus: 200,
    refunds: [],
    listStatus: null,
    requestStatus: null,
    decideStatus: null,
    executeStatus: null,
    executePayPerRun422: false,
    requestPosts: [],
    decidePosts: [],
    executePosts: [],
    ...overrides,
  };
}

function flowFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === `${BASE}/refund-policy` && method === "GET") {
      if (state.policyStatus) return err(state.policyStatus);
      return ok({
        policy: { ...state.policy, approvedKinds: [...state.policy.approvedKinds] },
        disclosure: "Refunds are available within 30 days of payment.",
      });
    }
    if (url === `${BASE}/operators` && method === "GET") {
      if (state.operatorsStatus !== 200) return err(state.operatorsStatus);
      return ok({ operators: [{ login: "operator-1", source: "env", addedBy: null, addedAtMs: null }] });
    }
    if (url === `${BASE}/refunds` && method === "GET") {
      if (state.listStatus) return err(state.listStatus);
      return ok({ refunds: state.refunds.map((r) => ({ ...r })) });
    }
    if (url.startsWith(`${BASE}/refunds?refundId=`) && method === "GET") {
      const id = decodeURIComponent(url.split("refundId=")[1]);
      const rec = state.refunds.find((r) => r.id === id);
      if (!rec) return err(404);
      return ok({ refund: { ...rec } });
    }
    if (url === `${BASE}/refunds` && method === "POST") {
      if (state.requestStatus) return err(state.requestStatus);
      const body = JSON.parse(String(init.body)) as {
        kind: string; originalPaymentRef: string; amountUSD: number; reason: string;
      };
      state.requestPosts.push(body);
      const rec = makeRecord({
        id: "rf-new",
        kind: body.kind as never,
        originalPaymentRef: body.originalPaymentRef,
        amountUSD: body.amountUSD,
        originalAmountUSD: body.amountUSD,
        reason: body.reason,
        status: "requested",
      });
      state.refunds.push(rec);
      // STALE answer: reason blanked, so rendering the reason proves a fresh read.
      return ok({ refund: { ...rec, reason: "" } });
    }
    if (url === `${BASE}/refunds/approve` && method === "POST") {
      if (state.decideStatus) return err(state.decideStatus);
      const body = JSON.parse(String(init.body)) as { refundId: string; decision: string; note?: string };
      state.decidePosts.push(body);
      const rec = state.refunds.find((r) => r.id === body.refundId);
      if (!rec) return err(404);
      const stale = { ...rec };
      rec.status = body.decision === "approve" ? "approved" : "denied";
      rec.approverLogin = "operator-1";
      rec.decisionNote = typeof body.note === "string" ? body.note : null;
      return ok({ refund: stale });
    }
    if (url === `${BASE}/refunds/execute` && method === "POST") {
      const body = JSON.parse(String(init.body)) as { refundId: string };
      state.executePosts.push(body);
      const rec = state.refunds.find((r) => r.id === body.refundId);
      if (!rec) return err(404);
      if (state.executeStatus) {
        if (state.executeStatus === 502) rec.status = "execution_failed";
        return err(state.executeStatus);
      }
      if (state.executePayPerRun422 && rec.kind === "pay_per_run") return err(422);
      const stale = { ...rec };
      rec.status = "executed";
      rec.gatewayRefundId = "re_1";
      rec.executedAtMs = NOW;
      rec.entitlementConsequence = "Subscription revoked immediately; included runs removed.";
      return ok({ refund: stale });
    }
    throw new Error(`unexpected fetch: ${url} ${method}`);
  };
}

describe("refund flow api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts exactly kind + originalPaymentRef + amountUSD + reason", async () => {
    const state = freshState();
    (globalThis as any).fetch = vi.fn(flowFetch(state));
    const rec = await requestRefund({
      kind: "subscription",
      originalPaymentRef: "sub-1",
      amountUSD: 10,
      reason: "changed my mind",
    });
    expect(state.requestPosts).toEqual([
      { kind: "subscription", originalPaymentRef: "sub-1", amountUSD: 10, reason: "changed my mind" },
    ]);
    expect(rec.id).toBe("rf-new");
    expect(rec.status).toBe("requested");
  });

  it("posts refundId + decision for approve/deny and surfaces the HTTP status on failure", async () => {
    const state = freshState({ decideStatus: 403 });
    (globalThis as any).fetch = vi.fn(flowFetch(state));
    await expect(decideRefund("rf-1", "approve")).rejects.toMatchObject({ status: 403 });
    expect(state.decidePosts).toHaveLength(0);
    expect(new RefundFlowApiError(403).status).toBe(403);
  });

  it("posts refundId for execute, reads one record by id, and lists own refunds", async () => {
    const state = freshState({
      refunds: [makeRecord({ id: "rf-1" }), makeRecord({ id: "rf-2", status: "approved" })],
    });
    (globalThis as any).fetch = vi.fn(flowFetch(state));
    const one = await getRefund("rf-2");
    expect(one.status).toBe("approved");
    const list = await listRefunds();
    expect(list.map((r) => r.id)).toEqual(["rf-1", "rf-2"]);
    await executeRefund("rf-2");
    expect(state.executePosts).toEqual([{ refundId: "rf-2" }]);
    expect(state.refunds.find((r) => r.id === "rf-2")?.status).toBe("executed");
  });

  it("validates the record shape and rejects a malformed record", async () => {
    const state = freshState();
    (globalThis as any).fetch = vi.fn(async () => ok({ refund: { id: "rf-x", status: "bogus" } }));
    await expect(getRefund("rf-x")).rejects.toMatchObject({ status: 500 });
  });
});

describe("refund flow section", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  async function renderSection(state: MockState) {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(flowFetch(state));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(RefundFlowSection));
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

  function buttonNamed(text: string): HTMLButtonElement | undefined {
    return Array.from(container!.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(text),
    ) as HTMLButtonElement | undefined;
  }

  function setInput(selector: string, value: string) {
    const el = container!.querySelector(selector) as HTMLInputElement;
    expect(el).toBeDefined();
    el.value = value;
  }

  function text() {
    return container!.textContent ?? "";
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

  it("renders the request form, the revocation warning, and the honest limits copy", async () => {
    const restore = await renderSection(freshState());
    try {
      expect(text()).toMatch(/Refund flow/);
      expect(text()).toMatch(/revokes access immediately/);
      expect(text()).toMatch(/not resolvable/);
      expect(text()).toMatch(/non-refundable/);
      expect(text()).toMatch(/never guessed/);
      expect(buttonNamed("Request refund")).toBeDefined();
      expect(buttonNamed("Look up refund")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("disables the request submit with a fixed message when the kind is not approved", async () => {
    const restore = await renderSection(freshState());
    try {
      const submit = buttonNamed("Request refund")!;
      expect(submit.disabled).toBe(true);
      expect(text()).toMatch(/not approved yet/);
    } finally {
      restore();
    }
  });

  it("requests a refund and renders the fresh read, never the stale POST answer", async () => {
    const state = freshState({
      policy: { ...BASE_POLICY, approvedKinds: ["subscription"] },
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-original-ref", "sub-1");
      setInput("#refund-amount", "10");
      setInput("#refund-reason", "changed my mind");
      await act(async () => {
        buttonNamed("Request refund")!.click();
      });
      await flush();
      expect(state.requestPosts).toEqual([
        { kind: "subscription", originalPaymentRef: "sub-1", amountUSD: 10, reason: "changed my mind" },
      ]);
      expect(text()).toMatch(/rf-new/);
      expect(text()).toMatch(/Requested/);
      // The POST answer blanked the reason; only a fresh GET shows it.
      expect(text()).toMatch(/changed my mind/);
      expect(text()).not.toContain(MARKER);
    } finally {
      restore();
    }
  });

  it("validates required fields client-side with fixed messages", async () => {
    const state = freshState({
      policy: { ...BASE_POLICY, approvedKinds: ["subscription"] },
    });
    const restore = await renderSection(state);
    try {
      await act(async () => {
        buttonNamed("Request refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/original payment reference/);
      expect(state.requestPosts).toHaveLength(0);
      setInput("#refund-original-ref", "sub-1");
      setInput("#refund-amount", "not-a-number");
      await act(async () => {
        buttonNamed("Request refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/valid amount/);
      expect(state.requestPosts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("renders a request 422 as the fixed unapproved-kind message, never the server body", async () => {
    const state = freshState({
      policy: { ...BASE_POLICY, approvedKinds: ["subscription"] },
      requestStatus: 422,
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-original-ref", "sub-1");
      setInput("#refund-amount", "10");
      setInput("#refund-reason", "changed my mind");
      await act(async () => {
        buttonNamed("Request refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/not approved yet/);
      expect(text()).not.toContain(MARKER);
    } finally {
      restore();
    }
  });

  it("renders a request 403 as the fixed flag-off message", async () => {
    const state = freshState({
      policy: { ...BASE_POLICY, approvedKinds: ["subscription"] },
      requestStatus: 403,
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-original-ref", "sub-1");
      setInput("#refund-amount", "10");
      setInput("#refund-reason", "changed my mind");
      await act(async () => {
        buttonNamed("Request refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/monetization is off/);
    } finally {
      restore();
    }
  });

  it("renders a request 400 as the fixed full-amount message", async () => {
    const state = freshState({
      policy: { ...BASE_POLICY, approvedKinds: ["subscription"] },
      requestStatus: 400,
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-original-ref", "sub-1");
      setInput("#refund-amount", "5");
      setInput("#refund-reason", "changed my mind");
      await act(async () => {
        buttonNamed("Request refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/full original payment/);
    } finally {
      restore();
    }
  });

  it("looks a record up by id and renders its lifecycle state", async () => {
    const state = freshState({
      refunds: [makeRecord({ id: "rf-9", status: "approved", amountUSD: 10 })],
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-9");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/rf-9/);
      expect(text()).toMatch(/Approved/);
      expect(text()).toMatch(/\$10\.00/);
    } finally {
      restore();
    }
  });

  it("renders a verify 404 as a fixed no-such-refund message", async () => {
    const restore = await renderSection(freshState());
    try {
      setInput("#refund-verify-id", "rf-missing");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/No refund with that id/);
    } finally {
      restore();
    }
  });

  it("lists own refunds and opens one into the record view", async () => {
    const state = freshState({
      refunds: [makeRecord({ id: "rf-1" }), makeRecord({ id: "rf-2", status: "executed" })],
    });
    const restore = await renderSection(state);
    try {
      expect(text()).toMatch(/rf-1/);
      expect(text()).toMatch(/rf-2/);
      const viewButtons = Array.from(container!.querySelectorAll("button")).filter((b) =>
        (b.textContent ?? "").trim() === "View",
      );
      expect(viewButtons.length).toBeGreaterThanOrEqual(2);
      await act(async () => {
        viewButtons[1]!.click();
      });
      await flush();
      expect(text()).toMatch(/Executed/);
    } finally {
      restore();
    }
  });

  it("approves a requested record as operator and reflects the fresh read", async () => {
    const state = freshState({ refunds: [makeRecord({ id: "rf-1" })] });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-1");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      const approve = buttonNamed("Approve refund");
      expect(approve).toBeDefined();
      await act(async () => {
        approve!.click();
      });
      await flush();
      expect(state.decidePosts).toEqual([{ refundId: "rf-1", decision: "approve" }]);
      // The POST answer carried the stale "requested" status.
      expect(text()).toMatch(/Approved/);
      expect(text()).toMatch(/Approved by operator-1/);
    } finally {
      restore();
    }
  });

  it("denies a requested record as operator", async () => {
    const state = freshState({ refunds: [makeRecord({ id: "rf-1" })] });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-1");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      await act(async () => {
        buttonNamed("Deny refund")!.click();
      });
      await flush();
      expect(state.decidePosts).toEqual([{ refundId: "rf-1", decision: "deny" }]);
      expect(text()).toMatch(/Denied/);
      expect(text()).toMatch(/Denied by operator-1/);
    } finally {
      restore();
    }
  });

  it("executes an approved record as operator and shows the entitlement consequence", async () => {
    const state = freshState({ refunds: [makeRecord({ id: "rf-1", status: "approved" })] });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-1");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      await act(async () => {
        buttonNamed("Execute refund")!.click();
      });
      await flush();
      expect(state.executePosts).toEqual([{ refundId: "rf-1" }]);
      // The POST answer carried the stale "approved" status.
      expect(text()).toMatch(/Executed/);
      expect(text()).toMatch(/revoked immediately/);
      expect(text()).toMatch(/re_1/);
    } finally {
      restore();
    }
  });

  it("shows no action buttons to a non-operator, record read-only", async () => {
    const state = freshState({
      operatorsStatus: 403,
      refunds: [makeRecord({ id: "rf-1" })],
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-1");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/Only a store operator can decide or execute refunds/);
      const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttons.join(" ")).not.toMatch(/Approve refund|Deny refund|Execute refund|Retry execution/);
      // Requesting is owner-or-operator, so the request form stays available.
      expect(buttonNamed("Request refund")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("retries an execution_failed record as operator", async () => {
    const state = freshState({
      refunds: [makeRecord({ id: "rf-1", status: "execution_failed" })],
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-1");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/Execution failed/);
      const retry = buttonNamed("Retry execution");
      expect(retry).toBeDefined();
      await act(async () => {
        retry!.click();
      });
      await flush();
      expect(state.executePosts).toEqual([{ refundId: "rf-1" }]);
      expect(text()).toMatch(/Executed/);
    } finally {
      restore();
    }
  });

  it("re-reads to execution_failed on a gateway 502 and offers retry", async () => {
    const state = freshState({
      refunds: [makeRecord({ id: "rf-1", status: "approved" })],
      executeStatus: 502,
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-1");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      await act(async () => {
        buttonNamed("Execute refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/Execution failed/);
      expect(buttonNamed("Retry execution")).toBeDefined();
      expect(text()).not.toContain(MARKER);
    } finally {
      restore();
    }
  });

  it("surfaces a pay-per-run execute 422 as the fixed unresolvable message", async () => {
    const state = freshState({
      refunds: [makeRecord({ id: "rf-pp", kind: "pay_per_run", status: "approved", paymentIntentId: null })],
      executePayPerRun422: true,
    });
    const restore = await renderSection(state);
    try {
      setInput("#refund-verify-id", "rf-pp");
      await act(async () => {
        buttonNamed("Look up refund")!.click();
      });
      await flush();
      await act(async () => {
        buttonNamed("Execute refund")!.click();
      });
      await flush();
      expect(text()).toMatch(/no payment-intent id can be resolved/);
      expect(text()).toMatch(/Approved/);
    } finally {
      restore();
    }
  });

  it("keeps the form submittable when the policy read fails, server stays the authority", async () => {
    const state = freshState({ policyStatus: 503 });
    const restore = await renderSection(state);
    try {
      expect(text()).toMatch(/policy status unavailable/);
      expect(buttonNamed("Request refund")!.disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it("renders a list failure as a fixed message, never a crash", async () => {
    const state = freshState({ listStatus: 503 });
    const restore = await renderSection(state);
    try {
      expect(text()).toMatch(/refunds could not be loaded/);
      expect(buttonNamed("Request refund")).toBeDefined();
    } finally {
      restore();
    }
  });
});
