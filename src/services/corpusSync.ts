/**
 * Issue #1169 S4-4: schedulable corpus sync + downloadable export
 * (server half — the Download buttons live in src/client/search/tabs/).
 *
 * Two legs, both honest about what they could and could not check:
 *
 * 1. INTEGRITY (unconditional, read-only): the seed manifest
 *    (docs/knowledge-corpus-seed-manifest.json) checked against the
 *    DO-record store (the corpus module's get/put store — it has NO
 *    key listing, so the record set is exactly the manifest keys
 *    plus whatever R2 lists) and a paginated R2 `bucket.list` on the
 *    `knowledge/` prefix. All three lists report BUCKET keys
 *    (knowledge/<category>/<sha256>), uniformly:
 *    - missing: a manifest key with no DO record, or a DO record
 *      whose R2 object is absent from the listing.
 *    - mismatched: an R2 object whose bytes fail the hash check
 *      against its DO record (the corpus module's own SHA-256
 *      scheme — sha256Hex + the recorded contentHash — never a
 *      new scheme), or a record whose hash differs from the
 *      manifest (via verifySeedManifest).
 *    - extra: an R2 object under knowledge/ with no DO record
 *      (including keys that do not parse as corpus keys — no
 *      record can map to them).
 *    KNOWN BLIND SPOT (disclosed, not papered over): a DO record
 *    that is NOT in the seed manifest and whose R2 object is gone
 *    is undetectable — the DO store has no key listing, so nothing
 *    enumerates it. Only manifest records and listed objects are
 *    checked.
 *    Inputs unavailable (no bucket binding, or a mid-check throw)
 *    produce ok:false + a reason and EMPTY lists — never
 *    fabricated findings.
 *
 * 2. CORPUS INDEX BRIDGE (#3345; the S4-5 bridge backfill, pulled
 *    forward): the corpus items-API backfill
 *    (runCorpusAiSearchIndexBackfill in corpusAiSearchIndex.ts),
 *    injected exactly like the former reports leg — the sync comes
 *    to mean "bucket bytes AND index items both reflect the
 *    canonical corpus", with per-item indexing state reported on
 *    the result. The leg uploads through the #2246 executor under
 *    `corpus:<key>` ids, flag-gated by
 *    AI_SEARCH_CORPUS_INDEXING_ENABLED; without the injected leg
 *    the result reports it skipped, never fabricated.
 *
 * Issue #3527 S4 (unbundle): the REPORT BACKFILL leg that rode
 * this sync until S4 (the S4-1 canonical-index sweep of
 * mas_reports) is reports machinery, not corpus machinery — it
 * left the bundle. The sweep now lives in reportSemanticIndex.ts
 * (runCanonicalIndexBackfillAll) and runs from its own route
 * (POST /trading/reports/index-backfill-sweep) + tick rider under
 * its own weekly guard and marker
 * (reports_index_backfill_last_run). This sync keeps exactly the
 * two corpus legs above.
 *
 * SCHEDULE: rides the existing every-30-minutes tick (server.ts
 * scheduled(), same Workers Free ceiling constraint as
 * #354/#705/#754 — NO new cron trigger, NO wrangler.jsonc change).
 * The weekly guard below
 * is pure (date/key logic only, unit-testable); the route owns the
 * durable marker write (mas_settings key `corpus_sync_last_run`,
 * via the screeningFlags settingRead/WriteFromSql idiom), written
 * ONLY when the integrity leg actually executed (completed) — a
 * run that could not check (no bucket) leaves the marker alone so
 * the next tick retries.
 *
 * The sync NEVER fails a user request: it is scheduled work plus a
 * read-only route, best-effort throughout — runCorpusSync never
 * throws, and the route returns the integrity report itself (200)
 * even when the check could not run (ok:false + reason).
 */

import {
  verifySeedManifest,
  sha256Hex,
  parseKnowledgeBucketKey,
  type SeedManifestEntry,
  type KnowledgeDocMeta,
} from "./knowledgeCorpus";
import { r2KeyForStorageKey } from "./reportBlobStore";
import type { BlobStore } from "./blobStorePorts";
import type { CorpusIndexBackfillOutcome } from "./corpusAiSearchIndex";

/** Durable marker key for the last completed corpus sync, in mas_settings. */
export const CORPUS_SYNC_LAST_RUN_KEY = "corpus_sync_last_run";

/** Weekly cadence: fire when >= 7 days since the last completed run. */
export const CORPUS_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type CorpusSyncDecision =
  | { fire: true }
  | { fire: false; reason: "too-soon"; lastFiredAt: string };

