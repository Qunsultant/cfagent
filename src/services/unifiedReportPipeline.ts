/**
 * Unified screener report pipeline (issue #914).
 *
 * Single implementation for generate → store → serve → deliver used by:
 * - Stock screener (manual + scheduled)
 * - Options screener (manual + scheduled)
 * - Research runs (issue #1641: generate via generateReportStage;
 *   canonical store + semantic index already lived in researchPublish)
 *
 * Issue #680: PDF generation is owned by ReportAssetAgent (single owner).
 * This pipeline delegates to generatePdfAsset — it does NOT bypass the
 * ReportAssetAgent with direct generator calls.
 *
 * Consolidation C4 (issue #1329, epic #1151): the generate → store
 * fusion is split into separately callable stages, and the serve
 * stage's content is pinned:
 * - generateReportStage — PDF bytes via the ReportAssetAgent (with the
 *   #1278 retry policy). runReportPipeline is this stage's fused
 *   entry and keeps its exact output.
 * - storeReportStage — the shared canonical mas_reports write the
 *   callers previously inlined per run kind (market screen, options
 *   scanner, goal screen, IV collection, discovery).
 * - serveReportStage — serve's schedulable content, verified: the
 *   canonical row exists and every named artifact key resolves.
 *   A stage that cannot verify fails explicitly with its reason;
 *   nothing is fabricated. The #1123 followup.report adoption job is
 *   the serve stage's job form (see asyncJobs.ts).
 * The fused single-call path remains the degenerate case: existing
 * callers of runReportPipeline are unchanged.
 */

import type { ScreenerPdfOptions } from "../trading";

export interface UnifiedReportInput {
  /** "screener" for stock, "options" for options screener, "research" for research runs (#1641) */
  type: "screener" | "options" | "research";
  /** "manual" or "scheduled" */
  trigger: "manual" | "scheduled";
  /** The run result data (type-specific) */
  result: unknown;
  /** User login for scoping */
  userLogin: string;
  /** Human-readable title */
  title: string;
  /** Summary text */
  summary: string;
  /** Timestamp ISO string */
  timestamp: string;
  /** Issue #2088: PDF section config, threaded to the screener generator. */
  pdfOptions?: ScreenerPdfOptions;
}

export interface UnifiedReportOutput {
  /** PDF storage key (for download URL construction) */
  pdfKey: string;
  /** Generation ID (for mas_reports) */
  generationId: string;
  /** Whether PDF generation succeeded */
  pdfStatus: "generated" | "failed";
  pdfError?: string;
}

export type ReportAssetKind = "screener" | "options" | "research";

/**
 * Generate the PDF bytes for a report.
 * Dispatches to the type-specific generator. This is the ONE generator
 * dispatch in the repo (consolidation C4, #1329): the ReportAssetAgent
 * calls this instead of the trading generators directly, so the
 * single-PDF-path pin has one definition site.
 * Issue #290: import via the ../trading public surface (index.ts), never
 * a trading-internal path directly.
 * Issue #1731 (R-1/R-2 boundary): the dispatch is EXHAUSTIVE — an
 * unknown type is refused loudly, never silently rendered through the
 * options branch. The old screener-else-options shape silently
 * generated an options PDF for a research input (#1641 fixed that
 * instance by adding the research branch); the remaining else
 * branch would still silently misrender ANY unknown type (notably
 * a goal-screen input, whose pinned path is direct, not pipelined).
 * Typed callers are unaffected: the asset owner accepts only the
 * three pipeline types, and it is this dispatch's only caller.
 */
export async function generateReportPdf(
  type: ReportAssetKind,
  result: unknown,
  pdfOptions?: ScreenerPdfOptions
): Promise<Uint8Array> {
  if (type === "screener") {
    const { generateScreenerPdf } = await import("../trading");
    return generateScreenerPdf(result as any, pdfOptions);
  } else if (type === "research") {
    const { generateResearchPdf } = await import("../trading");
    return generateResearchPdf(result as any);
  } else if (type === "options") {
    const { generateOptionsPdf } = await import("../trading");
    return generateOptionsPdf(result as any);
  }
  throw new Error(
    `Unknown report type: ${String(type)} — the pipeline dispatches only screener, options, and research; goal-screen artifacts use their direct path.`
  );
}

