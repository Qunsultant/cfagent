// @vitest-environment node
/**
 * Issue #6659 — ONE managed access point for report bodies.
 *
 * Pins:
 *  - 6659-P01 a missing body is a FACT: one GET, outcome `absent`, no retry;
 *  - 6659-P02 absence is remembered: a second read inside the TTL costs ZERO
 *    additional R2 GETs (the storm fix — polling a dead id is free);
 *  - 6659-P03 a transient read error is retried up to the policy's attempts
 *    and then reported `unavailable` with the attempt count;
 *  - 6659-P04 the policy is externalized and clamped: env drives it, an
 *    invalid value falls back to the default instead of disabling protection;
 *  - 6659-P05 a successful write clears the remembered absence immediately.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlobObject, BlobStore } from "../src/services/blobStorePorts";
import {
  clearReportBodyNegativeCache,
  createReportBodyStore,
} from "../src/services/reportBodyStore";
import {
  DEFAULT_REPORT_BODY_STORE_POLICY,
  resolveReportBodyStorePolicy,
} from "../src/config/reportBodyStore";

function fakeStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const state = { gets: 0, puts: 0, deletes: 0, failGets: 0 };
  const store: BlobStore = {
    async get(key: string): Promise<BlobObject | null> {
      state.gets += 1;
      if (state.failGets > 0) {
        state.failGets -= 1;
        throw new Error("transient R2 error");
      }
      const body = objects.get(key);
      if (body === undefined) return null;
      return { bytes: new TextEncoder().encode(body) };
    },
    async put(key: string, value: string | Uint8Array): Promise<void> {
      state.puts += 1;
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
    },
    async delete(key: string): Promise<void> {
      state.deletes += 1;
      objects.delete(key);
    },
    async list() {
      return { keys: [...objects.keys()], truncated: false };
    },
  };
  return { store, state, objects };
}

const sleep = async () => {};

beforeEach(() => {
  clearReportBodyNegativeCache();
});

describe("6659-P01 a missing body is terminal, not a retry signal", () => {
  it("answers absent after exactly one GET", async () => {
    const { store, state } = fakeStore();
    const body = createReportBodyStore({}, { store, sleep });

    const read = await body.read("rep-1", "test");

    expect(read.outcome).toBe("absent");
    expect(state.gets).toBe(1);
  });
});

describe("6659-P02 absence is remembered (the storm fix)", () => {
  it("costs zero further GETs inside the TTL", async () => {
    const { store, state } = fakeStore();
    const body = createReportBodyStore({}, { store, sleep, now: () => 1_000 });

    await body.read("rep-1", "poll");
    const second = await body.read("rep-1", "poll");
    const third = await body.read("rep-1", "poll");

    expect(second.outcome).toBe("absent");
    expect(second.cached).toBe(true);
    expect(third.cached).toBe(true);
    expect(state.gets).toBe(1); // 4 polls, 1 GET
  });

  it("forgets after the TTL and asks again", async () => {
    let now = 1_000;
    const { store, state } = fakeStore();
    const body = createReportBodyStore(
      {},
      { store, sleep, now: () => now, policy: { ...DEFAULT_REPORT_BODY_STORE_POLICY, negativeTtlMs: 100 } },
    );

    await body.read("rep-1", "poll");
    now += 101;
    await body.read("rep-1", "poll");

    expect(state.gets).toBe(2);
  });
});

describe("6659-P03 a transient error is bounded by the policy", () => {
  it("retries to the attempt cap and then reports unavailable", async () => {
    const { store, state } = fakeStore();
    state.failGets = 10;
    const body = createReportBodyStore(
      {},
      { store, sleep, policy: { ...DEFAULT_REPORT_BODY_STORE_POLICY, readAttempts: 3, retryBackoffMs: 1 } },
    );

    const read = await body.read("rep-1", "test");

    expect(read.outcome).toBe("unavailable");
    expect(read.attempts).toBe(3);
    expect(state.gets).toBe(3);
  });
});

describe("6659-P04 the policy is externalized and clamped", () => {
  it("reads the env vars", () => {
    const { policy, errors } = resolveReportBodyStorePolicy({
      REPORT_BODY_READ_ATTEMPTS: "3",
      REPORT_BODY_RETRY_BACKOFF_MS: "0",
      REPORT_BODY_NEGATIVE_TTL_MS: "1234",
      REPORT_BODY_NEGATIVE_MAX_ENTRIES: "10",
    });
    expect(errors).toEqual([]);
    expect(policy).toEqual({
      readAttempts: 3,
      retryBackoffMs: 0,
      negativeTtlMs: 1234,
      negativeMaxEntries: 10,
    });
  });

  it("falls back on an invalid value instead of disabling protection", () => {
    const { policy, errors } = resolveReportBodyStorePolicy({
      REPORT_BODY_READ_ATTEMPTS: "many",
      REPORT_BODY_NEGATIVE_TTL_MS: "-5",
    });
    expect(policy.readAttempts).toBe(DEFAULT_REPORT_BODY_STORE_POLICY.readAttempts);
    expect(policy.negativeTtlMs).toBe(DEFAULT_REPORT_BODY_STORE_POLICY.negativeTtlMs);
    expect(errors.length).toBe(2);
  });
});

describe("6659-P05 a write clears the remembered absence", () => {
  it("serves the body immediately after put", async () => {
    const { store } = fakeStore();
    const body = createReportBodyStore({}, { store, sleep });

    expect((await body.read("rep-1", "poll")).outcome).toBe("absent");
    await body.put("rep-1", '{"ok":true}');
    const after = await body.read("rep-1", "poll");

    expect(after.outcome).toBe("body");
    if (after.outcome === "body") expect(after.body).toBe('{"ok":true}');
  });
});

describe("6659-P06 the callers do not bypass the access point", () => {
  it("scheduledReports.ts creates no blob store of its own", () => {
    // The report-body module is the ONE place allowed to build a store for
    // report bodies; a direct `createBlobStore(` here would reintroduce an
    // unbounded, unmeasured access path.
    const source = readFileSync(
      join(process.cwd(), "src/services/scheduledReports.ts"),
      "utf8",
    );
    expect(source).not.toContain("createBlobStore(");
    expect(source).toContain('from "./reportBodyStore"');
  });
});
