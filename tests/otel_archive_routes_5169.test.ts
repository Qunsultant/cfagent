/**
 * Issue #5169 (observability program #5080) — the R2 archive
 * sub-tab: the HTTP routes (list + serve).
 *
 * TDD Red first: the route module
 * (src/server/routes/otelArchive.ts) does not exist yet, so this
 * file fails at import.
 *
 * Gating follows the IAAA admin pattern exactly (requireAuth →
 * live platform-admin membership, fail-closed): an unauthenticated
 * caller reads 401, a signed-in non-admin reads 403 with a coded
 * OBS-1011 message and a deny audit record. An allowed read is
 * audited BEFORE it is served (audit-before-allow); when the
 * audit write itself fails the route fails closed with 500 —
 * the read is never served unaudited.
 */
import { describe, it, expect, vi } from "vitest";
import {
  OTEL_ARCHIVE_LIST_ROUTE,
  OTEL_ARCHIVE_OBJECT_ROUTE,
  handleOtelArchiveRoutes,
  type OtelArchiveRouteDeps,
} from "../src/server/routes/otelArchive";
import type { BlobStore, BlobObject } from "../src/services/blobStorePorts";
import type { Env, SessionData } from "../src/types";
import type { CreateIaaaAuditEventInput } from "../src/security/iaaaAudit";

class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }
  async get(key: string): Promise<BlobObject | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { bytes };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ keys: string[]; truncated: boolean; cursor?: string }> {
    const keys = [...this.objects.keys()]
      .filter((k) => (options?.prefix ? k.startsWith(options.prefix) : true))
      .sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const limit = options?.limit ?? keys.length;
    const page = keys.slice(start, start + limit);
    const next = start + page.length;
    return {
      keys: page,
      truncated: next < keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {}),
    };
  }
}

const LOG_LINE = JSON.stringify({
  timeUnixNano: "1791158400000000000",
  severityNumber: 9,
  body: { stringValue: "job.run.settled" },
}) + "\n";

const ADMIN_SESSION = {
  githubLogin: "owner",
  internalUserId: "user-owner",
} as unknown as SessionData;

function buildDeps(overrides: Partial<OtelArchiveRouteDeps> = {}): {
  deps: OtelArchiveRouteDeps;
  auditCalls: CreateIaaaAuditEventInput[];
  store: MemoryBlobStore;
} {
  const auditCalls: CreateIaaaAuditEventInput[] = [];
  const store = new MemoryBlobStore();
  const deps: OtelArchiveRouteDeps = {
    requireSession: async () => ADMIN_SESSION,
    isPlatformAdmin: async () => true,
    audit: async (_env, input) => {
      auditCalls.push(input);
      return true;
    },
    blobStore: () => store,
    resolveState: () => ({ archivingEnabled: true, pageSize: 50, maxObjects: 500 }),
    ...overrides,
  };
  return { deps, auditCalls, store };
}

function call(
  path: string,
  deps: OtelArchiveRouteDeps,
  method = "GET",
): Promise<Response | null> {
  const request = new Request(`https://agent.internal${path}`, { method });
  return handleOtelArchiveRoutes(
    request,
    {} as Env,
    new URL(request.url),
    path.split("?")[0],
    deps,
  );
}

describe("handleOtelArchiveRoutes — dispatch", () => {
  it("falls through (null) for unrelated paths", async () => {
    const { deps } = buildDeps();
    expect(await call("/api/otel/v1/logs", deps, "POST")).toBeNull();
    expect(await call("/api/telemetry/summary", deps)).toBeNull();
  });

  it("rejects non-GET methods with 405 and Allow: GET", async () => {
    const { deps } = buildDeps();
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps, "POST");
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET");
  });
});