/**
 * Get the PDF filename for a report.
 * Issue #290: import via the ../trading public surface (index.ts).
 * Issue #1731: exhaustive like generateReportPdf above — an unknown
 * type is refused, never silently named as an options report.
 */
export async function getReportFileName(
  type: ReportAssetKind,
  result: unknown
): Promise<string> {
  if (type === "screener") {
    const { screenerPdfFileName } = await import("../trading");
    return screenerPdfFileName(result as any);
  } else if (type === "research") {
    const { researchPdfFileName } = await import("../trading");
    return researchPdfFileName(result as any);
  } else if (type === "options") {
    const { optionsPdfFileName } = await import("../trading");
    return optionsPdfFileName(result as any);
  }
  throw new Error(
    `Unknown report type: ${String(type)} — the pipeline dispatches only screener, options, and research; goal-screen artifacts use their direct path.`
  );
}

/**
 * Generate stage (consolidation C4, #1329): PDF bytes via the
 * ReportAssetAgent + the #1278 retry policy. This is the body
 * runReportPipeline has always executed, extracted so the stage is
 * callable on its own; behavior is identical.
 *
 * Issue #680: PDF generation is owned by ReportAssetAgent (single owner).
 * This stage delegates to generatePdfAsset, which routes through the
 * ReportAssetAgent DO. We do NOT bypass it with direct generator calls.
 */
