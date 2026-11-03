/** @vitest-environment jsdom */
/**
 * Issue #2985 (monetization Phase 2.19, program #2405) — refund
 * approval UI.
 *
 * TDD RED first: this suite imports src/client/refundPolicyApi.ts
 * and src/client/RefundPolicySection.tsx, which do not exist yet.
 *
 * Scope (see the live #2985 body): an operator refund-policy section
 * in the Billing servicing surface over the EXISTING 2.7 routes only
 * — GET refund-policy (any verified login), POST refund-policy/approve
 * (operator-only, per kind), GET operators (operator-only, proves the
 * viewer is an operator). It shows current values, the disclosure
 * copy, and per-kind approval state, with per-kind approve/withdraw
 * actions reflected from a FRESH policy read (never an optimistic
 * assertion). No refund request/approve/execute flow, no policy value
 * editing, no new server route. Failures render as fixed strings;
 * server error bodies are never rendered. ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getRefundPolicy,
  setRefundKindApproval,
  listOperators,
  RefundPolicyApiError,
  type RefundPolicyView,
} from "../src/client/refundPolicyApi";
import { RefundPolicySection } from "../src/client/RefundPolicySection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

const BASE_POLICY: RefundPolicyView = {
  windowDays: 30,
  approver: "operator_hitl",
  allowPartial: false,
  subscriptionFullEffect: "revoke_immediately",
  subscriptionPartialEffect: "keep_access",
  payPerRunEffect: "none",
  creditEffect: "none",
  approvedKinds: [],
  approvedBy: null,
  approvedAtMs: null,
};

const DISCLOSURE =
  "Refunds are available within 30 days of payment and require operator approval.";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface MockState {
  policy: RefundPolicyView;
  operatorsStatus: number;
  approveStatus: number | null;
  policyStatus: number | null;
  posts: Array<{ kind: string; approved: boolean }>;
}

/** Stateful mock: POST updates server state but answers STALE, so a UI
 *  that shows the new state proves it re-read (never optimistic). */
function policyFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    if (url === "/api/payments/agentic/commercial/refund-policy" && (!init || init.method === undefined || init.method === "GET")) {
      if (state.policyStatus) return err(state.policyStatus);
      return ok({ policy: { ...state.policy, approvedKinds: [...state.policy.approvedKinds] }, disclosure: DISCLOSURE });
    }
    if (url === "/api/payments/agentic/commercial/refund-policy/approve" && init?.method === "POST") {
      if (state.approveStatus) return err(state.approveStatus);
      const body = JSON.parse(String(init.body)) as { kind: string; approved: boolean };
      state.posts.push(body);
      const stale = { ...state.policy, approvedKinds: [...state.policy.approvedKinds] };
      if (body.approved) {
        if (!state.policy.approvedKinds.includes(body.kind as never)) state.policy.approvedKinds.push(body.kind as never);
        state.policy.approvedBy = "operator-1";
        state.policy.approvedAtMs = NOW;
      } else {
        state.policy.approvedKinds = state.policy.approvedKinds.filter((k) => k !== body.kind) as never[];
        if (state.policy.approvedKinds.length === 0) {
          state.policy.approvedBy = null;
          state.policy.approvedAtMs = null;
        }
      }
      return ok({ policy: stale });
    }
    if (url === "/api/payments/agentic/commercial/operators") {
      if (state.operatorsStatus !== 200) return err(state.operatorsStatus);
      return ok({ operators: [{ login: "operator-1", source: "env", addedBy: null, addedAtMs: null }] });
    }
    throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  };
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    policy: { ...BASE_POLICY, approvedKinds: [] },
    operatorsStatus: 200,
    approveStatus: null,
    policyStatus: null,
    posts: [],
    ...overrides,
  };
}

describe("refund policy api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads policy and disclosure verbatim from the server", async () => {
    const state = freshState();
    (globalThis as any).fetch = vi.fn(policyFetch(state));
    const res = await getRefundPolicy();
    expect(res.policy.windowDays).toBe(30);
    expect(res.policy.approver).toBe("operator_hitl");
    expect(res.policy.allowPartial).toBe(false);
    expect(res.disclosure).toBe(DISCLOSURE);
  });

  it("posts exactly kind + approved and surfaces the HTTP status on failure", async () => {
    const state = freshState({ approveStatus: 403 });
    (globalThis as any).fetch = vi.fn(policyFetch(state));
    await expect(setRefundKindApproval("pay_per_run", true)).rejects.toMatchObject({ status: 403 });
    expect(state.posts).toHaveLength(0);
    expect(new RefundPolicyApiError(403).status).toBe(403);
  });

  it("lists operators for the operator check", async () => {
    const state = freshState();
    (globalThis as any).fetch = vi.fn(policyFetch(state));
    const operators = await listOperators();
    expect(operators.map((o) => o.login)).toContain("operator-1");
  });
});

