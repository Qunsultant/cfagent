/**
 * Issue #3538 (Pipeline J5, epic #3533) — generate jobs: the
 * contract, the registry, the rendering, and the run/read/
 * status service. The third hand-off of the pipeline: a
 * generate job reads the PERSISTED analyzed dataset its
 * analyze job produced (with its provenance —
 * analyzedDatasetPorts), renders the configured reports in
 * the configured formats DETERMINISTICALLY, and persists the
 * generated results (generatedDatasetPorts) for the deliver
 * stage.
 *
 * Determinism (the platform's rule): the rendering is a pure
 * function of the persisted analyzed artifact and the
 * configuration — no LLM, no live fetch, no clock reads inside
 * the renderers (the PDF's metadata dates come from the run's
 * own timestamps). Identical input + identical configuration
 * ⇒ identical report bodies; replay never re-derives from a
 * different copy.
 *
 * Where the reports themselves live (the J5 composition rule,
 * surveyed against the existing machinery):
 * - The generated-results record is THIS stage's persisted
 *   output (generatedDatasetPorts, on the data foundation) —
 *   the deliver stage's hand-off, keyed by generate job id.
 * - mas_reports is the canonical report copy, and the reports
 *   ALSO go through its store machinery (storeReportAtGeneration,
 *   services/scheduledReports.ts) WHERE IT FITS: that seam
 *   requires a report-owning tenant login and that tenant's
 *   Orchestrator DO. Issue #3940 (#3550 option (a)) wires the
 *   tenant-aware leg TO the engine: the generate stage resolves
 *   the report-owning tenant per job (the job's configured
 *   reportOwnerLogin, else the seam's bound owner) and writes
 *   the canonical copy through the orchestrator door
 *   (PipelineGenerateReportDoor), so the row lands in the
 *   tenant's Orchestrator DO in both residencies — never in
 *   the pipeline host's own store, where no Reports view reads.
 *   Where no tenant resolves, each report's canonical leg is
 *   recorded not_wired with its coded reason (the #2347
 *   per-leg outcome discipline) — never silently skipped and
 *   never claimed as stored.
 *
 * Honesty rules (the platform's, carried from #3530/#3536/#3537):
 * - A read NEVER fetches: this module has no provider in its
 *   inputs. The input is resolved from the analyzed-dataset
 *   store by the producing analyze job's id — exact lineage.
 * - A configured format whose rendering fails is recorded
 *   failed with a coded reason — never a fabricated body.
 * - A missing persisted input refuses BY NAME
 *   (GENERATE_INPUT_MISSING, fail-closed): the failed run is
 *   recorded on the generated store and returned, never a
 *   silent empty success.
 * - The analysis stage's recorded gaps ride into the report
 *   document verbatim — generation never papers over what
 *   analysis could not evaluate.
 *
 * Run outcomes are RETURNED, not thrown — the run record is
 * the job's state (the #3530 idiom). Only contract violations
 * throw (unknown job id — a caller bug; an unknown report
 * kind or format name in configuration — a configuration bug).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { scrubFailureMessage, type DataProviderId, type IndexId } from "../trading";
import {
  type AnalyzedDatasetArtifact,
  type AnalyzedDatasetRow,
  type AnalyzedDatasetStore,
} from "../data/analyzedDatasetPorts";
import {
  generatedFormatCount,
  type GeneratedCanonicalRecord,
  type GeneratedDatasetArtifact,
  type GeneratedDatasetStore,
  type GeneratedFormatRecord,
  type GeneratedReportRecord,
} from "../data/generatedDatasetPorts";
import { buildAnalyzeJobRegistry } from "./analyzeJobs";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/generateJobs",
});

/** Stable coded errors for generate-job outcomes (externalized vocabulary). */
export const GENERATE_JOB_CODES = {
  jobNotFound: "GENERATE_JOB_NOT_FOUND",
  inputMissing: "GENERATE_INPUT_MISSING",
  reportUnknown: "GENERATE_REPORT_UNKNOWN",
  formatUnknown: "GENERATE_FORMAT_UNKNOWN",
} as const;
export type GenerateJobCode = (typeof GENERATE_JOB_CODES)[keyof typeof GENERATE_JOB_CODES];

/** Stable log event code for a failed generate run (codes + counts only). */
export const GENERATE_JOB_RUN_FAILED = "generate_job_run_failed";