describe("handleOtelArchiveRoutes — auth + admin gate", () => {
  it("returns 401 for an unauthenticated caller and records no audit", async () => {
    const { deps, auditCalls } = buildDeps({
      requireSession: async () => null,
    });
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps);
    expect(res?.status).toBe(401);
    expect(auditCalls).toHaveLength(0);
  });

  it("returns 403 OBS-1011 for a signed-in non-admin and audits the deny", async () => {
    const { deps, auditCalls } = buildDeps({
      isPlatformAdmin: async () => false,
    });
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps);
    expect(res?.status).toBe(403);
    const body = (await res?.json()) as { error: string; code: string };
    expect(body.code).toBe("OBS-1011");
    expect(body.error).toContain("OBS-1011");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe("observability.archive.list");
    expect(auditCalls[0].decision).toBe("deny");
    expect(auditCalls[0].outcome).toBe("failed");
  });

  it("fails closed with 500 when the allow audit itself fails", async () => {
    const { deps, store } = buildDeps({
      audit: async () => false,
    });
    await store.put("otel-archive/2026-11-17/log-1.jsonl", LOG_LINE);
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps);
    expect(res?.status).toBe(500);
  });
});

describe("handleOtelArchiveRoutes — list", () => {
  it("lists archived objects for a platform admin and audits the allow", async () => {
    const { deps, auditCalls, store } = buildDeps();
    await store.put("otel-archive/2026-11-17/log-1.jsonl", LOG_LINE);
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      archivingEnabled: boolean;
      objects: { key: string; date: string; signal: string; sizeBytes: number }[];
    };
    expect(body.archivingEnabled).toBe(true);
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0].key).toBe("otel-archive/2026-11-17/log-1.jsonl");
    expect(body.objects[0].date).toBe("2026-11-17");
    expect(body.objects[0].signal).toBe("logs");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe("observability.archive.list");
    expect(auditCalls[0].decision).toBe("allow");
    expect(auditCalls[0].outcome).toBe("succeeded");
  });

  it("reports archivingEnabled false when the R2 switch is OFF", async () => {
    const { deps, store } = buildDeps({
      resolveState: () => ({ archivingEnabled: false, pageSize: 50, maxObjects: 500 }),
    });
    await store.put("otel-archive/2026-11-17/log-1.jsonl", LOG_LINE);
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { archivingEnabled: boolean; objects: unknown[] };
    expect(body.archivingEnabled).toBe(false);
    expect(body.objects).toEqual([]);
  });

  it("returns 503 OBS-1008 when R2 is unbound", async () => {
    const { deps } = buildDeps({ blobStore: () => null });
    const res = await call(OTEL_ARCHIVE_LIST_ROUTE, deps);
    expect(res?.status).toBe(503);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe("OBS-1008");
  });
});

describe("handleOtelArchiveRoutes — serve", () => {
  it("serves the raw JSONL for a valid key", async () => {
    const { deps, store } = buildDeps();
    await store.put("otel-archive/2026-11-17/log-1.jsonl", LOG_LINE);
    const res = await call(
      `${OTEL_ARCHIVE_OBJECT_ROUTE}?key=${encodeURIComponent("otel-archive/2026-11-17/log-1.jsonl")}`,
      deps,
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(await res?.text()).toBe(LOG_LINE);
  });

  it("rejects a key outside otel-archive/ with 400 OBS-1009", async () => {
    const { deps, store } = buildDeps();
    await store.put("reports/secret.json", "{}");
    const res = await call(
      `${OTEL_ARCHIVE_OBJECT_ROUTE}?key=${encodeURIComponent("reports/secret.json")}`,
      deps,
    );
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe("OBS-1009");
  });

  it("returns 404 OBS-1010 for a missing object", async () => {
    const { deps } = buildDeps();
    const res = await call(
      `${OTEL_ARCHIVE_OBJECT_ROUTE}?key=${encodeURIComponent("otel-archive/2026-11-17/nope.jsonl")}`,
      deps,
    );
    expect(res?.status).toBe(404);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe("OBS-1010");
  });

  it("audits the serve allow with the object key as the resource", async () => {
    const { deps, auditCalls, store } = buildDeps();
    await store.put("otel-archive/2026-11-17/log-1.jsonl", LOG_LINE);
    await call(
      `${OTEL_ARCHIVE_OBJECT_ROUTE}?key=${encodeURIComponent("otel-archive/2026-11-17/log-1.jsonl")}`,
      deps,
    );
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe("observability.archive.serve");
    expect(auditCalls[0].resourceId).toBe("otel-archive/2026-11-17/log-1.jsonl");
  });
});
