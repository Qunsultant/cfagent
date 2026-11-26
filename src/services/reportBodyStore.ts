/**
 * Issue #6659 — ONE access point for report bodies in R2.
 *
 * #6659 recorded a week of ~12,000 failed GETs on `reports/<id>.json` keys
 * that never existed: the same handful of ids were asked for 200–300 times
 * each, from several callers, because every request performed its own read
 * and **a miss cost another paid-class GET every time**. The key had one
 * home (`reportBodyR2Key`); the access did not.
 *
 * This module is that one home for access. Every report-body read, write,
 * existence check and delete goes through it, so ONE policy applies:
 *
 *   - **a miss is terminal, not a retry signal** — absence returns
 *     `absent` after exactly one GET, never a retry loop;
 *   - **a transient error is retried**, bounded by the policy (attempts +
 *     linear backoff) and then reported as `unavailable`;
 *   - **absence is remembered** for a short TTL, keyed by report id, so a
 *     client polling every few seconds costs ONE GET per TTL window
 *     instead of one per tick. Report ids are content-addressed — a body
 *     can only appear once written — so a short memory cannot go stale in
 *     a harmful way;
 *   - **every call is measured**: caller, outcome, attempt count, whether
 *     the answer came from the negative cache.
 *
 * Policy comes from `src/config/reportBodyStore.ts` (env-driven, clamped);
 * this module holds no literal threshold of its own.
 */
import type { BlobStore } from "./blobStorePorts";
import { blobText } from "./blobStorePorts";
import { createBlobStore } from "./blobStoreR2Adapter";
import { reportBodyR2Key } from "./documentPublish";
import {
  resolveReportBodyStorePolicy,
  type ReportBodyStorePolicy,
} from "../config/reportBodyStore";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/reportBodyStore",
});

/** What a read answered. `absent` is a FACT; `unavailable` is a symptom. */
export type ReportBodyRead =
  | { outcome: "body"; body: string; attempts: number; cached: boolean }
  | { outcome: "absent"; attempts: number; cached: boolean }
  | { outcome: "unavailable"; reason: string; attempts: number; cached: boolean };

export interface ReportBodyStore {
  /** Read the canonical JSON body for a report id. Never throws. */
  read(
    reportId: string,
    caller: string,
    r2Key?: string | null,
  ): Promise<ReportBodyRead>;
  /** Does the object exist? Never throws; an error answers "missing". */
  head(reportId: string, r2Key?: string | null): Promise<"present" | "missing">;
  /** Write (backfill) a body. Throws — the caller decides the fallback. */
  put(reportId: string, body: string, r2Key?: string | null): Promise<void>;
  /** Delete the body. Throws — deletion is the caller's state machine. */
  remove(reportId: string, r2Key?: string | null): Promise<void>;
  /** The policy in force, for diagnostics. */
  policy(): ReportBodyStorePolicy;
}

/**
 * Per-isolate negative cache. Module scope is deliberate: a Worker isolate
 * serves many requests, and the whole point is to survive across them. It
 * is not a correctness store — losing it on eviction only costs a GET.
 */
const absentUntil = new Map<string, number>();

function rememberAbsent(reportId: string, policy: ReportBodyStorePolicy, now: number): void {
  if (policy.negativeTtlMs <= 0 || policy.negativeMaxEntries <= 0) return;
  // Evict expired first, then oldest insertion, so the map stays bounded.
  for (const [id, expiresAt] of absentUntil) {
    if (expiresAt <= now) absentUntil.delete(id);
  }
  while (absentUntil.size >= policy.negativeMaxEntries) {
    const oldest = absentUntil.keys().next();
    if (oldest.done) break;
    absentUntil.delete(oldest.value);
  }
  absentUntil.set(reportId, now + policy.negativeTtlMs);
}

function isRememberedAbsent(reportId: string, now: number): boolean {
  const expiresAt = absentUntil.get(reportId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    absentUntil.delete(reportId);
    return false;
  }
  return true;
}

/** Test/ops seam: forget one id, or everything. Never used in a request path. */
export function clearReportBodyNegativeCache(reportId?: string): void {
  if (reportId === undefined) absentUntil.clear();
  else absentUntil.delete(reportId);
}

