import { describe, it, expect, vi, afterEach } from "vitest";
import {
  completeServiceEtradeAuth,
  fetchServiceUserStatus,
  isServiceUserStatus,
  provisionPlatformTier,
  revokeServiceEtradeToken,
  startServiceEtradeAuth,
  ServiceUserApiError,
} from "../src/client/serviceUserApi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const STATUS_OK = {
  ok: true,
  serviceUser: "svc-background",
  serviceInternalUserId: "service:svc-background",
  platform: { membershipId: "m-1", roles: ["member"] },
  tenants: ["primary"],
};

const STATUS_UNPROVISIONED = {
  ...STATUS_OK,
  platform: null,
  tenants: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isServiceUserStatus", () => {
  it("accepts a well-formed status payload", () => {
    expect(isServiceUserStatus(STATUS_OK)).toBe(true);
    expect(isServiceUserStatus(STATUS_UNPROVISIONED)).toBe(true);
  });

  it("accepts a status payload carrying the provisioning checklist (#4988)", () => {
    expect(
      isServiceUserStatus({
        ...STATUS_OK,
        provisioning: {
          complete: false,
          checklist: [
            { id: "brokerage_token_present", label: "Brokerage token is stored for the service identity", status: "fail" },
          ],
          ownerActions: ["Authorize svc-background once via the authorize action."],
        },
      }),
    ).toBe(true);
    expect(
      isServiceUserStatus({
        ...STATUS_OK,
        provisioning: { complete: false, checklist: [{ id: "x", label: "y", status: "maybe" }], ownerActions: [] },
      }),
    ).toBe(false);
  });

  it("rejects a 403 body, null, and malformed payloads", () => {
    expect(isServiceUserStatus({ error: "Forbidden" })).toBe(false);
    expect(isServiceUserStatus(null)).toBe(false);
    expect(isServiceUserStatus({ ...STATUS_OK, platform: { roles: ["member"] } })).toBe(false);
    expect(isServiceUserStatus({ ...STATUS_OK, tenants: "primary" })).toBe(false);
  });
});

describe("fetchServiceUserStatus", () => {
  it("returns the parsed status on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(STATUS_OK)));
    await expect(fetchServiceUserStatus()).resolves.toEqual(STATUS_OK);
  });

  it("throws with the HTTP status on 401 and 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Unauthorized" }, 401)));
    const first = await fetchServiceUserStatus().catch((e) => e);
    expect(first).toBeInstanceOf(ServiceUserApiError);
    expect((first as ServiceUserApiError).status).toBe(401);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "Forbidden: service-user administration requires platform-admin membership." }, 403),
      ),
    );
    const second = await fetchServiceUserStatus().catch((e) => e);
    expect((second as ServiceUserApiError).status).toBe(403);
  });
});

describe("provisionPlatformTier", () => {
  it("reports provisioned on 200 with ok:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, membershipId: "m-9", serviceUser: "svc-background", tier: "platform" }),
      ),
    );
    await expect(provisionPlatformTier()).resolves.toEqual({
      kind: "provisioned",
      membershipId: "m-9",
    });
  });

  it("reports already-provisioned on 200 with alreadyProvisioned:true, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, alreadyProvisioned: true, membershipId: "m-1" }),
      ),
    );
    await expect(provisionPlatformTier()).resolves.toEqual({
      kind: "alreadyProvisioned",
      membershipId: "m-1",
    });
  });

  it("reports queued on 202 with the job id, never success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ jobId: "job-1", status: "queued", statusUrl: "/api/jobs/job-1" }, 202),
      ),
    );
    await expect(provisionPlatformTier()).resolves.toEqual({
      kind: "queued",
      jobId: "job-1",
    });
  });

  it("throws with the HTTP status on 401, 403, and 500", async () => {
    for (const [status, body] of [
      [401, { error: "Unauthorized" }],
      [403, { error: "Forbidden" }],
      [500, { error: "Service-user administration unavailable." }],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, status)));
      const err = await provisionPlatformTier().catch((e) => e);
      expect((err as ServiceUserApiError).status).toBe(status);
    }
  });
});

describe("service-login E*TRADE authorization client (#4988)", () => {
  it("start returns the authorize URL on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          authorizeUrl: "https://us.etrade.com/e/t/etws/authorize?key=k&token=REQTOKEN",
          serviceUser: "svc-background",
        }),
      ),
    );
    await expect(startServiceEtradeAuth()).resolves.toEqual({
      authorizeUrl: "https://us.etrade.com/e/t/etws/authorize?key=k&token=REQTOKEN",
      serviceUser: "svc-background",
    });
  });

  it("start throws with the HTTP status on 403 step-up denial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "Step-up authentication required: please sign in again and retry." }, 403),
      ),
    );
    const err = await startServiceEtradeAuth().catch((e) => e);
    expect((err as ServiceUserApiError).status).toBe(403);
    expect((err as Error).message).toMatch(/step-up/i);
  });

  it("complete resolves on 200 with ok:true and throws on 400", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true }, 200)));
    await expect(completeServiceEtradeAuth("123456")).resolves.toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Failed to exchange verifier" }, 400)),
    );
    const err = await completeServiceEtradeAuth("123456").catch((e) => e);
    expect((err as ServiceUserApiError).status).toBe(400);
  });

  it("revoke returns the deleted flag on 200 and throws on 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, deleted: true }, 200)));
    await expect(revokeServiceEtradeToken()).resolves.toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, deleted: false }, 200)));
    await expect(revokeServiceEtradeToken()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Forbidden" }, 403)));
    const err = await revokeServiceEtradeToken().catch((e) => e);
    expect((err as ServiceUserApiError).status).toBe(403);
  });
});
