/** @vitest-environment jsdom */
/**
 * Saga activation UX (issue 2677): price approval section on the
 * assurance page and saga start + progress on the goal panel.
 * Component tests use the repo idiom (createRoot + act + stubbed
 * global fetch, no testing library). Pure helpers are tested
 * directly; component tests cover the main flows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PriceApprovalSection,
  mapOperatorProbeStatus,
} from "../src/client/PaymentWorkflowAssurance";
import {
  SagaStartSection,
  buildSagaStartBody,
  generateSagaIds,
  mapSagaStartError,
  parseOptionLegs,
  sagaProgressPhase,
} from "../src/client/GoalScreenPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("mapOperatorProbeStatus", () => {
  it("maps 403 to not-operator, 400 to operator, anything else to unknown", () => {
    expect(mapOperatorProbeStatus(403)).toBe("not-operator");
    expect(mapOperatorProbeStatus(400)).toBe("operator");
    expect(mapOperatorProbeStatus(401)).toBe("unknown");
    expect(mapOperatorProbeStatus(500)).toBe("unknown");
    expect(mapOperatorProbeStatus(200)).toBe("unknown");
  });
});

describe("parseOptionLegs", () => {
  it("accepts a non-empty array of leg objects", () => {
    const parsed = parseOptionLegs('[{"strike": 100}]');
    expect(parsed.error).toBeUndefined();
    expect(parsed.legs).toHaveLength(1);
  });
  it("rejects empty arrays, non-arrays, non-object legs, and bad JSON", () => {
    expect(parseOptionLegs("[]").error).toMatch(/at least one leg/);
    expect(parseOptionLegs('{"strike": 100}').error).toMatch(/JSON array/);
    expect(parseOptionLegs("[1]").error).toMatch(/JSON object/);
    expect(parseOptionLegs("not json").error).toMatch(/JSON array/);
  });
});

describe("generateSagaIds", () => {
  it("builds a saga id, reuses it as the run request id, and a distinct job id", () => {
    const ids = generateSagaIds();
    expect(ids.sagaId.startsWith("saga-")).toBe(true);
    expect(ids.runRequestId).toBe(ids.sagaId);
    expect(ids.jobId.startsWith("saga-job-")).toBe(true);
    expect(ids.jobId).not.toBe(ids.sagaId);
  });
});

describe("buildSagaStartBody", () => {
  const base = {
    userLogin: "alice",
    kind: "stock" as const,
    symbol: "aapl",
    action: "buy" as const,
    quantity: "10",
    rail: "" as const,
    email: "alice@example.com",
    legsText: "",
  };
  const ids = { sagaId: "saga-1", runRequestId: "saga-1", jobId: "saga-job-1" };

  it("builds the full entry body with the canonical parent command", () => {
    const { body, error } = buildSagaStartBody(base, ids);
    expect(error).toBeUndefined();
    const b = body as Record<string, unknown>;
    expect(b["sagaId"]).toBe("saga-1");
    expect(b["family"]).toBe("goal");
    expect(b["trigger"]).toBe("manual");
    const cmd = b["screenerCommand"] as Record<string, unknown>;
    expect(cmd["jobId"]).toBe("saga-job-1");
    expect(cmd["type"]).toBe("run-screen");
    expect(cmd["source"]).toBe("manual");
    expect(cmd["trigger"]).toBe("manual");
    expect(cmd["userLogin"]).toBe("alice");
    expect(cmd["role"]).toBe("parent");
    expect(cmd["shards"]).toEqual([{ shardId: "goal" }]);
    const intent = b["tradeIntent"] as Record<string, unknown>;
    expect(intent).toEqual({ kind: "stock", symbol: "AAPL", action: "buy", quantity: 10 });
    expect(b["rail"]).toBeUndefined();
  });

  it("includes the rail when chosen and passes options legs through", () => {
    const { body, error } = buildSagaStartBody(
      { ...base, kind: "options", rail: "stripe", legsText: '[{"strike": 100}]' },
      ids,
    );
    expect(error).toBeUndefined();
    const b = body as Record<string, unknown>;
    expect(b["rail"]).toBe("stripe");
    const intent = b["tradeIntent"] as Record<string, unknown>;
    expect(intent["optionLegs"]).toEqual([{ strike: 100 }]);
  });

  it("rejects a missing symbol, a non-positive quantity, a bad email, and options without legs", () => {
    expect(buildSagaStartBody({ ...base, symbol: "  " }, ids).error).toMatch(/Symbol/);
    expect(buildSagaStartBody({ ...base, quantity: "0" }, ids).error).toMatch(/Quantity/);
    expect(buildSagaStartBody({ ...base, quantity: "abc" }, ids).error).toMatch(/Quantity/);
    expect(buildSagaStartBody({ ...base, email: "alice" }, ids).error).toMatch(/Email/);
    expect(
      buildSagaStartBody({ ...base, kind: "options", legsText: "" }, ids).error,
    ).toMatch(/[Ll]eg/);
  });
});

describe("sagaProgressPhase", () => {
  it("returns gate on a journey stage, done on a done stage, null otherwise", () => {
    expect(sagaProgressPhase([])).toBeNull();
    expect(sagaProgressPhase([{ stage: "payment" }, { stage: "screen" }])).toBeNull();
    expect(sagaProgressPhase([{ stage: "journey" }])).toBe("gate");
    expect(sagaProgressPhase([{ stage: "done" }])).toBe("done");
    expect(sagaProgressPhase([{ stage: "journey" }, { stage: "done" }])).toBe("done");
  });
});

describe("mapSagaStartError", () => {
  it("maps 401, flag 403, other 403, 400, 503, and fallback", () => {
    expect(mapSagaStartError(401, null)).toMatch(/Sign in/);
    expect(
      mapSagaStartError(403, "saga entry is behind the monetization flag (reviewed wiring; flag OFF)."),
    ).toMatch(/monetization flag is OFF/);
    expect(mapSagaStartError(403, "Tenant mismatch")).toMatch(/refused/);
    expect(mapSagaStartError(400, "Symbol is required.")).toBe("Symbol is required.");
    expect(mapSagaStartError(503, "Binding missing.")).toBe("Binding missing.");
    expect(mapSagaStartError(500, null)).toMatch(/HTTP 500/);
  });
});

describe("PriceApprovalSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let probeStatus: number;
  let approveStatus: number;

  const pricingBody = {
    monetizationEnabled: true,
    prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
  };

  beforeEach(() => {
    probeStatus = 400;
    approveStatus = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/payments/agentic/commercial/pricing") && method === "GET") {
          return { ok: true, status: 200, json: async () => pricingBody };
        }
        if (url.endsWith("/payments/agentic/commercial/prices") && method === "POST") {
          const body = JSON.parse((init?.body as string) || "{}") as Record<string, unknown>;
          if (body["approvalStatus"] === undefined && body["priceUSD"] === undefined) {
            return { ok: probeStatus < 300, status: probeStatus, json: async () => ({}) };
          }
          if (approveStatus !== 200) {
            return {
              ok: false,
              status: approveStatus,
              json: async () => ({ error: "Forbidden: store operator required." }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              entry: {
                family: body["family"],
                priceUSD: pricingBody.prices[body["family"] as string] ?? 0,
                approvalStatus: "approved",
                approvedBy: "op1",
                approvedAtMs: 1761984000000,
              },
            }),
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const approveButtons = () =>
    [...container.querySelectorAll("button")].filter((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("Approve "),
    );

  it("shows prices and Approve buttons for an operator, and records approval with approver and time", async () => {
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="op1" />);
    });
    await flush();
    expect(container.textContent).toContain("Goal");
    expect(container.textContent).toContain("$0.10");
    expect(approveButtons()).toHaveLength(4);
    const goalButton = approveButtons().find(
      (b) => b.getAttribute("aria-label") === "Approve Goal price",
    )!;
    expect(goalButton).toBeTruthy();
    await act(async () => {
      goalButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("op1");
  });

  it("shows a not-an-operator state with no Approve buttons for a non-operator", async () => {
    probeStatus = 403;
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="mallory" />);
    });
    await flush();
    expect(container.textContent).toMatch(/not a store operator/);
    expect(approveButtons()).toHaveLength(0);
  });

  it("fails closed with no Approve buttons when operator status cannot be verified", async () => {
    probeStatus = 500;
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="op1" />);
    });
    await flush();
    expect(container.textContent).toMatch(/Could not verify/);
    expect(approveButtons()).toHaveLength(0);
  });

  it("flips to not-an-operator when an approval is refused with 403", async () => {
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="op1" />);
    });
    await flush();
    expect(approveButtons()).toHaveLength(4);
    approveStatus = 403;
    const goalButton = approveButtons().find(
      (b) => b.getAttribute("aria-label") === "Approve Goal price",
    )!;
    await act(async () => {
      goalButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toMatch(/not a store operator/);
    expect(approveButtons()).toHaveLength(0);
  });

  it("shows Unknown approval state initially, never Proposed, until an approval is recorded", async () => {
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="op1" />);
    });
    await flush();
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Proposed");
  });
});

describe("SagaStartSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let flagOn: boolean;
  let startResponse: { status: number; body: unknown };
  let statusJobs: Array<Record<string, unknown>>;
  let startCalls: number;

  beforeEach(() => {
    flagOn = true;
    startCalls = 0;
    startResponse = {
      status: 202,
      body: {
        sagaId: "saga-test-1",
        runRequestId: "saga-test-1",
        workflowId: "saga-workflow-1",
        statusUrl: "/api/saga/saga-test-1/status",
        disclosure: "If this screen had failed, a replacement-run credit would apply.",
      },
    };
    statusJobs = [
      { stage: "payment", status: "submitted", detail: "payment started", updatedAtMs: 1 },
      { stage: "screen", status: "submitted", detail: "screen started", updatedAtMs: 2 },
    ];
    sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/payments/agentic/commercial/pricing") && method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ monetizationEnabled: flagOn, prices: {} }),
          };
        }
        if (url.endsWith("/api/saga/start") && method === "POST") {
          startCalls += 1;
          return {
            ok: startResponse.status < 300,
            status: startResponse.status,
            json: async () => startResponse.body,
          };
        }
        if (url.includes("/api/saga/") && url.endsWith("/status") && method === "GET") {
          return { ok: true, status: 200, json: async () => ({ sagaId: "saga-test-1", jobs: statusJobs }) };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  const sagaForm = () => {
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start paid saga"),
    )!;
    return button.closest("form") as HTMLFormElement;
  };

  const fillSagaForm = async () => {
    const form = sagaForm();
    const inputs = [...form.querySelectorAll("input")];
    const selects = [...form.querySelectorAll("select")];
    // Input order: symbol, quantity, email, (legs when options).
    setInput(inputs[0], "AAPL");
    setInput(inputs[1], "10");
    setInput(inputs[2], "alice@example.com");
    void selects;
  };

  it("disables the form with the flag reason when monetization is OFF", async () => {
    flagOn = false;
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    expect(container.textContent).toMatch(/monetization flag is OFF/);
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start paid saga"),
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("requires sign-in before starting", async () => {
    await act(async () => {
      root.render(<SagaStartSection />);
    });
    await flush();
    expect(container.textContent).toMatch(/Sign in to start a saga/);
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start paid saga"),
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("validates client-side and never calls start with a missing symbol", async () => {
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    await act(async () => {
      sagaForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toMatch(/Symbol is required/);
    expect(startCalls).toBe(0);
  });

  it("requires legs for options and never calls start without them", async () => {
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    const form = sagaForm();
    const selects = [...form.querySelectorAll("select")];
    await act(async () => {
      setSelect(selects[0], "options");
    });
    await fillSagaForm();
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toMatch(/at least one leg/);
    expect(startCalls).toBe(0);
  });

  it("starts on 202, shows the disclosure and status link, and polls stage rows", async () => {
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    await fillSagaForm();
    await act(async () => {
      sagaForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(startCalls).toBe(1);
    expect(container.textContent).toContain("replacement-run credit would apply");
    expect(container.textContent).toContain("/api/saga/saga-test-1/status");
    expect(container.textContent).toContain("payment");
    expect(container.textContent).toContain("screen");
  });

  it("hands over to the gate cards when a journey stage appears", async () => {
    statusJobs = [
      { stage: "payment", status: "completed", detail: "paid", updatedAtMs: 1 },
      { stage: "screen", status: "completed", detail: "screened", updatedAtMs: 2 },
      { stage: "journey", status: "submitted", detail: "prompted", updatedAtMs: 3 },
    ];
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    await fillSagaForm();
    await act(async () => {
      sagaForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toMatch(/Gate reached/);
  });

  it("surfaces a flag 403 from start as the disabled flag state, not a bare error", async () => {
    startResponse = { status: 403, body: { error: "saga entry is behind the monetization flag (reviewed wiring; flag OFF)." } };
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    await fillSagaForm();
    await act(async () => {
      sagaForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toMatch(/monetization flag is OFF/);
  });

  it("surfaces a server 400 validation error verbatim", async () => {
    startResponse = { status: 400, body: { error: "Symbol is required." } };
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    await fillSagaForm();
    await act(async () => {
      sagaForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toContain("Symbol is required.");
  });
});