/**
 * Pure weekly fire/no-fire decision (no SDK imports, unit-testable).
 * Never fired -> fire. Unparseable marker -> fire (a corrupt marker
 * self-heals on the next completed run; the sync is read-only +
 * idempotent, so firing is harmless). Otherwise fire only when the
 * elapsed time reaches the full 7-day interval.
 */
export function shouldFireCorpusSyncTick(
  now: Date,
  lastFiredAtIso: string | null
): CorpusSyncDecision {
  if (lastFiredAtIso === null) return { fire: true };
  const last = Date.parse(lastFiredAtIso);
  if (Number.isNaN(last)) return { fire: true };
  if (now.getTime() - last >= CORPUS_SYNC_INTERVAL_MS) return { fire: true };
  return { fire: false, reason: "too-soon", lastFiredAt: lastFiredAtIso };
}

/** Per-manifest-entry status, derived from the same check that builds
 * the three key lists (issue #1169, knowledge UI). `present` = record
 * and object agree; `missing` = expected key absent (no record, or
 * record with no object); `mismatched` = bytes or record hash fail
 * the check — mismatched wins over missing when both apply (a record
 * that disagrees with the manifest is wrong even if its object is
 * also gone; re-ingest fixes both). `not-ingested` = the manifest
 * row carries no recorded hash (e.g. a fetch-blocked entry), so it
 * was never ingested and there is nothing to check; forcing it into
 * `missing` would misstate the check. `bucketKey` is null exactly
 * for `not-ingested` entries. */
export interface CorpusManifestEntryStatus {
  title: string;
  category: string;
  bucketKey: string | null;
  status: "present" | "missing" | "mismatched" | "not-ingested";
}

export interface CorpusIntegrityReport {
  ok: boolean;
  /** Bucket keys (knowledge/<category>/<sha256>) with no record or no object. */
  missing: string[];
  /** Bucket keys whose bytes or record hash fail the hash check. */
  mismatched: string[];
  /** Bucket keys under knowledge/ with no DO record. */
  extra: string[];
  checkedAt: string;
  /** One status object per manifest entry, in manifest order.
   * Additive (knowledge UI): old fields keep their exact meaning.
   * Empty with the reason on paths where the check could not run. */
  entries: CorpusManifestEntryStatus[];
  /** Present ONLY when the check could not run (inputs unavailable). */
  reason?: string;
}

/** Minimal DO-record-store shape (the corpus module's BlobStorage get). */
export interface CorpusRecordStore {
  get<T>(key: string): Promise<T | undefined>;
}

/** Issue #1777 (Adapter S3): the integrity leg reads through the one
 * BlobStore port — the bespoke CorpusBucket shape is retired in
 * favour of BlobStore (superseded by src/services/blobStorePorts.ts).
 * The dep field keeps its `bucket` name so route call sites are
 * unchanged apart from passing createBlobStore(env). */
export interface CorpusIntegrityDeps {
  manifest: readonly SeedManifestEntry[];
  recordStore: CorpusRecordStore;
  bucket?: BlobStore | null;
}

function shaPrefix(bucketKey: string): string {
  const parts = bucketKey.split("/");
  return parts.length > 0 ? parts[parts.length - 1].slice(0, 12) : bucketKey;
}

