import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFetchTimeoutError } from "../src/client/apiFetch";
import {
  createTenant,
  TENANT_ADMIN_REQUEST_TIMEOUT_MS,
} from "../src/client/tenantAdminApi";

describe("tenantAdminApi request bound (#4513)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A fetch that never answers unless its signal aborts, like the hung PROD request. */
  function hangUntilAborted(_input: unknown, init?: RequestInit): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  }

  it("surfaces a timeout error when the create request never returns", async () => {
    vi.stubGlobal("fetch", vi.fn(hangUntilAborted));

    const pending = createTenant("acme");
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiFetchTimeoutError);
    await vi.advanceTimersByTimeAsync(TENANT_ADMIN_REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it("creates the tenant when the request answers within the bound", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          tenant: {
            tenantId: "acme",
            adsEnabled: true,
            autoRefreshEnabled: false,
            autoRefreshIntervalS: 15,
            dataProviderId: "etrade",
            brokerId: "etrade",
          },
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", nativeFetch);

    const created = await createTenant("acme");

    expect(created.tenantId).toBe("acme");
    const init = nativeFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("pins the bound at 30 seconds", () => {
    expect(TENANT_ADMIN_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
