/**
 * Issue #2869 slice 3 (under #2764) — the tabular-aware stage
 * consumer for the chain generate leg.
 *
 * The gap this closes: the analysis-done consumer
 * (stageReportConsumer.consumeAnalysisDone) is PDF-only by
 * contract — its generate is the one generation module's PDF
 * leg (runReportPipeline). The chain's tabular generate shards
 * (src/services/shardExecutors.ts generateTabular) therefore
 * ran outside any consumer: they read the persisted assemble
 * dataset and generated XLSX/CSV directly. That is now routed
 * through this consumer, with the same discipline as the
 * analysis-done consumer, adapted to one format at a time:
 *
 *   1. Input is a PERSISTED dataset only. The caller reads it
 *      from the chain's persisted shard results (siblingResult
 *      over completed assemble rows) and hands it here; this
 *      module never fetches, never quotes, never re-runs a
 *      screen. A missing dataset is refused loudly (thrown),
 *      never fabricated.
 *   2. Exactly-once EFFECT per format: the consumer claims
 *      `${runId}::generate:${format}` before generating (the
 *      injected claims store; production passes the durable
 *      SQL-backed stage claims, the same mas_stage_claims
 *      family as the analysis-done consumer). A redelivery
 *      for an already-claimed key returns duplicate-suppressed
 *      without regenerating. Release-on-failure: when
 *      generation or storage itself throws, the claim is
 *      released (when the store supports delete) — a failed
 *      generation has no effect to deduplicate, so a retry
 *      must be allowed to generate.
 *   3. Generation and storage are INJECTED (generate, store):
 *      production passes the one generation module's tabular
 *      generator (generateStockTabularBytes for stock, the
 *      options generators for options) and the report blob
 *      store (putReportPdf). This module never names a
 *      provider, a feed, or a second generation path.
 *   4. Failure discipline is the CALLER's, unchanged:
 *      this helper throws on failure, exactly as the direct
 *      leg did, so the shard executor keeps its existing
 *      per-domain rule — stock chains throw (chain stops),
 *      options chains record a per-format failed outcome.
 *      Poison (wrong format, missing runId/dataset) is
 *      dead-lettered, never retried into validity.
 *
 * One caller note: the chain caller passes NO claims
 * store, deliberately — the chain's own shard job row is
 * that leg's exactly-once guard (a completed generate
 * shard is never re-executed, and a crashed in-flight
 * shard must be allowed to regenerate; a pre-generation
 * claim would suppress that recovery with no key to hand
 * the store shard). The claim path below is exercised by
 * this module's own tests and remains available to
 * callers whose retry can recover a key.
 *
 * Scope, stated plainly: this covers the chain tabular legs
 * (XLSX/CSV generate shards). The chain PDF leg stays with
 * its single owner, runReportPipeline (#914) — routing it
 * through the analysis-done consumer would conflate a
 * per-shard format outcome with the per-run analysis-done
 * claim and duplicate the pipeline owner, so it is not
 * moved here. The monolithic tabular legs likewise stay in
 * the one generation module (stockReportArtifacts, G4),
 * which owns their latest pointers and per-format status
 * language; the chain leg was the gap this slice closes.
 * No second queue, recorder, catalog, or port layer: the
 * chain's own stage-runner dispatch (mas_async_jobs rows)
 * remains the transport for chain shards, and this consumer
 * is the generation seam inside it — the same consumer
 * family as slices 1–2, not a parallel pipeline.
 */

import type { StageClaimStore } from "./stageReportConsumer";
import { formatStageMessage } from "./stageConfig";

export type TabularFormat = "xlsx" | "csv";

export type TabularConsumeStatus =
  | "generated"
  | "duplicate-suppressed"
  | "dead-lettered";

export interface TabularConsumeResult {
  status: TabularConsumeStatus;
  /** Present on generated: the stored blob key and file name. */
  key?: string;
  fileName?: string;
  /** Present on dead-lettered: why, loudly. */
  reason?: string;
}

export interface TabularGenerateFn {
  (input: {
    format: TabularFormat;
    dataset: unknown;
  }): Promise<{ fileName: string; bytes: Uint8Array }>;
}

export interface TabularStoreFn {
  (input: {
    key: string;
    fileName: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void>;
}

/** The blob-key family for one format of one chain run. */
export function tabularBlobKey(
  format: TabularFormat,
  prefix: string,
): string {
  return `${prefix}${crypto.randomUUID().slice(0, 8)}`;
}

/** The exactly-once-effect key for one format of one chain run. */
export function tabularClaimKey(
  runId: string,
  format: TabularFormat,
): string {
  return `${runId}::generate:${format}`;
}

/**
 * Consume one chain tabular generate shard, from persisted
 * data only. Loud failure, never silent drop: poison is
 * dead-lettered with a reason; a missing dataset throws
 * (the caller must handle it — the consumer never
 * fabricates a dataset to cover a missing assemble shard);
 * a generation/storage throw releases the claim and
 * propagates, so the caller's per-domain rule applies.
 */
export async function consumeTabularGenerate(args: {
  runId: string;
  format: TabularFormat;
  /** The persisted assemble dataset — never live data. */
  dataset: unknown;
  /** Blob-key prefix, e.g. "screener:xlsx:" (caller-owned). */
  keyPrefix: string;
  claims?: StageClaimStore;
  generate: TabularGenerateFn;
  store: TabularStoreFn;
  deadLetter?: (info: {
    runId: string;
    format: TabularFormat;
    reason: string;
  }) => Promise<void> | void;
}): Promise<TabularConsumeResult> {
  const { runId, format } = args;
  const deadLetter = async (
    reason: string,
  ): Promise<TabularConsumeResult> => {
    if (args.deadLetter) {
      await args.deadLetter({ runId, format, reason });
    }
    return { status: "dead-lettered", reason };
  };
  // Poison: wrong format, or no reference to a run.
  if (format !== "xlsx" && format !== "csv") {
    return deadLetter(
      formatStageMessage("TABULAR_WRONG_FORMAT", `format "${String(format)}" is not xlsx or csv; refusing without retry`),
    );
  }
  if (!runId?.trim()) {
    return deadLetter(
      formatStageMessage("TABULAR_MISSING_RUN", "runId missing; refusing without retry"),
    );
  }
  // Exactly-once effect: redelivery of a claimed key suppresses.
  const claimKey = tabularClaimKey(runId, format);
  const claims = args.claims;
  if (claims) {
    if (claims.has(claimKey)) {
      return { status: "duplicate-suppressed" };
    }
    claims.add(claimKey);
  }
  // Missing persisted dataset: refuse loudly, never fabricate.
  if (!args.dataset || typeof args.dataset !== "object") {
    claims?.delete?.(claimKey);
    throw new Error(
      `tabular consumer refused: persisted assemble dataset for run ${runId} (${format}) is missing — refusing to regenerate analysis inside report generation.`,
    );
  }
  let generated: { fileName: string; bytes: Uint8Array };
  try {
    generated = await args.generate({
      format,
      dataset: args.dataset,
    });
  } catch (err) {
    // Release-on-failure: a failed generation produced no
    // effect, so a retry must be allowed to generate.
    claims?.delete?.(claimKey);
    throw err;
  }
  const key = tabularBlobKey(format, args.keyPrefix);
  try {
    await args.store({
      key,
      fileName: generated.fileName,
      bytes: generated.bytes,
      contentType:
        format === "csv"
          ? "text/csv"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  } catch (err) {
    claims?.delete?.(claimKey);
    throw err;
  }
  return { status: "generated", key, fileName: generated.fileName };
}