/** Coded reasons on per-format / per-leg records (externalized vocabulary). */
export const GENERATE_GAP_CODES = {
  /** A format's renderer threw; the body was not produced. */
  formatRenderFailed: "GENERATE_FORMAT_RENDER_FAILED",
  /** A rendered body exceeded the family's body cap (the
   *  mas_reports cap's rationale: SQLite row limits). */
  bodyTooLarge: "GENERATE_BODY_TOO_LARGE",
  /** No host wired the canonical report-store seam for this
   *  residency (see the module header — the seam's
   *  preconditions are a report-owning tenant + its DO). */
  canonicalNotWired: "canonical_report_store_not_wired",
  /** A seam IS wired, but no report-owning tenant resolves
   *  for this job — neither the job's configured
   *  reportOwnerLogin nor the seam's bound ownerLogin names
   *  one (#3940). Named, never silent; the run still
   *  completes with its generated output persisted. */
  canonicalOwnerUnconfigured: "canonical_report_owner_unconfigured",
  /** The wired canonical seam returned no row (its own
   *  refusal, e.g. an owner-less write — the seam logs why). */
  canonicalStoreRefused: "canonical_report_store_refused",
  /** The wired canonical seam threw (contract violation —
   *  the canonical seam itself never throws). */
  canonicalStoreThrew: "canonical_report_store_threw",
} as const;

/**
 * The per-format body cap, mirroring the canonical store's
 * SCHEDULED_REPORT_MAX_BODY_CHARS: a rendered body larger than
 * this is recorded failed with GENERATE_BODY_TOO_LARGE rather
 * than truncated into a dishonest artifact.
 */
export const GENERATED_REPORT_MAX_BODY_CHARS = 200_000;

/** The canonical producer label generate-job reports carry in mas_reports. */
export const GENERATE_CANONICAL_SOURCE = "pipeline_generate";