export interface CreateReportBodyStoreOptions {
  /** Inject the blob store (tests); default is the R2 adapter for `env`. */
  store?: BlobStore | null;
  /** Inject the policy; default is the env-resolved one. */
  policy?: ReportBodyStorePolicy;
  /** Inject the clock (tests). */
  now?: () => number;
  /** Sleep seam so tests need no real delay. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the access point for one env. Cheap enough to call per request: it
 * closes over the shared negative cache and resolves the policy each time
 * (env can change between requests in `wrangler dev`).
 */
export function createReportBodyStore(
  env: { REPORTS_BUCKET?: R2Bucket } | undefined | null,
  opts?: CreateReportBodyStoreOptions,
): ReportBodyStore {
  const envRecord = (env ?? {}) as Record<string, string | undefined>;
  const { policy: envPolicy, errors } = resolveReportBodyStorePolicy(envRecord);
  if (errors.length > 0) {
    structuredLog.warn("report_body_store.policy_invalid", {
      message: `[report-body-store] invalid policy value(s), defaults applied: ${errors.join("; ")}`,
      errors,
    });
  }
  const policy = opts?.policy ?? envPolicy;
  const store = opts?.store !== undefined ? opts.store : createBlobStore(env ?? {});
  const now = opts?.now ?? (() => Date.now());
  const sleep = opts?.sleep ?? defaultSleep;

  const unavailable = (
    reason: string,
    attempts: number,
    cached: boolean,
    caller: string,
    reportId: string,
  ): ReportBodyRead => {
    structuredLog.error("report_body_store.read_unavailable", {
      message: `[report-body-store] read unavailable for report ${reportId} (caller ${caller}, attempts ${attempts}): ${reason}`,
      reportId,
      caller,
      attempts,
      error: reason,
    });
    return { outcome: "unavailable", reason, attempts, cached };
  };

  return {
    policy: () => policy,

    async read(
      reportId: string,
      caller: string,
      r2Key?: string | null,
    ): Promise<ReportBodyRead> {
      const key = r2Key ?? reportBodyR2Key(reportId);
      const cached = isRememberedAbsent(reportId, now());
      if (cached) {
        // The storm fix: a remembered absence costs NO R2 GET.
        structuredLog.info("report_body_store.read", {
          message: `[report-body-store] ${caller} read ${reportId}: absent (negative cache)`,
          reportId,
          caller,
          outcome: "absent",
          attempts: 0,
          cached: true,
        });
        return { outcome: "absent", attempts: 0, cached: true };
      }
      if (!store) return unavailable("REPORTS_BUCKET is not bound", 0, false, caller, reportId);

      let lastError = "";
      for (let attempt = 1; attempt <= policy.readAttempts; attempt += 1) {
        try {
          const obj = await store.get(key);
          if (!obj) {
            rememberAbsent(reportId, policy, now());
            structuredLog.info("report_body_store.read", {
              message: `[report-body-store] ${caller} read ${reportId}: absent`,
              reportId,
              caller,
              outcome: "absent",
              attempts: attempt,
              cached: false,
            });
            return { outcome: "absent", attempts: attempt, cached: false };
          }
          structuredLog.info("report_body_store.read", {
            message: `[report-body-store] ${caller} read ${reportId}: body`,
            reportId,
            caller,
            outcome: "body",
            attempts: attempt,
            cached: false,
          });
          return { outcome: "body", body: blobText(obj), attempts: attempt, cached: false };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt < policy.readAttempts && policy.retryBackoffMs > 0) {
            await sleep(policy.retryBackoffMs * attempt);
          }
        }
      }
      return unavailable(lastError || "unknown read error", policy.readAttempts, false, caller, reportId);
    },

    async head(reportId: string, r2Key?: string | null): Promise<"present" | "missing"> {
      if (isRememberedAbsent(reportId, now())) return "missing";
      if (!store) return "missing";
      try {
        const obj = await store.get(r2Key ?? reportBodyR2Key(reportId));
        if (!obj) {
          rememberAbsent(reportId, policy, now());
          return "missing";
        }
        return "present";
      } catch {
        return "missing";
      }
    },

    async put(reportId: string, body: string, r2Key?: string | null): Promise<void> {
      if (!store) throw new Error("REPORTS_BUCKET is not bound");
      await store.put(r2Key ?? reportBodyR2Key(reportId), body, {
        contentType: "application/json",
      });
      // A successful write makes a remembered absence wrong immediately.
      absentUntil.delete(reportId);
    },

    async remove(reportId: string, r2Key?: string | null): Promise<void> {
      if (!store) throw new Error("REPORTS_BUCKET is not bound");
      await store.delete(r2Key ?? reportBodyR2Key(reportId));
      absentUntil.delete(reportId);
    },
  };
}
