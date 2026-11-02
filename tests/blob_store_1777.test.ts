import { describe, it, expect } from "vitest";
import { createBlobStore } from "../src/services/blobStoreR2Adapter";
import type { BlobStore } from "../src/services/blobStorePorts";
import { putReportPdf, getReportPdf } from "../src/services/reportBlobStore";
import { putKnowledgeDoc, getKnowledgeDoc } from "../src/services/knowledgeCorpus";
import {
  putCaptureBlob,
  getCaptureBlob,
} from "../src/data/providerCapturePorts";
import { resolveCanonicalReportBody } from "../src/services/scheduledReports";
import { runCorpusIntegrityCheck } from "../src/services/corpusSync";

/**
 * #1777 (Adapter S3): one BlobStore port, Cloudflare R2 as the single
 * adapter module. These pins cover put/get/delete/list through the
 * port for corpus docs, canonical report bodies, and capture blobs —
 * plus the preserved caller contracts (corpus throws when unbound,
 * report PDFs and captures keep their legacy DO-storage fallback).
 */

function makeStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    raw: map,
  };
}

interface FakeObject {
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

function makeFakeBucket() {
  const objects = new Map<string, FakeObject>();
  const puts: Array<{ key: string; options?: unknown }> = [];
  return {
    objects,
    puts,
    async put(key: string, value: Uint8Array | string, options?: Record<string, unknown>) {
      const bytes =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      objects.set(key, {
        bytes,
        contentType: (options?.httpMetadata as { contentType?: string } | undefined)
          ?.contentType,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      });
      puts.push({ key, options });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        async arrayBuffer() {
          return obj.bytes.buffer.slice(
            obj.bytes.byteOffset,
            obj.bytes.byteOffset + obj.bytes.byteLength
          ) as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(obj.bytes);
        },
        httpMetadata: obj.contentType ? { contentType: obj.contentType } : {},
        customMetadata: obj.customMetadata ?? {},
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()]
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map((key) => ({ key })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

function makeInMemoryBlobStore(): BlobStore {
  const objects = new Map<string, FakeObject>();
  return {
    async put(key, value, options) {
      objects.set(key, {
        bytes: typeof value === "string" ? new TextEncoder().encode(value) : value,
        contentType: options?.contentType,
        customMetadata: options?.customMetadata,
      });
    },
    async get(key) {
      const obj = objects.get(key);
      return obj ? { bytes: obj.bytes, contentType: obj.contentType, customMetadata: obj.customMetadata } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(options) {
      const keys = [...objects.keys()]
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      return {
        keys: page,
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

describe("#1777 BlobStore port (R2 adapter)", () => {
  it("returns null when REPORTS_BUCKET is unbound", () => {
    expect(createBlobStore({})).toBeNull();
    expect(createBlobStore({ REPORTS_BUCKET: undefined })).toBeNull();
  });

  it("round-trips put/get with contentType + customMetadata, null on missing", async () => {
    const bucket = makeFakeBucket();
    const store = createBlobStore({ REPORTS_BUCKET: bucket as never })!;
    expect(store).not.toBeNull();
    await store.put("reports/a.json", '{"ok":true}', {
      contentType: "application/json",
      customMetadata: { fileName: "a.json" },
    });
    const got = await store.get("reports/a.json");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.bytes)).toBe('{"ok":true}');
    expect(got!.contentType).toBe("application/json");
    expect(got!.customMetadata?.fileName).toBe("a.json");
    expect(await store.get("reports/missing.json")).toBeNull();
  });

  it("deletes, and lists with prefix + cursor pagination", async () => {
    const bucket = makeFakeBucket();
    const store = createBlobStore({ REPORTS_BUCKET: bucket as never })!;
    await store.put("reports/1.json", "1");
    await store.put("reports/2.json", "2");
    await store.put("other/3.json", "3");
    await store.delete("reports/1.json");
    expect(await store.get("reports/1.json")).toBeNull();
    const page1 = await store.list({ prefix: "reports/", limit: 1 });
    expect(page1.keys).toEqual(["reports/2.json"]);
    expect(page1.truncated).toBe(false);
    const all = await store.list({ prefix: "reports/" });
    expect(all.keys).toEqual(["reports/2.json"]);
    const p1 = await store.list({ limit: 1 });
    expect(p1.truncated).toBe(true);
    expect(p1.cursor).toBeDefined();
    const p2 = await store.list({ cursor: p1.cursor });
    expect([...p1.keys, ...p2.keys].sort()).toEqual(["other/3.json", "reports/2.json"]);
  });
});

describe("#1777 corpus docs through the port", () => {
  it("ingests and reads a corpus doc via R2", async () => {
    const bucket = makeFakeBucket();
    const storage = makeStorage();
    const env = { REPORTS_BUCKET: bucket as never };
    const bytes = new TextEncoder().encode("corpus bytes");
    const { meta, idempotent } = await putKnowledgeDoc(env, storage, "owner", {
      title: "Doc",
      category: "market_education",
      sourceUrl: "https://example.com/doc",
      bytes,
    });
    expect(idempotent).toBe(false);
    expect(meta.r2Key).toBeDefined();
    const got = await getKnowledgeDoc(env, storage, "owner", `knowledge:market_education:${meta.contentHash}`);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.bytes)).toBe("corpus bytes");
  });

  it("still throws when the bucket is unbound (contract preserved)", async () => {
    const storage = makeStorage();
    const bytes = new TextEncoder().encode("corpus bytes");
    await expect(
      putKnowledgeDoc({}, storage, "owner", {
        title: "Doc",
        category: "market_education",
        sourceUrl: "https://example.com/doc",
        bytes,
      })
    ).rejects.toThrow("REPORTS_BUCKET is not bound");
  });
});

describe("#1777 canonical report bodies through the port", () => {
  it("resolves an R2-backed body, and null when unbound or missing", async () => {
    const bucket = makeFakeBucket();
    const env = { REPORTS_BUCKET: bucket as never };
    await bucket.put("reports/r1.json", '{"title":"t"}');
    const hit = {
      id: "r1",
      body: "",
      bodyR2Key: "reports/r1.json",
    } as Parameters<typeof resolveCanonicalReportBody>[1];
    expect(await resolveCanonicalReportBody(env, hit)).toBe('{"title":"t"}');
    expect(await resolveCanonicalReportBody({}, hit)).toBeNull();
    expect(
      await resolveCanonicalReportBody(env, { ...hit, bodyR2Key: "reports/nope.json" })
    ).toBeNull();
  });
});

describe("#1777 capture blobs through the port", () => {
  it("round-trips via R2 and keeps the legacy base64 fallback when unbound", async () => {
    const bucket = makeFakeBucket();
    const storage = makeStorage();
    const env = { REPORTS_BUCKET: bucket as never };
    const bytes = new TextEncoder().encode('{"payload":1}');
    await putCaptureBlob(env, storage, "capture:k1", bytes);
    const got = await getCaptureBlob(env, storage, "capture:k1");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe('{"payload":1}');
    // Legacy path: no bucket, DO-storage base64 only.
    const legacyStorage = makeStorage();
    await putCaptureBlob({}, legacyStorage, "capture:k2", bytes);
    const legacyMeta = legacyStorage.raw.get("capture:k2") as { base64?: string; r2Key?: string };
    expect(legacyMeta.base64).toBeDefined();
    expect(legacyMeta.r2Key).toBeUndefined();
    const legacyGot = await getCaptureBlob({}, legacyStorage, "capture:k2");
    expect(legacyGot).not.toBeNull();
    expect(new TextDecoder().decode(legacyGot!)).toBe('{"payload":1}');
  });
});

describe("#1777 report PDFs through the generalised port", () => {
  it("stores a pointer in DO storage and reads back from R2", async () => {
    const bucket = makeFakeBucket();
    const storage = makeStorage();
    const env = { REPORTS_BUCKET: bucket as never };
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await putReportPdf(env, storage, "screener:pdf:abc", "a.pdf", bytes);
    const meta = storage.raw.get("screener:pdf:abc") as { r2Key?: string; base64?: string };
    expect(meta.r2Key).toBe("stocks/pdf/abc");
    expect(meta.base64).toBeUndefined();
    const got = await getReportPdf(env, storage, "screener:pdf:abc");
    expect(got).not.toBeNull();
    expect(got!.fileName).toBe("a.pdf");
    expect(Array.from(got!.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});

describe("#1777 corpus integrity through the port", () => {
  it("lists and reads via a BlobStore (no raw bucket shape)", async () => {
    const store = makeInMemoryBlobStore();
    const bytes = new TextEncoder().encode("agreeing bytes");
    const { sha256Hex } = await import("../src/services/knowledgeCorpus");
    const h = await sha256Hex(bytes);
    await store.put(`knowledge/options_disclosure/${h}`, bytes);
    const report = await runCorpusIntegrityCheck({
      manifest: [{ title: "doc", category: "options_disclosure", sha256: h, fetchStatus: "verified" }],
      recordStore: {
        async get<T>(key: string) {
          if (key === `knowledge:options_disclosure:${h}`) {
            return { contentHash: h } as T;
          }
          return undefined;
        },
      },
      bucket: store,
    });
    expect(report.ok).toBe(true);
    expect(report.entries).toEqual([
      {
        title: "doc",
        category: "options_disclosure",
        bucketKey: `knowledge/options_disclosure/${h}`,
        status: "present",
      },
    ]);
  });
});