export class GenerateJobError extends Error {
  readonly code: GenerateJobCode;
  constructor(code: GenerateJobCode, message: string) {
    super(message);
    this.name = "GenerateJobError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* The report-kind + format vocabularies                               */
/* ------------------------------------------------------------------ */

/**
 * The report kinds a generate job may produce. Each kind is a
 * deterministic document rendered from the persisted analyzed
 * artifact:
 * - analysis: the analyzed dataset as a report — lineage,
 *   the recorded universe summary, per-symbol verdicts
 *   (signals + scores + composite), and the analysis gaps.
 */
export const GENERATE_REPORT_KINDS = ["analysis"] as const;
export type GenerateReportKind = (typeof GENERATE_REPORT_KINDS)[number];

export const GENERATE_ALL_REPORT_KINDS: readonly string[] = [...GENERATE_REPORT_KINDS];

/**
 * The formats a report may be rendered in — every one of them
 * producible deterministically in this stage (json/markdown/csv
 * are text renders of the report document; pdf is a pdf-lib
 * render, the platform's deterministic PDF machinery — the
 * goalScreenReports precedent).
 */
export const GENERATE_FORMATS = ["json", "markdown", "csv", "pdf"] as const;
export type GenerateFormat = (typeof GENERATE_FORMATS)[number];

export const GENERATE_ALL_FORMATS: readonly string[] = [...GENERATE_FORMATS];

/** Content type per format (externalized vocabulary). */
export const GENERATE_FORMAT_CONTENT_TYPES: Record<GenerateFormat, string> = {
  json: "application/json",
  markdown: "text/markdown",
  csv: "text/csv",
  pdf: "application/pdf",
};

/** Validate a configured report-kind list; an unknown name is a
 *  configuration error, refused by name (never silently dropped). */
export function validateGenerateReportKinds(kinds: readonly string[]): string[] {
  const out: string[] = [];
  for (const kind of kinds) {
    if (!GENERATE_ALL_REPORT_KINDS.includes(kind)) {
      throw new GenerateJobError(
        GENERATE_JOB_CODES.reportUnknown,
        `Unknown generate report kind "${kind}". Known report kinds: ${GENERATE_ALL_REPORT_KINDS.join(", ")}.`,
      );
    }
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

/** Validate a configured format list; an unknown name is a
 *  configuration error, refused by name (never silently dropped). */
export function validateGenerateFormats(formats: readonly string[]): string[] {
  const out: string[] = [];
  for (const format of formats) {
    if (!GENERATE_ALL_FORMATS.includes(format)) {
      throw new GenerateJobError(
        GENERATE_JOB_CODES.formatUnknown,
        `Unknown generate format "${format}". Known formats: ${GENERATE_ALL_FORMATS.join(", ")}.`,
      );
    }
    if (!out.includes(format)) out.push(format);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The canonical report-store seam (mas_reports, where it fits)        */
/* ------------------------------------------------------------------ */

// Issue #4060: the seam lives in ./canonicalReportLeg.ts (a leaf —
// importing the leg must not drag in this module's job graph).
// Re-exported here so every existing importer keeps its path.
import {
  createTenantAwareCanonicalReportStore,
  type CanonicalReportStoreSeam,
  type PipelineGenerateReportDoor,
} from "./canonicalReportLeg";

export { createTenantAwareCanonicalReportStore };
export type { CanonicalReportStoreSeam, PipelineGenerateReportDoor };

/* ------------------------------------------------------------------ */
/* The contract + registry                                             */
/* ------------------------------------------------------------------ */

/**
 * The generate-job contract: the analyze job whose persisted
 * dataset it consumes, the reports + formats it renders, and
 * its cadence/freshness knobs (config-resolved, see
 * buildGenerateJobRegistry — never literals at call sites).
 */
export interface GenerateJobDefinition {
  id: string;
  /** The analyze job whose persisted dataset is the input. */
  analyzeJobId: string;
  /** The enrich job upstream of the analyze job. */
  enrichJobId: string;
  /** The feed job at the head of this job's lineage. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The dataset id within the source ("quotes"). */
  dataset: string;
  universe: { kind: "index"; index: IndexId; label: string };
  /** The report kinds this job generates by default (the pipeline
   *  definition's step params may override per configuration). */
  reports: readonly string[];
  /** The formats this job renders by default (same rule). */
  formats: readonly string[];
  /** Declared cadence — the scheduling slice's input. */
  cadenceMinutes: number;
  /** Age past which the stored generated copy is labelled stale. */
  staleAfterMinutes: number;
  /** The report-owning tenant this job's canonical copies
   *  belong to (#3940): resolved from the per-job
   *  GENERATE_JOB_<ID>_REPORT_OWNER_LOGIN knob. Absent ⇒ the
   *  leg falls back to the seam's bound owner; when neither
   *  names a tenant the leg records not_wired with its coded
   *  reason. No default owner exists. */
  reportOwnerLogin?: string;
}

/**
 * The generate-job registry — the AnalyzeJobRegistry idiom
 * (unique ids, re-registering throws so provenance ids stay
 * unambiguous; explicit resolution failure, no silent fallback).
 */
export class GenerateJobRegistry {
  private jobs = new Map<string, GenerateJobDefinition>();

  register(job: GenerateJobDefinition): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Generate job "${job.id}" is already registered.`);
    }
    this.jobs.set(job.id, job);
  }

  get(id: string): GenerateJobDefinition | undefined {
    return this.jobs.get(id);
  }

  list(): GenerateJobDefinition[] {
    return Array.from(this.jobs.values());
  }

  /** The generate job consuming an analyze job's dataset, if one is registered. */
  forAnalyzeJob(analyzeJobId: string): GenerateJobDefinition | undefined {
    return this.list().find((j) => j.analyzeJobId === analyzeJobId);
  }
}

/* ------------------------------------------------------------------ */
/* Cadence / freshness / report / format knobs — config, not literals. */
/* GENERATE_JOB_<JOB_ID>_CADENCE_MINUTES / _STALE_MINUTES /            */
/* _REPORTS / _FORMATS                                                 */
/* ------------------------------------------------------------------ */

function knobKey(jobId: string, suffix: string): string {
  return `GENERATE_JOB_${jobId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function resolveMinutesKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  suffix: string,
  fallback: number,
): number {
  const raw = env[knobKey(jobId, suffix)];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveListKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  suffix: string,
  fallback: readonly string[],
  validate: (values: readonly string[]) => string[],
): string[] {
  const raw = env[knobKey(jobId, suffix)];
  if (typeof raw !== "string" || !raw.trim()) return [...fallback];
  return validate(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Resolve a per-job owner-login knob (#3940): trimmed,
 *  blank/absent ⇒ undefined. No default owner exists. */
function resolveOwnerLoginKnob(
  env: Record<string, string | undefined>,
  jobId: string,
): string | undefined {
  const raw = env[knobKey(jobId, "REPORT_OWNER_LOGIN")];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

export const GENERATE_JOB_DEFAULTS = {
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
} as const;

/** The default generation configuration: the analysis report
 *  in every format this stage can produce. */
export const GENERATE_DEFAULT_REPORTS: readonly string[] = [...GENERATE_REPORT_KINDS];
export const GENERATE_DEFAULT_FORMATS: readonly string[] = [...GENERATE_FORMATS];

/**
 * The built-in registry: one generate job per analyze job in
 * the J4 registry (which is one per enrich job, one per quotes
 * feed job). The job id extends the lineage:
 * <feed job>-enrich-analyze-generate.
 */
export function buildGenerateJobRegistry(
  env: Record<string, string | undefined>,
): GenerateJobRegistry {
  const analyzeRegistry = buildAnalyzeJobRegistry(env);
  const registry = new GenerateJobRegistry();
  for (const analyze of analyzeRegistry.list()) {
    const id = `${analyze.id}-generate`;
    registry.register({
      id,
      analyzeJobId: analyze.id,
      enrichJobId: analyze.enrichJobId,
      feedJobId: analyze.feedJobId,
      sourceId: analyze.sourceId,
      dataset: analyze.dataset,
      universe: analyze.universe,
      reports: resolveListKnob(env, id, "REPORTS", GENERATE_DEFAULT_REPORTS, validateGenerateReportKinds),
      formats: resolveListKnob(env, id, "FORMATS", GENERATE_DEFAULT_FORMATS, validateGenerateFormats),
      cadenceMinutes: resolveMinutesKnob(
        env,
        id,
        "CADENCE_MINUTES",
        GENERATE_JOB_DEFAULTS.cadenceMinutes,
      ),
      staleAfterMinutes: resolveMinutesKnob(
        env,
        id,
        "STALE_MINUTES",
        GENERATE_JOB_DEFAULTS.staleAfterMinutes,
      ),
      reportOwnerLogin: resolveOwnerLoginKnob(env, id),
    });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* The report document (pure: persisted artifact in, document out)     */
/* ------------------------------------------------------------------ */

/**
 * The report document — the format-neutral content every
 * format renders. Built purely from the persisted analyzed
 * artifact (or the run's partition of it): the recorded
 * universe summary rides verbatim (never recomputed from a
 * different copy — the analyzed family's own rule), the
 * analysis gaps ride verbatim, and the rows are the analyzed
 * rows the document renders.
 */
export interface GenerateReportDocument {
  kind: string;
  title: string;
  /** One-paragraph deterministic summary of the report. */
  summary: string;
  sourceId: DataProviderId;
  dataset: string;
  universeLabel: string;
  /** True when this document renders a shard partition of the
   *  input artifact (its summary still names the whole input). */
  partitioned: boolean;
  /** Symbols rendered in this document. */
  symbolsRendered: number;
  /** Lineage: the analyzed artifact + run this report derives from. */
  inputArtifactId: string;
  inputRunId: string;
  inputAsOf: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  /** The rule sets the analyze run evaluated. */
  ruleSets: string[];
  /** The input artifact's recorded universe summary, verbatim. */
  inputSummary: AnalyzedDatasetArtifact["summary"];
  /** The input artifact's recorded rule gaps, verbatim. */
  gaps: AnalyzedDatasetArtifact["gaps"];
  rows: AnalyzedDatasetRow[];
}

const fmtNum = (v: number | null): string => (v === null ? "n/a" : String(v));

export function buildReportDocument(args: {
  kind: string;
  def: GenerateJobDefinition;
  inputArtifact: AnalyzedDatasetArtifact;
  rows: AnalyzedDatasetRow[];
  partitioned: boolean;
}): GenerateReportDocument {
  const { kind, def, inputArtifact, rows, partitioned } = args;
  // Only the "analysis" kind exists today; validateGenerateReportKinds
  // has already refused any other name before a run reaches here.
  void kind;
  const s = inputArtifact.summary;
  const top = s.topByComposite.map((t) => `${t.symbol} (${t.score})`).join(", ") || "none";
  const bottom =
    s.bottomByComposite.map((t) => `${t.symbol} (${t.score})`).join(", ") || "none";
  const summary =
    `Analysis of ${inputArtifact.universe.label} ${def.dataset} from ${def.sourceId}: ` +
    `${s.symbols} symbols analyzed; breadth ${s.advancers} up / ${s.decliners} down / ${s.flat} flat; ` +
    `mean composite ${fmtNum(s.meanCompositeScore)}; mean momentum ${fmtNum(s.meanMomentum)}. ` +
    `Top by composite: ${top}. Bottom by composite: ${bottom}.`;
  return {
    kind: "analysis",
    title: `Analysis — ${def.sourceId} ${def.dataset} (${inputArtifact.universe.label})`,
    summary,
    sourceId: def.sourceId,
    dataset: def.dataset,
    universeLabel: inputArtifact.universe.label,
    partitioned,
    symbolsRendered: rows.length,
    inputArtifactId: inputArtifact.id,
    inputRunId: inputArtifact.run.runId,
    inputAsOf: inputArtifact.createdAt,
    analyzeJobId: def.analyzeJobId,
    enrichJobId: def.enrichJobId,
    feedJobId: def.feedJobId,
    ruleSets: [...inputArtifact.ruleSets],
    inputSummary: s,
    gaps: inputArtifact.gaps,
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* The format renderers (pure, deterministic)                          */
/* ------------------------------------------------------------------ */

function renderJson(document: GenerateReportDocument): string {
  return JSON.stringify(document, null, 2);
}

function signalCell(row: AnalyzedDatasetRow, ruleSet: string): string {
  if (row.unavailable.includes(ruleSet)) return "unavailable";
  const signal = row.signals[ruleSet];
  const score = row.scores[ruleSet];
  if (signal === undefined) return "unavailable";
  return score === undefined ? signal : `${signal} (${score})`;
}

function renderMarkdown(document: GenerateReportDocument): string {
  const lines: string[] = [];
  lines.push(`# ${document.title}`);
  lines.push("");
  lines.push(document.summary);
  lines.push("");
  lines.push(`- Source: ${document.sourceId} · Dataset: ${document.dataset} · Universe: ${document.universeLabel}`);
  lines.push(`- Derived from analyze run: ${document.inputRunId} (artifact ${document.inputArtifactId}, as of ${document.inputAsOf})`);
  lines.push(`- Rule sets: ${document.ruleSets.join(", ") || "none"}`);
  if (document.partitioned) {
    lines.push(`- Partitioned render: ${document.symbolsRendered} symbols of the input artifact`);
  }
  lines.push("");
  lines.push("## Symbols");
  lines.push("");
  const header = ["Symbol", "Last price", "Composite", ...document.ruleSets];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of document.rows) {
    const cells = [
      row.symbol,
      String(row.lastPrice),
      fmtNum(row.compositeScore),
      ...document.ruleSets.map((r) => signalCell(row, r)),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (document.gaps.length > 0) {
    lines.push("");
    lines.push("## Unavailable rule sets");
    lines.push("");
    for (const gap of document.gaps) {
      lines.push(`- ${gap.ruleSet}: ${gap.reason} (${gap.symbols.length} symbols)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function renderCsv(document: GenerateReportDocument): string {
  const header = [
    "symbol",
    "last_price",
    "composite_score",
    ...document.ruleSets.flatMap((r) => [`${r}_signal`, `${r}_score`]),
    "unavailable",
  ];
  const lines = [header.join(",")];
  for (const row of document.rows) {
    const cells = [
      row.symbol,
      String(row.lastPrice),
      fmtNum(row.compositeScore),
      ...document.ruleSets.flatMap((r) => [
        row.signals[r] ?? "",
        row.scores[r] === undefined ? "" : String(row.scores[r]),
      ]),
      row.unavailable.join(";"),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Word-wrap a line to a character budget (the PDF renderer's
 *  layout rule — no line is ever truncated silently). */
function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(" ", width);
    const at = cut > 0 ? cut : width;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function renderPdf(
  document: GenerateReportDocument,
  finishedAtIso: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Determinism: the document's metadata dates are the run's
  // own timestamps, never a wall-clock read inside the render.
  const finishedAt = new Date(finishedAtIso);
  doc.setCreationDate(finishedAt);
  doc.setModificationDate(finishedAt);
  doc.setTitle(document.title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 752;
  const draw = (text: string, size: number, useBold = false) => {
    for (const line of wrapLine(text, size >= 16 ? 62 : 96)) {
      if (y < 56) {
        page = doc.addPage([612, 792]);
        y = 752;
      }
      page.drawText(line, { x: 48, y, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
      y -= size + 9;
    }
  };
  draw(document.title, 16, true);
  draw(document.summary, 10);
  draw(`Source: ${document.sourceId} · Dataset: ${document.dataset} · Universe: ${document.universeLabel}`, 10);
  draw(`Derived from analyze run: ${document.inputRunId} (as of ${document.inputAsOf})`, 10);
  draw(`Rule sets: ${document.ruleSets.join(", ") || "none"}`, 10);
  if (document.partitioned) {
    draw(`Partitioned render: ${document.symbolsRendered} symbols of the input artifact`, 10);
  }
  const s = document.inputSummary;
  draw(
    `Breadth: ${s.advancers} up / ${s.decliners} down / ${s.flat} flat · Mean composite: ${fmtNum(s.meanCompositeScore)} · Mean momentum: ${fmtNum(s.meanMomentum)}`,
    10,
  );
  draw("Symbols:", 12, true);
  for (const row of document.rows) {
    const verdicts = document.ruleSets.map((r) => `${r}: ${signalCell(row, r)}`).join("  ");
    draw(`${row.symbol} — last ${row.lastPrice} · composite ${fmtNum(row.compositeScore)} · ${verdicts}`, 10);
  }
  if (document.gaps.length > 0) {
    draw("Unavailable rule sets:", 12, true);
    for (const gap of document.gaps) {
      draw(`${gap.ruleSet}: ${gap.reason} (${gap.symbols.length} symbols)`, 10);
    }
  }
  return doc.save();
}

const TEXT_ENCODER = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Render one report in one format. Returns the format record —
 * a renderer failure is a recorded failure, never a throw and
 * never a fabricated body.
 */
export async function renderReportFormat(args: {
  document: GenerateReportDocument;
  format: string;
  finishedAtIso: string;
}): Promise<GeneratedFormatRecord> {
  const format = args.format as GenerateFormat;
  const contentType = GENERATE_FORMAT_CONTENT_TYPES[format];
  const failed = (codedError: string, errorMessage: string): GeneratedFormatRecord => ({
    format: args.format,
    status: "failed",
    contentType,
    bodyText: null,
    bodyBase64: null,
    sizeBytes: 0,
    codedError,
    errorMessage,
  });
  try {
    let bodyText: string | null = null;
    let bodyBase64: string | null = null;
    let sizeBytes = 0;
    switch (format) {
      case "json":
        bodyText = renderJson(args.document);
        break;
      case "markdown":
        bodyText = renderMarkdown(args.document);
        break;
      case "csv":
        bodyText = renderCsv(args.document);
        break;
      case "pdf": {
        const bytes = await renderPdf(args.document, args.finishedAtIso);
        bodyBase64 = bytesToBase64(bytes);
        sizeBytes = bytes.length;
        break;
      }
    }
    if (bodyText !== null) {
      sizeBytes = TEXT_ENCODER.encode(bodyText).length;
      if (bodyText.length > GENERATED_REPORT_MAX_BODY_CHARS) {
        return failed(
          GENERATE_GAP_CODES.bodyTooLarge,
          `The rendered ${format} body is ${bodyText.length} chars, over the ${GENERATED_REPORT_MAX_BODY_CHARS}-char cap; it was recorded failed rather than truncated.`,
        );
      }
    }
    if (bodyBase64 !== null && bodyBase64.length > GENERATED_REPORT_MAX_BODY_CHARS) {
      return failed(
        GENERATE_GAP_CODES.bodyTooLarge,
        `The rendered ${format} body exceeds the ${GENERATED_REPORT_MAX_BODY_CHARS}-char stored cap; it was recorded failed rather than truncated.`,
      );
    }
    return {
      format: args.format,
      status: "generated",
      contentType,
      bodyText,
      bodyBase64,
      sizeBytes,
      codedError: null,
      errorMessage: null,
    };
  } catch (err) {
    return failed(
      GENERATE_GAP_CODES.formatRenderFailed,
      scrubFailureMessage(err instanceof Error ? err.message : String(err)),
    );
  }
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface GenerateJobDeps {
  /** The analyzed-dataset store (the input copies). */
  analyzedStore: AnalyzedDatasetStore;
  /** The generated-dataset store (this stage's persisted output). */
  generatedStore: GeneratedDatasetStore;
  /** The canonical report-store seam (mas_reports), host-bound
   *  where it fits; null/absent ⇒ each report's canonical leg
   *  is recorded not_wired with its coded reason. */
  canonicalReportStore?: CanonicalReportStoreSeam | null;
}

export interface RunGenerateJobOptions {
  trigger?: "manual" | "scheduled";
  /** The run id to record under (the pipeline engine's run id,
   *  when dispatched through the plane — one run, one id). */
  runId?: string;
  /** Injectable clock (tests); defaults to now. */
  nowMs?: number;
  /** Report-kind override (the pipeline definition's configured
   *  params win over the registry defaults). */
  reports?: readonly string[];
  /** Format override (configuration, same rule). */
  formats?: readonly string[];
  /** Shard partition: generate from only these symbols of the
   *  input artifact (the plane's sharded shape). */
  symbols?: readonly string[];
}

export interface GenerateRunResult {
  jobId: string;
  runId: string;
  status: "completed" | "partial" | "failed";
  artifactId: string | null;
  /** Report × format pairs the run set out to generate. */
  requested: number;
  /** Report × format pairs generated. */
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
  /** The analyzed artifact consumed (lineage), when one was. */
  inputArtifactId: string | null;
  inputRunId: string | null;
  /** Reports generated (kinds, in configuration order). */
  reportsGenerated: string[];
  /** Canonical leg outcomes, per report kind. */
  canonical: Record<string, GeneratedCanonicalRecord["status"]>;
}

/** The canonical leg for one report: through the seam where a
 *  host wired it, recorded not_wired where none did. */
async function runCanonicalLeg(args: {
  seam: CanonicalReportStoreSeam | null | undefined;
  def: GenerateJobDefinition;
  document: GenerateReportDocument;
  runId: string;
  finishedAt: string;
}): Promise<GeneratedCanonicalRecord> {
  const { seam, def, document, runId, finishedAt } = args;
  if (!seam) {
    return {
      status: "not_wired",
      reportId: null,
      fanoutCode: null,
      reason: GENERATE_GAP_CODES.canonicalNotWired,
    };
  }
  // #3940: the leg resolves the report-owning tenant per job —
  // the job's configured reportOwnerLogin first, the seam's
  // bound owner second. Neither naming a tenant is a named
  // not_wired (never a default owner, never a silent skip);
  // the run still completes with its generated output persisted.
  const owner =
    (typeof def.reportOwnerLogin === "string"
      ? def.reportOwnerLogin.trim()
      : "") ||
    (typeof seam.ownerLogin === "string" ? seam.ownerLogin.trim() : "");
  if (!owner) {
    return {
      status: "not_wired",
      reportId: null,
      fanoutCode: null,
      reason: GENERATE_GAP_CODES.canonicalOwnerUnconfigured,
    };
  }
  try {
    const stored = await seam.store({
      runId,
      // One canonical row per (generate job, analyzed artifact):
      // the seam's generation-id idempotency makes a re-run over
      // the same persisted input converge on the same row.
      generationId: `pipeline-generate:${def.id}:${document.inputArtifactId}`,
      userLogin: owner,
      title: document.title,
      source: GENERATE_CANONICAL_SOURCE,
      summary: document.summary,
      body: document,
      createdAt: finishedAt,
    });
    if (!stored) {
      return {
        status: "failed",
        reportId: null,
        fanoutCode: null,
        reason: GENERATE_GAP_CODES.canonicalStoreRefused,
      };
    }
    return {
      status: stored.created ? "stored" : "deduped",
      reportId: stored.reportId,
      fanoutCode: stored.fanout.code,
      reason: null,
    };
  } catch (err) {
    return {
      status: "failed",
      reportId: null,
      fanoutCode: null,
      reason: `${GENERATE_GAP_CODES.canonicalStoreThrew}: ${scrubFailureMessage(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }
}

/**
 * Run one generate job: resolve the persisted analyzed input,
 * render the configured reports in the configured formats,
 * run each report's canonical leg, persist the generated
 * artifact. Outcomes are RETURNED (the failed-input run is
 * recorded first); only an unknown job id throws (a caller
 * bug, the #3530 idiom).
 */
export async function runGenerateJob(
  registry: GenerateJobRegistry,
  deps: GenerateJobDeps,
  jobId: string,
  opts: RunGenerateJobOptions = {},
): Promise<GenerateRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new GenerateJobError(
      GENERATE_JOB_CODES.jobNotFound,
      `Generate job "${jobId}" is not registered.`,
    );
  }
  const startedMs = opts.nowMs ?? Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = opts.runId ?? `generate-run-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";
  const reports = validateGenerateReportKinds(opts.reports ?? def.reports);
  const formats = validateGenerateFormats(opts.formats ?? def.formats);

  const finish = async (
    partial: Omit<
      GenerateRunResult,
      "jobId" | "runId" | "artifactId" | "inputArtifactId" | "inputRunId" | "reportsGenerated" | "canonical"
    > & {
      reports: GeneratedReportRecord[];
      inputArtifact: AnalyzedDatasetArtifact | undefined;
    },
  ): Promise<GenerateRunResult> => {
    const finishedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
    const summary: GeneratedDatasetArtifact["summary"] = {
      reportsGenerated: partial.reports.filter((r) =>
        r.formats.some((f) => f.status === "generated"),
      ).length,
      formatsGenerated: partial.reports.reduce(
        (sum, r) => sum + r.formats.filter((f) => f.status === "generated").length,
        0,
      ),
      formatsFailed: partial.reports.reduce(
        (sum, r) => sum + r.formats.filter((f) => f.status === "failed").length,
        0,
      ),
      canonicalStored: partial.reports.filter(
        (r) => r.canonical.status === "stored" || r.canonical.status === "deduped",
      ).length,
      canonicalNotWired: partial.reports.filter(
        (r) => r.canonical.status === "not_wired",
      ).length,
    };
    const artifact = await deps.generatedStore.store({
      jobId: def.id,
      analyzeJobId: def.analyzeJobId,
      enrichJobId: def.enrichJobId,
      feedJobId: def.feedJobId,
      sourceId: def.sourceId,
      dataset: def.dataset,
      universe: partial.inputArtifact?.universe ?? {
        kind: "index",
        index: def.universe.index,
        label: def.universe.label,
        snapshotDate: null,
        sourceLabel: null,
        size: 0,
      },
      inputArtifactId: partial.inputArtifact?.id ?? "",
      inputRunId: partial.inputArtifact?.run.runId ?? "",
      inputAsOf: partial.inputArtifact?.createdAt ?? "",
      reportsRequested: reports,
      formatsRequested: formats,
      reports: partial.reports,
      summary,
      run: {
        runId,
        trigger,
        startedAt,
        finishedAt,
        status: partial.status,
        requested: partial.requested,
        received: partial.received,
        failed: partial.failed,
        codedError: partial.codedError,
        errorMessage: partial.errorMessage,
      },
      nowIso: finishedAt,
    });
    if (partial.status === "failed") {
      structuredLog.warn(GENERATE_JOB_RUN_FAILED, {
        message: `[generateJobs] ${partial.codedError ?? "GENERATE_RUN_FAILED"}: generate job "${def.id}" run ${runId} failed (${partial.errorMessage ?? "no detail"})`,
        jobId: def.id,
        runId,
        codedError: partial.codedError,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: partial.status,
      artifactId: artifact.id,
      requested: partial.requested,
      received: partial.received,
      failed: partial.failed,
      codedError: partial.codedError,
      errorMessage: partial.errorMessage,
      inputArtifactId: partial.inputArtifact?.id ?? null,
      inputRunId: partial.inputArtifact?.run.runId ?? null,
      reportsGenerated: partial.reports
        .filter((r) => r.formats.some((f) => f.status === "generated"))
        .map((r) => r.kind),
      canonical: Object.fromEntries(
        partial.reports.map((r) => [r.kind, r.canonical.status]),
      ) as Record<string, GeneratedCanonicalRecord["status"]>,
    };
  };

  // The input: the analyze job's newest USABLE persisted
  // artifact, by its exact job id — reads never fetch.
  const inputArtifact = await deps.analyzedStore.latestUsable(def.analyzeJobId);
  if (!inputArtifact) {
    return finish({
      status: "failed",
      requested: 0,
      received: 0,
      failed: 0,
      codedError: GENERATE_JOB_CODES.inputMissing,
      errorMessage: scrubFailureMessage(
        `No usable persisted analyzed dataset for analyze job "${def.analyzeJobId}": the generate run was refused rather than fetching live or generating from another job's copy.`,
      ),
      reports: [],
      inputArtifact: undefined,
    });
  }

  // A sharded unit generates from its partition of the input
  // only (its lineage still names the whole input artifact).
  const partitioned = !!opts.symbols;
  const effectiveRows = opts.symbols
    ? inputArtifact.rows.filter((r) =>
        opts.symbols!.some((s) => s.toUpperCase() === r.symbol.toUpperCase()),
      )
    : inputArtifact.rows;

  const finishedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
  const generatedReports: GeneratedReportRecord[] = [];
  let received = 0;
  for (const kind of reports) {
    const document = buildReportDocument({
      kind,
      def,
      inputArtifact,
      rows: effectiveRows,
      partitioned,
    });
    const formatRecords: GeneratedFormatRecord[] = [];
    for (const format of formats) {
      const record = await renderReportFormat({ document, format, finishedAtIso: finishedAt });
      if (record.status === "generated") received++;
      formatRecords.push(record);
    }
    const canonical = await runCanonicalLeg({
      seam: deps.canonicalReportStore,
      def,
      document,
      runId,
      finishedAt,
    });
    generatedReports.push({ kind, title: document.title, formats: formatRecords, canonical });
  }

  const requested = reports.length * formats.length;
  const failedCount = requested - received;
  return finish({
    status: failedCount > 0 ? "partial" : "completed",
    requested,
    received,
    failed: failedCount,
    codedError: null,
    errorMessage: null,
    reports: generatedReports,
    inputArtifact,
  });
}

/* ------------------------------------------------------------------ */
/* Status — what the UX renders (one source of truth: the store)       */
/* ------------------------------------------------------------------ */

export interface GenerateStatusView {
  jobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  reports: string[];
  formats: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: GeneratedDatasetArtifact["run"] | null;
  /** Recent run history, newest first. */
  history: GeneratedDatasetArtifact["run"][];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    /** Reports with at least one generated format. */
    reportsPersisted: number;
    /** Format bodies persisted (the generated count). */
    formatsPersisted: number;
    stale: boolean;
    /** Lineage: the analyzed artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    /** Per-report outcomes: formats generated/failed + the canonical leg. */
    reports: Array<{
      kind: string;
      title: string;
      formatsGenerated: string[];
      formatsFailed: string[];
      canonicalStatus: GeneratedCanonicalRecord["status"];
      canonicalReportId: string | null;
    }>;
  } | null;
}

export async function buildGenerateStatus(
  store: GeneratedDatasetStore,
  def: GenerateJobDefinition,
  nowMs: number,
): Promise<GenerateStatusView> {
  const [latest, usable, runArtifacts] = await Promise.all([
    store.latest(def.id),
    store.latestUsable(def.id),
    store.listRuns(def.id, 5),
  ]);
  const base: GenerateStatusView = {
    jobId: def.id,
    analyzeJobId: def.analyzeJobId,
    enrichJobId: def.enrichJobId,
    feedJobId: def.feedJobId,
    sourceId: def.sourceId,
    dataset: def.dataset,
    reports: [...def.reports],
    formats: [...def.formats],
    universeLabel: def.universe.label,
    cadenceMinutes: def.cadenceMinutes,
    staleAfterMinutes: def.staleAfterMinutes,
    state: latest ? "ready" : "never-run",
    lastRun: latest?.run ?? null,
    history: runArtifacts.map((a) => a.run),
    snapshot: null,
  };
  if (!usable) return base;
  const asOfMs = Date.parse(usable.createdAt);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
  return {
    ...base,
    snapshot: {
      artifactId: usable.id,
      asOf: usable.createdAt,
      ageSeconds,
      reportsPersisted: usable.summary.reportsGenerated,
      formatsPersisted: generatedFormatCount(usable),
      stale: ageSeconds > def.staleAfterMinutes * 60,
      inputArtifactId: usable.inputArtifactId,
      inputRunId: usable.inputRunId,
      inputAsOf: usable.inputAsOf,
      reports: usable.reports.map((r) => ({
        kind: r.kind,
        title: r.title,
        formatsGenerated: r.formats.filter((f) => f.status === "generated").map((f) => f.format),
        formatsFailed: r.formats.filter((f) => f.status === "failed").map((f) => f.format),
        canonicalStatus: r.canonical.status,
        canonicalReportId: r.canonical.reportId,
      })),
    },
  };
}
