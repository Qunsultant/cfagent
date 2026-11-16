import { describe, it, expect } from "vitest";
import { resolveCaptureUserLogin } from "../src/data/providerCapturePorts";
import { doCaptureRowStore } from "../src/data/doSqliteProviderCaptureAdapter";

describe("Require userLogin on mas_data_captures (#4617)", () => {
  it("resolves non-null userLogin from explicit user, tenant fallback, or system", () => {
    expect(resolveCaptureUserLogin("alice", "tenant-a")).toBe("alice");
    expect(resolveCaptureUserLogin("  bob  ", "tenant-a")).toBe("bob");
    expect(resolveCaptureUserLogin(null, "tenant-a")).toBe("tenant-a");
    expect(resolveCaptureUserLogin("", "tenant-a")).toBe("tenant-a");
    expect(resolveCaptureUserLogin(null, "default")).toBe("system");
    expect(resolveCaptureUserLogin(undefined, undefined)).toBe("system");
  });

  it("writes non-null user_login on every new mas_data_captures INSERT", () => {
    const executed: Array<{ query: string; params: unknown[] }> = [];
    const mockSql = {
      exec(query: string, ...params: unknown[]) {
        executed.push({ query, params });
        return [];
      },
    };
    const rowStore = doCaptureRowStore(mockSql as never);
    rowStore.insertRow({
      id: "cap-4617",
      providerId: "fmp",
      capability: "quotes",
      requestParams: { symbol: "AAPL" },
      runId: "run-4617",
      tenantId: "tenant-acme",
      userLogin: null,
      fetchedAt: "2026-11-16T00:00:00.000Z",
      status: "no_payload",
      rawKind: null,
      rawBlobRef: null,
      rawByteSize: null,
      rawSha256: null,
      normalizedDigest: null,
      retentionClass: "retained-365d",
      failureError: null,
      failureKind: null,
      failureMessage: null,
      createdAt: "2026-11-16T00:00:00.000Z",
    });

    const insert = executed.find((e) => e.query.includes("INSERT INTO mas_data_captures"));
    expect(insert).toBeDefined();
    // user_login is param index 6
    expect(insert!.params[6]).toBe("tenant-acme");
  });
});