export async function generateReportStage(
  env: { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
  input: UnifiedReportInput
): Promise<UnifiedReportOutput> {
  const generationId = `${input.type}:${input.trigger}:${input.timestamp}`;
  const { codedMessage, hasOutcomeCodePrefix } = await import("../outcomes/outcomeAspects");

  try {
    // Issue #680: delegate to ReportAssetAgent (single owner for PDF gen).
    const { generatePdfAsset } = await import("../agents/report-asset-agent");
    // Issue #1641: the asset type IS the input type — the old
    // screener-else-options mapping silently generated an OPTIONS pdf
    // for a research input. ReportAssetAgent supports all three.
    const assetType = input.type;
    // Issue #1278 (#1173 R5): retry under the R1 pipeline policy
    // (retry.report — PIPELINE_REPORT_RETRY_* / pipeline.retry.report).
    // generatePdfAsset never throws: null IS its failure signal, so a
    // null asset counts as a failed attempt and is retried like a throw.
    const { resolvePipelinePolicy } = await import("./pipelinePolicy");
    const { withRetry } = await import("./resilience");
    const policy = resolvePipelinePolicy(env as Record<string, unknown>);
    const asset = await withRetry(
      async () => {
        const generated = await generatePdfAsset(env as any, input.userLogin, assetType as any, input.result, input.pdfOptions);
        if (!generated) {
          throw new Error("generatePdfAsset returned null");
        }
        return generated;
      },
      policy.retry.report,
      {
        label: `report-pdf:${input.type}/${input.trigger}`,
        onRetry: (event) => {
          console.warn(
            `[UnifiedReport] PDF generation attempt ${event.attempt} failed (${input.type}/${input.trigger}):`,
            event.error,
            `— retrying in ${Math.round(event.delayMs)}ms`
          );
        },
      }
    );

    return {
      pdfKey: asset.key,
      generationId,
      pdfStatus: "generated",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[UnifiedReport] PDF generation failed (${input.type}/${input.trigger}):`, message);
    return {
      pdfKey: "",
      generationId,
      pdfStatus: "failed",
      // Issue #1252 (R4): the recorded error carries its catalog code.
      pdfError: hasOutcomeCodePrefix(message) ? message : codedMessage("FAILURE_REPORT_PDF_GENERATION", message),
    };
  }
}

/**
 * Full pipeline entry, kept for existing callers: generate PDF → store
 * blob → return keys. Used by both stock and options screeners, manual
 * and scheduled. Output is identical to before C4 (it is the generate
 * stage); callers that also persist a canonical row keep doing so via
 * storeReportStage below.
 *
 * @param env Worker env (for R2 bucket binding + REPORT_ASSET_AGENT binding)
 * @param storage Blob storage (DO storage; retained for signature
 *   compatibility — the ReportAssetAgent owns blob storage internally)
 * @param input Report details
 */
export async function runReportPipeline(
  env: { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
  storage: {
    put: (key: string, value: unknown) => Promise<void>;
    get: (key: string) => Promise<unknown>;
  },
  input: UnifiedReportInput
): Promise<UnifiedReportOutput> {
  void storage;
  return generateReportStage(env, input);
}

/** One canonical-report row, as the ORM's storeCanonicalReport takes it. */
export interface CanonicalReportInput {
  runId: string;
  generationId: string;
  title: string;
  source: string;
  summary: string;
  body: unknown;
  createdAt: string;
  /** Owning tenant login — required (multi-tenant SaaS; no "default"). */
  userLogin: string;
}

/**
 * Store stage (consolidation C4, #1329): the ONE canonical mas_reports
 * write. Previously each run kind inlined its own storeCanonicalReport
 * call (market screen, options scanner, goal screen, IV collection);
 * discovery runs wrote none at all. This helper is the shared seam:
 * idempotent on generationId (one row per generation, per #308), and
 * never throws — without an ORM, or on a persistence failure, the
 * absence is returned as null (the caller records it; a missing row
 * must never fail the run that already produced its result).
 */
export function storeReportStage(
  orm: {
    storeCanonicalReport: (
      input: CanonicalReportInput,
      env?: { AI?: any; VECTOR_MEMORY?: any }
    ) => { reportId: string; created: boolean } | null;
  } | null | undefined,
  input: CanonicalReportInput,
  env?: { AI?: any; VECTOR_MEMORY?: any }
): { reportId: string; created: boolean } | null {
  if (!orm || typeof orm.storeCanonicalReport !== "function") return null;
  try {
    return orm.storeCanonicalReport(input, env);
  } catch {
    return null;
  }
}

/**
 * Serve stage (consolidation C4, #1329): serve's schedulable content,
 * verified — the canonical row exists, and every named artifact key
 * resolves. Used by the #1123 followup.report adoption job for runs
 * whose artifact is a canonical row rather than a PDF (discovery,
 * goal screens). Verification failure is explicit (verified: false +
 * reason); nothing is fabricated to pass it.
 */
export async function serveReportStage(input: {
  canonicalReportId?: string;
  pdfKey?: string;
  findCanonicalReport?: (id: string) => unknown | null | Promise<unknown | null>;
  resolvePdfKey?: (key: string) => unknown | null | Promise<unknown | null>;
}): Promise<{ verified: boolean; reason?: string }> {
  if (input.canonicalReportId) {
    if (typeof input.findCanonicalReport !== "function") {
      return { verified: false, reason: "No canonical-report lookup supplied for serve verification." };
    }
    const row = await input.findCanonicalReport(input.canonicalReportId);
    if (!row) {
      return {
        verified: false,
        reason: `Canonical report ${input.canonicalReportId} not found; serve cannot publish a missing record.`,
      };
    }
  }
  if (input.pdfKey) {
    if (typeof input.resolvePdfKey !== "function") {
      return { verified: false, reason: "No artifact resolver supplied for serve verification." };
    }
    const resolved = await input.resolvePdfKey(input.pdfKey);
    if (!resolved) {
      return {
        verified: false,
        reason: `Report artifact key ${input.pdfKey} does not resolve; serve cannot publish a missing artifact.`,
      };
    }
  }
  if (!input.canonicalReportId && !input.pdfKey) {
    return { verified: false, reason: "Nothing to verify: no canonical report id or artifact key was named." };
  }
  return { verified: true };
}

/**
 * Options artifact contract (issue #2621, P0 — the first production
 * deliverable of runtime unification).
 *
 * ONE assembler for the options report's three formats, used by BOTH
 * the sync route (manual contract screen, unified opportunities,
 * scheduled monolithic path) and the sharded path (serve assembly
 * from generate/store rows). It does NOT merge the sync and sharded
 * runtimes: each path still generates through its own seams (the
 * sync route through runReportPipeline + ScreenerAgent stores, the
 * shards through their generate/store jobs), but both report the
 * same outcome shape, so a 2-symbol sync run and a 20-symbol
 * sharded run over the same schedule describe the same coverage,
 * gates, and per-format outcomes.
 *
 * The contract:
 * - Per-format non-fatal generate: a renderer failure records that
 *   format as "failed" with its error, and the run still ships the
 *   formats that generated. No renderer can kill a run.
 * - Links only for what exists: a key/url appears only for a format
 *   whose status is "generated". A failed format contributes its
 *   status + error, never a fabricated link.
 * - No second recorder/catalog/scope model: this module only shapes
 *   the artifact outcome. Recording still goes through
 *   recordUnifiedOptionsRun / recordOptionsServeReport, messages
 *   still resolve through outcomes/outcomeCatalog.json, and scope
 *   (theses/strategies/gates/formats) still resolves through
 *   #2583's resolveOptionsReportScope — callers may pass its
 *   description/gates through, the assembler never re-resolves it
 *   and never changes selection, thesis filtering, mode defaults,
 *   caps, report content, delivery channels, or scheduling.
 */

export type OptionsArtifactFormat = "pdf" | "xlsx" | "csv";

export const OPTIONS_ARTIFACT_FORMATS: readonly OptionsArtifactFormat[] = ["pdf", "xlsx", "csv"];

/** Per-format outcome: "skipped" means the format was not requested, never a failure. */
export type OptionsFormatStatus = "generated" | "failed" | "skipped";

export interface OptionsFormatOutcome {
  format: OptionsArtifactFormat;
  status: OptionsFormatStatus;
  /** Present only when status is "generated" — never a link to missing bytes. */
  key?: string;
  fileName?: string;
  /** Present only when status is "failed". */
  error?: string;
}

export type OptionsArtifactOutcomes = Record<OptionsArtifactFormat, OptionsFormatOutcome>;

/** Normalise one format outcome: "generated" without a key is not a link, it is a failure. */
export function optionsFormatOutcome(
  format: OptionsArtifactFormat,
  partial: Partial<Omit<OptionsFormatOutcome, "format">> & { status: OptionsFormatStatus },
): OptionsFormatOutcome {
  if (partial.status === "generated" && !partial.key) {
    return {
      format,
      status: "failed",
      ...(partial.fileName ? { fileName: partial.fileName } : {}),
      error: partial.error || `Artifact reported generated without a storage key for ${format}.`,
    };
  }
  if (partial.status !== "generated") {
    const out: OptionsFormatOutcome = { format, status: partial.status };
    if (partial.status === "failed" && partial.error) out.error = partial.error;
    return out;
  }
  return {
    format,
    status: "generated",
    key: partial.key,
    ...(partial.fileName ? { fileName: partial.fileName } : {}),
  };
}

export interface OptionsArtifactGenerator {
  /** Storage key + file name of the stored artifact. Throws on failure — the runner records it, never propagates it. */
  (): Promise<{ key: string; fileName: string }>;
}

/**
 * Run every supplied per-format generator, each in its own failure
 * domain. A throwing generator becomes that format's "failed"
 * outcome; a missing generator becomes "skipped" (the format was
 * not requested, e.g. a pdf-only scope preset). This function never
 * throws: it is the seam that guarantees no renderer kills a run.
 */
export async function runOptionsArtifactFormats(
  generators: Partial<Record<OptionsArtifactFormat, OptionsArtifactGenerator>>,
): Promise<OptionsArtifactOutcomes> {
  const outcomes = {} as OptionsArtifactOutcomes;
  for (const format of OPTIONS_ARTIFACT_FORMATS) {
    const generate = generators[format];
    if (!generate) {
      outcomes[format] = { format, status: "skipped" };
      continue;
    }
    try {
      const stored = await generate();
      outcomes[format] = optionsFormatOutcome(format, {
        status: "generated",
        key: stored.key,
        fileName: stored.fileName,
      });
    } catch (err) {
      outcomes[format] = {
        format,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return outcomes;
}

/** Coverage as the run record renders it: nulls where the dataset carries no number, never a guessed count. */
export interface OptionsResultCoverage {
  considered: number | null;
  evaluated: number | null;
  matched: number | null;
  scanned: number | null;
}

function coverageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read coverage off an assembled dataset without inventing it.
 * OpportunityScanResult carries coverage.{considered,evaluated};
 * OptionScreenResult carries totalUnderlyingsScanned /
 * totalContractsEvaluated / matchedCount. A dataset with neither
 * yields nulls, and the run record says so instead of showing 0.
 */
export function optionsResultCoverage(dataset: unknown): OptionsResultCoverage {
  const d = (dataset && typeof dataset === "object" ? (dataset as Record<string, unknown>) : {}) as Record<string, unknown>;
  const coverage = (d.coverage && typeof d.coverage === "object"
    ? (d.coverage as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const hasCoverage = d.coverage !== undefined && d.coverage !== null;
  return {
    considered: hasCoverage
      ? (coverageNumber(coverage.considered) ?? coverageNumber(coverage.scanned))
      : coverageNumber(d.totalUnderlyingsScanned),
    evaluated: hasCoverage
      ? coverageNumber(coverage.evaluated)
      : coverageNumber(d.totalContractsEvaluated),
    matched: coverageNumber(d.withTrades) ?? coverageNumber(coverage.withTrades) ?? coverageNumber(d.matchedCount),
    scanned: hasCoverage
      ? (coverageNumber(coverage.scanned) ?? coverageNumber(d.scanned))
      : (coverageNumber(d.totalUnderlyingsScanned) ?? coverageNumber(d.scanned)),
  };
}

export interface AssembleOptionsResultInput {
  /** The assembled scan dataset (OptionScreenResult or OpportunityScanResult). Content is passed through, never reshaped. */
  dataset: unknown;
  /** Per-format outcomes, from runOptionsArtifactFormats (sync) or optionsArtifactsFromShardRows (sharded). */
  artifacts: Partial<Record<OptionsArtifactFormat, OptionsFormatOutcome>>;
  /** Formats the run requested; anything else is "skipped", never "failed". Defaults to all three. */
  requestedFormats?: readonly OptionsArtifactFormat[];
  /** Link builder; when absent, no urls are produced (keys still are). A url is built only for a generated format. */
  urlFor?: (format: OptionsArtifactFormat, key: string) => string;
  /** #2583 scope passthrough: description + gates from resolveOptionsReportScope, when the caller resolved one. */
  scope?: {
    description?: string;
    gates?: { maxPlannedLoss?: number; minRewardRisk?: number } | null;
  };
}

/** Canonical-body-ready links: keys/urls only for generated formats, statuses + errors for every requested format. */
export interface AssembledOptionsLinks {
  pdfKey?: string;
  pdfStatus: OptionsFormatStatus;
  pdfError?: string;
  reportUrl?: string;
  xlsxKey?: string;
  xlsxStatus: OptionsFormatStatus;
  xlsxError?: string;
  xlsxUrl?: string;
  csvKey?: string;
  csvStatus: OptionsFormatStatus;
  csvError?: string;
  csvUrl?: string;
}

export interface AssembledOptionsResult {
  dataset: unknown;
  coverage: OptionsResultCoverage;
  artifacts: OptionsArtifactOutcomes;
  generatedFormats: OptionsArtifactFormat[];
  failedFormats: OptionsArtifactFormat[];
  skippedFormats: OptionsArtifactFormat[];
  /** True when at least one requested format generated. */
  anyGenerated: boolean;
  /** True when nothing generated and at least one requested format failed (all-skipped is not a failure). */
  allFailed: boolean;
  links: AssembledOptionsLinks;
  scopeSummary: string | null;
  gates: { maxPlannedLoss?: number; minRewardRisk?: number } | null;
}

/**
 * The ONE options-result assembler. Pure: same dataset + same
 * per-format outcomes always yield the same coverage, gates, and
 * links, whether the caller is the sync route or the shard serve
 * planner — that is the P0 acceptance (2-symbol sync vs 20-symbol
 * sharded over the same schedule must agree).
 */
export function assembleOptionsResult(input: AssembleOptionsResultInput): AssembledOptionsResult {
  const requested = input.requestedFormats ?? OPTIONS_ARTIFACT_FORMATS;
  const requestedSet = new Set(requested);
  const artifacts = {} as OptionsArtifactOutcomes;
  for (const format of OPTIONS_ARTIFACT_FORMATS) {
    if (!requestedSet.has(format)) {
      artifacts[format] = { format, status: "skipped" };
      continue;
    }
    const outcome = input.artifacts[format];
    artifacts[format] = outcome
      ? optionsFormatOutcome(format, outcome)
      : { format, status: "failed", error: `No ${format} artifact was produced for this run.` };
  }
  const generatedFormats = OPTIONS_ARTIFACT_FORMATS.filter((f) => artifacts[f].status === "generated");
  const failedFormats = OPTIONS_ARTIFACT_FORMATS.filter((f) => artifacts[f].status === "failed");
  const skippedFormats = OPTIONS_ARTIFACT_FORMATS.filter((f) => artifacts[f].status === "skipped");
  const urlFor = (format: OptionsArtifactFormat): string | undefined => {
    const outcome = artifacts[format];
    return outcome.status === "generated" && outcome.key && input.urlFor
      ? input.urlFor(format, outcome.key)
      : undefined;
  };
  const links: AssembledOptionsLinks = {
    ...(artifacts.pdf.key ? { pdfKey: artifacts.pdf.key } : {}),
    pdfStatus: artifacts.pdf.status,
    ...(artifacts.pdf.error ? { pdfError: artifacts.pdf.error } : {}),
    ...(urlFor("pdf") ? { reportUrl: urlFor("pdf") } : {}),
    ...(artifacts.xlsx.key ? { xlsxKey: artifacts.xlsx.key } : {}),
    xlsxStatus: artifacts.xlsx.status,
    ...(artifacts.xlsx.error ? { xlsxError: artifacts.xlsx.error } : {}),
    ...(urlFor("xlsx") ? { xlsxUrl: urlFor("xlsx") } : {}),
    ...(artifacts.csv.key ? { csvKey: artifacts.csv.key } : {}),
    csvStatus: artifacts.csv.status,
    ...(artifacts.csv.error ? { csvError: artifacts.csv.error } : {}),
    ...(urlFor("csv") ? { csvUrl: urlFor("csv") } : {}),
  };
  return {
    dataset: input.dataset,
    coverage: optionsResultCoverage(input.dataset),
    artifacts,
    generatedFormats,
    failedFormats,
    skippedFormats,
    anyGenerated: generatedFormats.length > 0,
    allFailed: generatedFormats.length === 0 && failedFormats.length > 0,
    links,
    scopeSummary: input.scope?.description ?? null,
    gates: input.scope?.gates ?? null,
  };
}

/**
 * Shard-row projection the assembler reads (the planner's ShardRow
 * shape, without importing it — this module must stay importable
 * from the planner without a cycle).
 */
export interface ShardArtifactRow {
  stage?: string;
  shardKey?: string;
  status: string;
  result?: unknown;
  error?: string;
}

/**
 * Build per-format outcomes from a chain's generate + store rows —
 * the sharded path's input to assembleOptionsResult.
 *
 * - A completed generate row with a key is "generated", unless its
 *   store row says otherwise (see below).
 * - A completed generate row carrying status "failed" is that
 *   format's renderer failure (the #2621 non-fatal outcome: the
 *   shard job completed with a definitive failed result instead of
 *   throwing, so the chain advances past it).
 * - A failed generate job row with no completed retry is "failed"
 *   with the row's error (the chain's existing stop semantics keep
 *   such a chain from advancing; this mapping only describes rows
 *   the planner already let through).
 * - A store row decides servability: a completed store row with
 *   status "failed", or a failed store job row, downgrades its
 *   format to "failed" with the store error — the serve outcome
 *   must never link bytes the store could not verify. A completed
 *   store row without a status is legacy "generated".
 * - No row at all for a format is "failed" with a named reason,
 *   matching the serve planner's previous missing → failed mapping.
 */
export function optionsArtifactsFromShardRows(rows: readonly ShardArtifactRow[]): OptionsArtifactOutcomes {
  const outcomes = {} as OptionsArtifactOutcomes;
  for (const format of OPTIONS_ARTIFACT_FORMATS) {
    const generateRows = rows.filter((r) => r.stage === "generate" && r.shardKey === format);
    const latestCompleted = generateRows.filter((r) => r.status === "completed").at(-1);
    const latestFailedJob = generateRows.filter((r) => r.status === "failed").at(-1);
    const storeRows = rows.filter((r) => r.stage === "store" && r.shardKey === format);
    const latestStoreCompleted = storeRows.filter((r) => r.status === "completed").at(-1);
    const latestStoreFailedJob = storeRows.filter((r) => r.status === "failed").at(-1);
    const generateResult = (latestCompleted?.result && typeof latestCompleted.result === "object"
      ? (latestCompleted.result as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    let outcome: OptionsFormatOutcome;
    if (latestCompleted && generateResult.status === "failed") {
      outcome = {
        format,
        status: "failed",
        error: typeof generateResult.error === "string" && generateResult.error
          ? generateResult.error
          : (latestCompleted.error ?? `Options ${format} generation failed.`),
      };
    } else if (latestCompleted && typeof generateResult.key === "string" && generateResult.key) {
      outcome = {
        format,
        status: "generated",
        key: generateResult.key,
        ...(typeof generateResult.fileName === "string" ? { fileName: generateResult.fileName } : {}),
      };
    } else if (latestFailedJob) {
      outcome = {
        format,
        status: "failed",
        error: latestFailedJob.error ?? `Options ${format} generation failed.`,
      };
    } else if (latestCompleted) {
      outcome = {
        format,
        status: "failed",
        error: `Options ${format} generate shard completed without an artifact key.`,
      };
    } else {
      outcome = {
        format,
        status: "failed",
        error: `No ${format} generate shard completed for this run.`,
      };
    }
    if (outcome.status === "generated") {
      const storeResult = (latestStoreCompleted?.result && typeof latestStoreCompleted.result === "object"
        ? (latestStoreCompleted.result as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      if (latestStoreCompleted && storeResult.status === "failed") {
        outcome = {
          format,
          status: "failed",
          error: typeof storeResult.error === "string" && storeResult.error
            ? storeResult.error
            : (latestStoreCompleted.error ?? `Options ${format} store verification failed.`),
        };
      } else if (latestStoreFailedJob && !latestStoreCompleted) {
        outcome = {
          format,
          status: "failed",
          error: latestStoreFailedJob.error ?? `Options ${format} store failed.`,
        };
      }
    }
    outcomes[format] = outcome;
  }
  return outcomes;
}

/**
 * Serve-planner entry point to the ONE assembler: the sharded path
 * projects a chain's generate + store rows into per-format outcomes
 * and assembles them exactly as the sync route assembles its own
 * outcomes, so the two paths agree on coverage, gates, and links
 * for the same dataset. The chain argument is accepted for
 * call-site symmetry only; the outcome is built from rows +
 * dataset, never from chain metadata.
 */
export function assembleOptionsResultForServe(
  rows: readonly ShardArtifactRow[],
  dataset: unknown,
  _chain?: unknown
): AssembledOptionsResult {
  void _chain;
  return assembleOptionsResult({
    dataset,
    artifacts: optionsArtifactsFromShardRows(rows),
  });
}