export async function runCorpusIntegrityCheck(
  deps: CorpusIntegrityDeps
): Promise<CorpusIntegrityReport> {
  const checkedAt = new Date().toISOString();
  const bucket = deps.bucket ?? null;
  if (!bucket) {
    return {
      ok: false,
      missing: [],
      mismatched: [],
      extra: [],
      checkedAt,
      entries: [],
      reason:
        "REPORTS_BUCKET is not bound; corpus integrity cannot be verified without the screener bucket.",
    };
  }
  try {
    // The DO store has no key listing: the record set for manifest
    // keys is built by direct lookup, one get per hashed entry.
    const stored = new Map<string, { contentHash: string }>();
    for (const entry of deps.manifest) {
      if (!entry.sha256) continue;
      const key = `knowledge:${entry.category}:${entry.sha256}`;
      const record = await deps.recordStore.get<KnowledgeDocMeta>(key);
      if (record) stored.set(key, { contentHash: record.contentHash });
    }
    const seedReport = verifySeedManifest(deps.manifest, stored);
    const missing = new Set<string>();
    const mismatched = new Set<string>();
    const extra = new Set<string>();
    for (const r of seedReport.results) {
      if (!r.expectedSha256) continue;
      const bucketKey = r2KeyForStorageKey(
        `knowledge:${r.category}:${r.expectedSha256}`
      );
      if (r.status === "missing") missing.add(bucketKey);
      else if (r.status === "mismatch") mismatched.add(bucketKey);
    }
    // Paginated blob listing over the whole knowledge/ prefix.
    const listed = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: "knowledge/", cursor });
      for (const key of page.keys) listed.add(key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    // Manifest records whose object is absent from the listing.
    for (const entry of deps.manifest) {
      if (!entry.sha256) continue;
      const storageKey = `knowledge:${entry.category}:${entry.sha256}`;
      if (!stored.has(storageKey)) continue;
      const bucketKey = r2KeyForStorageKey(storageKey);
      if (!listed.has(bucketKey)) missing.add(bucketKey);
    }
    // Every listed object: record check + byte hash check.
    for (const key of listed) {
      const parsed = parseKnowledgeBucketKey(key);
      if (!parsed) {
        extra.add(key);
        continue;
      }
      const storageKey = `knowledge:${parsed.category}:${parsed.sha256}`;
      const record = await deps.recordStore.get<KnowledgeDocMeta>(storageKey);
      if (!record) {
        extra.add(key);
        continue;
      }
      const obj = await bucket.get(key);
      if (!obj) {
        missing.add(key);
        continue;
      }
      const bytes = obj.bytes;
      if ((await sha256Hex(bytes)) !== record.contentHash) {
        mismatched.add(key);
      }
    }
    // Per-entry status from the same sets, in manifest order.
    const entries: CorpusManifestEntryStatus[] = deps.manifest.map((entry) => {
      if (!entry.sha256) {
        return { title: entry.title, category: entry.category, bucketKey: null, status: "not-ingested" };
      }
      const bucketKey = r2KeyForStorageKey(`knowledge:${entry.category}:${entry.sha256}`);
      const status = mismatched.has(bucketKey)
        ? "mismatched"
        : missing.has(bucketKey)
          ? "missing"
          : "present";
      return { title: entry.title, category: entry.category, bucketKey, status };
    });
    const report: CorpusIntegrityReport = {
      ok: missing.size === 0 && mismatched.size === 0 && extra.size === 0,
      missing: [...missing],
      mismatched: [...mismatched],
      extra: [...extra],
      checkedAt,
      entries,
    };
    if (!report.ok) {
      console.warn(
        `[corpusSync] integrity ok=false missing=${report.missing.map(shaPrefix).join(",")} mismatched=${report.mismatched.map(shaPrefix).join(",")} extra=${report.extra.map(shaPrefix).join(",")}`
      );
    } else {
      console.info(`[corpusSync] integrity ok=true checked=${listed.size}`);
    }
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[corpusSync] integrity check failed: ${message}`);
    return {
      ok: false,
      missing: [],
      mismatched: [],
      extra: [],
      checkedAt,
      entries: [],
      reason: `Corpus integrity check failed: ${message}`,
    };
  }
}

export interface CorpusSyncDeps extends CorpusIntegrityDeps {
  /** Issue #3345: production passes
   * () => runCorpusAiSearchIndexBackfill(env, {...}). */
  corpusIndex?: () => Promise<CorpusIndexBackfillOutcome>;
}

/** The corpus-index leg's outcome on the sync result: the backfill
 * outcome, or a skipped outcome (no leg supplied) / a failed
 * outcome with the reason (the leg threw) — never fabricated. */
export interface CorpusSyncIndexOutcome extends CorpusIndexBackfillOutcome {
  /** True only when no corpus-index leg was supplied. */
  skipped?: boolean;
}

export interface CorpusSyncResult {
  integrity: CorpusIntegrityReport;
  corpusIndex: CorpusSyncIndexOutcome;
  /** True only when the integrity leg actually executed. */
  completed: boolean;
  ranAt: string;
}

/**
 * Run the two corpus sync legs (integrity + corpus index bridge).
 * Never throws: a leg that cannot run reports honestly (integrity
 * reason / corpus-index skipped-or-failed outcome) instead of
 * failing the tick.
 */
export async function runCorpusSync(
  deps: CorpusSyncDeps
): Promise<CorpusSyncResult> {
  const ranAt = new Date().toISOString();
  const integrity = await runCorpusIntegrityCheck(deps);
  let corpusIndex: CorpusSyncIndexOutcome;
  if (!deps.corpusIndex) {
    corpusIndex = {
      items: [],
      indexed: 0,
      notConfigured: 0,
      failed: 0,
      skipped: true,
      reason: "No corpus index leg supplied; corpus indexing skipped.",
    };
  } else {
    try {
      corpusIndex = await deps.corpusIndex();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      corpusIndex = {
        items: [],
        indexed: 0,
        notConfigured: 0,
        failed: 0,
        reason: `Corpus index leg failed: ${message}`,
      };
    }
  }
  return {
    integrity,
    corpusIndex,
    completed: integrity.reason === undefined,
    ranAt,
  };
}