describe("refund policy section", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  async function renderSection(state: MockState) {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(policyFetch(state));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(RefundPolicySection));
    });
    await act(async () => {});
    await act(async () => {});
    return () => {
      (globalThis as any).fetch = prev;
    };
  }

  function buttonNamed(text: string): HTMLButtonElement | undefined {
    return Array.from(container!.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(text),
    ) as HTMLButtonElement | undefined;
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

  it("renders policy values, disclosure, and per-kind approval state", async () => {
    const restore = await renderSection(freshState());
    try {
      const text = container!.textContent ?? "";
      expect(text).toMatch(/Refund policy/);
      expect(text).toMatch(/30 days/);
      expect(text).toMatch(/operator_hitl/);
      expect(text).toMatch(/Refunds are available within 30 days/);
      expect(text).toMatch(/Subscription refunds/);
      expect(text).toMatch(/Pay-per-run refunds/);
      expect(text).toMatch(/Not approved/);
    } finally {
      restore();
    }
  });

  it("approves a kind via the route and reflects the fresh read, never the stale POST answer", async () => {
    const state = freshState();
    const restore = await renderSection(state);
    try {
      const approve = buttonNamed("Approve pay-per-run refunds");
      expect(approve).toBeDefined();
      await act(async () => {
        approve!.click();
      });
      await act(async () => {});
      await act(async () => {});
      expect(state.posts).toEqual([{ kind: "pay_per_run", approved: true }]);
      const text = container!.textContent ?? "";
      expect(text).toMatch(/Approved by operator-1/);
      expect(buttonNamed("Withdraw approval")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("withdraws an approved kind", async () => {
    const state = freshState({
      policy: {
        ...BASE_POLICY,
        approvedKinds: ["pay_per_run"],
        approvedBy: "operator-1",
        approvedAtMs: NOW,
      },
    });
    const restore = await renderSection(state);
    try {
      const withdraw = buttonNamed("Withdraw approval");
      expect(withdraw).toBeDefined();
      await act(async () => {
        withdraw!.click();
      });
      await act(async () => {});
      await act(async () => {});
      expect(state.posts).toEqual([{ kind: "pay_per_run", approved: false }]);
      expect(container!.textContent ?? "").toMatch(/Not approved/);
    } finally {
      restore();
    }
  });

  it("shows no action buttons to a non-operator, values and state read-only", async () => {
    const state = freshState({ operatorsStatus: 403 });
    const restore = await renderSection(state);
    try {
      const text = container!.textContent ?? "";
      expect(text).toMatch(/Refund policy/);
      expect(text).toMatch(/Only a store operator can change approvals/);
      const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttons.join(" ")).not.toMatch(/Approve|Withdraw/);
    } finally {
      restore();
    }
  });

  it("renders an unconfigured policy (503) as an honest empty state, never a crash", async () => {
    const state = freshState({ policyStatus: 503 });
    const restore = await renderSection(state);
    try {
      expect(container!.textContent ?? "").toMatch(/not configured/);
    } finally {
      restore();
    }
  });

  it("renders an approval 403 as a fixed operator-only message with state unchanged", async () => {
    const state = freshState({ approveStatus: 403 });
    const restore = await renderSection(state);
    try {
      const approve = buttonNamed("Approve pay-per-run refunds");
      expect(approve).toBeDefined();
      await act(async () => {
        approve!.click();
      });
      await act(async () => {});
      await act(async () => {});
      const text = container!.textContent ?? "";
      expect(text).toMatch(/Only a store operator can change refund approvals/);
      expect(text).toMatch(/Not approved/);
    } finally {
      restore();
    }
  });

  it("renders an approval 503 as a fixed unavailable message", async () => {
    const state = freshState({ approveStatus: 503 });
    const restore = await renderSection(state);
    try {
      const approve = buttonNamed("Approve subscription refunds");
      expect(approve).toBeDefined();
      await act(async () => {
        approve!.click();
      });
      await act(async () => {});
      await act(async () => {});
      expect(container!.textContent ?? "").toMatch(/temporarily unavailable/);
    } finally {
      restore();
    }
  });

  it("offers no refund request or execution action", async () => {
    const restore = await renderSection(freshState());
    try {
      const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttons.join(" ")).not.toMatch(/request refund|execute refund/i);
    } finally {
      restore();
    }
  });
});
