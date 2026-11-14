/**
 * Price management read route (issue 2739): GET
 * /payments/agentic/commercial/prices returns the catalogue's full
 * entries to a store operator. The route handler is tested through
 * handleAgenticPaymentsRoutes with the catalogue factory mocked —
 * the catalogue itself is covered by tests/price_catalogue_ports.test.ts.
 * No ORM, no D1, no SQL in this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

const mockGetAllPrices = vi.fn();
const mockCreateAdapter = vi.fn();
const mockEnsureSchema = vi.fn();

vi.mock("../src/data/createPriceCataloguePorts", () => ({
  createPriceCatalogueAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
  ensurePriceCatalogueSchema: (...args: unknown[]) => mockEnsureSchema(...args),
}));

const PATH = "/payments/agentic/commercial/prices";

function makeCtx(operators: string | undefined): AgenticPaymentsRouteContext {
  return {
    env: { COMMERCIAL_STORE_OPERATORS: operators } as never,
    getOrm: () => ({}) as never,
    audit: vi.fn(),
  } as AgenticPaymentsRouteContext;
}

function getRequest(login: string | null): Request {
  const headers: Record<string, string> = {};
  if (login) headers["x-user-login"] = login;
  return new Request(`https://agent.internal${PATH}`, { method: "GET", headers });
}

const ENTRIES = [
  {
    family: "goal",
    priceUSD: 0.1,
    updatedAtMs: 1761984000000,
    approvalStatus: "proposed",
    approvedBy: null,
    approvedAtMs: null,
  },
  {
    family: "stock",
    priceUSD: 0.02,
    updatedAtMs: 1761984000000,
    approvalStatus: "approved",
    approvedBy: "op1",
    approvedAtMs: 1761984000000,
  },
];

describe("GET /payments/agentic/commercial/prices (issue 2739)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAdapter.mockImplementation(() => ({ getAllPrices: mockGetAllPrices }));
    mockGetAllPrices.mockResolvedValue(ENTRIES);
  });

  it("returns 401 without a session login", async () => {
    const res = await handleAgenticPaymentsRoutes(
      getRequest(null),
      new URL(`https://agent.internal${PATH}`),
      PATH,
      "sess-1",
      makeCtx("op1"),
    );
    expect(res?.status).toBe(401);
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it("returns 403 for a verified login that is not a store operator", async () => {
    const res = await handleAgenticPaymentsRoutes(
      getRequest("mallory"),
      new URL(`https://agent.internal${PATH}`),
      PATH,
      "sess-1",
      makeCtx("op1"),
    );
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as any).error).toBe("Forbidden: store operator required.");
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it("returns 503 when the catalogue store is unbound, never a silent no-op", async () => {
    mockCreateAdapter.mockReturnValueOnce(null);
    const res = await handleAgenticPaymentsRoutes(
      getRequest("op1"),
      new URL(`https://agent.internal${PATH}`),
      PATH,
      "sess-1",
      makeCtx("op1"),
    );
    expect(res?.status).toBe(503);
  });

  it("returns the full entries for an operator, without ensuring the schema on the read path", async () => {
    const res = await handleAgenticPaymentsRoutes(
      getRequest("op1"),
      new URL(`https://agent.internal${PATH}`),
      PATH,
      "sess-1",
      makeCtx("op1"),
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ code: "SUCCESS_PRICES_LISTED", entries: ENTRIES });
    expect(mockEnsureSchema).not.toHaveBeenCalled();
  });

  it("returns an empty entries list when the catalogue holds no rows", async () => {
    mockGetAllPrices.mockResolvedValueOnce([]);
    const res = await handleAgenticPaymentsRoutes(
      getRequest("op1"),
      new URL(`https://agent.internal${PATH}`),
      PATH,
      "sess-1",
      makeCtx("op1"),
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ code: "SUCCESS_PRICES_LISTED", entries: [] });
  });
});
