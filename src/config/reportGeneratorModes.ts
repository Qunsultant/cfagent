/**
 * #1731 (parent #1717, slice (k)): report generator remainders
 * (scan appendix (k) findings R-1, R-2, R-3, R-7, S1; R-4, R-5, R-6
 * IDENTICAL, pin only; R07 resolved into R-1..R-7; S2 IDENTICAL) —
 * the PAYMENTS_FLOW_MODE (#1711) / MARKET_DATA_* (#1727) /
 * GOAL_COMPILE_MODE (#1729) pattern applied to this domain, with
 * one deliberate difference, following the #1730 precedent: this
 * slice adds NO runtime switch. Pure module: no Cloudflare
 * imports, no I/O, no network — the registry is data, and the
 * tests in tests/report_generator_remainders_modes_1731.test.ts
 * pin the behavior distinctions it records (port-first, cfagent
 * blueprint #1795/#1798 restated wording: cloud-native but
 * cloud-agnostic).
 *
 * WHY NO SWITCH (read before adding one): every divergent pair
 * in appendix (k) is divergent-by-design, and a switch over any
 * of them would be either a silent misrender, a broken caller
 * contract, a stranded approval, or a phantom switch with no
 * single call site that could honor both values. The #1729 /
 * #1730 precedent governs: where a pair is divergent-by-design
 * for safety, or the two semantics genuinely differ and neither
 * is a legacy accident, pin it with justification rather than
 * forcing a phantom switch. Each pin below names the flip that
 * must NOT happen and why. A future slice that finds a genuine
 * single call site with both paths present must add its switch
 * here (and grow REPORT_GENERATOR_1731_SWITCHES) with its own
 * Red evidence — it must not silently flip a pin.
 *
 * Consequences of having no switch in this slice:
 * - There is NO env var to declare (src/types.ts untouched),
 *   NO production value for the owner to set, and NO
 *   config_error event: there is no switch value that could
 *   fail closed. The scoped resolution order (run > session >
 *   user > global env > built-in) has nothing to resolve here;
 *   each pin's `defaultBehavior` IS the current public-route
 *   behavior, recorded explicitly so the owner can overturn
 *   any pin later by a deliberate decision, not by a flag.
 * - No endpoint is removed, no code path is deleted, no store
 *   is merged, no new store/engine is introduced. NEVER
 *   EITHER/OR is honored by keeping both paths in every pair.
 * - The security guard holds trivially and absolutely: no
 *   caller can configure away any enforcement through this
 *   module, because this module configures nothing. IAAA gate
 *   switches, if any are ever touched here, stay
 *   admin/platform-controlled, default fail-closed, never
 *   user/session-configurable by the gated subject.
 *
 * The ONE executable change in this slice (not a switch): the
 * single dispatch in unifiedReportPipeline.ts now refuses
 * unknown report types loudly instead of silently rendering
 * them through the options branch — the #1641-class silent
 * misrender, completed. A goal-screen type through the dispatch
 * is therefore impossible by accident: it must use its pinned
 * direct path, or gain an explicit pipeline type in a future
 * slice. Typed callers are unaffected: the asset owner accepts
 * only the three pipeline types, and the dispatch is its only
 * caller.
 *
 * Switch-vs-pin table ("pinned" = divergent-by-design, both
 * paths kept; "identical" = already a single path, collapsed,
 * no switch; "resolved" = not a pair at all):
 * | pair | resolution | the flip that must NOT happen            |
 * | R-1  | pinned     | one merged renderer for all report types |
 * | R-2  | pinned     | goal-screen through the pipeline, or its |
 * |      |            | direct path deleted                      |
 * | R-3  | pinned     | one orchestration forcing one key /      |
 * |      |            | verification contract on both callers    |
 * | R-7  | pinned     | deleting the legacy shim on a date, or   |
 * |      |            | routing legacy rows via the canonical    |
 * |      |            | path (no stored copy exists for them)    |
 * | S1   | pinned     | merging the two research engines, or one |
 * |      |            | provenance vocabulary for both           |
 * | R-4  | identical  | a second canonical store (the wrapper IS |
 * |      |            | the store; id schemes are caller-level)  |
 * | R-5  | identical  | a second blob seam (key families are     |
 * |      |            | caller choices, not store divergence)    |
 * | R-6  | identical  | a second semantic index (one index path, |
 * |      |            | one search path)                         |
 * | R07  | resolved   | re-reporting the routes carry-over as a   |
 * |      |            | separate pair (it is R-1..R-7)            |
 * | S2   | identical  | a second screening engine (plan + ledger |
 * |      |            | orchestration over the one pipeline)     |
 *
 * Scan-vs-code verification (current main governs; the scan
 * head was 23de3ce, this slice verified against main f523bf2):
 * - Renderer sizes hold: screener 411 lines, options 253,
 *   research 361. Margins hold (36pt vs 48pt/48pt), wrap holds
 *   (screener + research word-wrap, options truncates to 120
 *   chars with no wrap), glyph cleaning holds (screener full
 *   set incl. triangle marks, options the same minus the
 *   triangles, research none).
 * - The routing claim holds: the single dispatch is the only
 *   production caller of the three renderers (pinned by the
 *   #1023 single-PDF-path source test), and the asset owner
 *   reaches the renderers only through that dispatch.
 * - Goal-screen deltas hold: own pagination at y below 56,
 *   100-hit cap, Yahoo-fallback provenance line, per-format
 *   FAILURE_REPORT_PDF_GENERATION with the run still succeeding, key family
 *   goal_screen with R2 goals mapping. The asset owner's
 *   accepted types are exactly the three pipeline types.
 * - Tabular deltas hold: the screener agent keeps per-run +
 *   latest keys; the shard executor keeps a single per-run
 *   key, explicit content types, and read-back verification
 *   before the canonical row. The underlying XLSX/CSV
 *   generators are already shared per type.
 * - Confirm branches hold: kind screener resubmits the held
 *   follow-up delivery; rows with a stored id deliver the
 *   canonical copy; legacy rows deliver from the embedded
 *   payload. Same audit names, stored id vs file name and
 *   sheets count; missing stored maps to 500, email
 *   unavailable to 503, webhook unconfigured to 503 vs
 *   webhook failure to 502.
 * - S1 engines hold: the market-data single-symbol service and the
 *   governed ResearchAgent pipeline, different inputs,
 *   engines, stores, and provenance vocabularies, no shared
 *   report builder between them.
 * - R-4/R-5/R-6 hold: the ORM canonical method literally
 *   calls the scheduled store function; the blob seam maps
 *   screener, options, goal-screen, and knowledge families;
 *   the semantic index has one index path and one search
 *   path, served by the semantic-search route.
 * - Scope note: S2 is appendix-(k) finding #10 and is NOT
 *   enumerated in the #1731 issue body (which lists R-1, R-2,
 *   R-3, R-7, S1 plus R-4/R-5/R-6 pin-only and R07 resolved).
 *   It is recorded here as IDENTICAL so this slice covers all
 *   10 appendix-(k) pairs; its subject is goal-screen
 *   orchestration, not a report generator, and no code is
 *   touched for it either way.
 */

export type ReportGeneratorPinId =
  | "R-1"
  | "R-2"
  | "R-3"
  | "R-7"
  | "S1"
  | "R-4"
  | "R-5"
  | "R-6"
  | "R07"
  | "S2";

export type ReportGeneratorResolution = "pinned" | "identical" | "resolved";

export interface ReportGeneratorPin {
  id: ReportGeneratorPinId;
  finding: string;
  resolution: ReportGeneratorResolution;
  /** Why this pair is pinned (or why it is already identical / resolved). */
  reason: string;
  /** The current public-route behavior, kept by this slice. */
  defaultBehavior: string;
}

/**
 * The runtime switches this slice adds: none, deliberately.
 * A future switch over any pair below must be appended here
 * with its own Red evidence and PR-body justification.
 */
export const REPORT_GENERATOR_1731_SWITCHES: readonly string[] = [];

export const REPORT_GENERATOR_1731_PINS: readonly ReportGeneratorPin[] = [
  {
    id: "R-1",
    finding:
      "Four PDF renderers remain parallel generators: the screener renderer (411 lines, 36pt margins, word-wrap, glyph cleaning incl. triangle marks), the options renderer (253 lines, 48pt margins, truncates to 120 chars with no wrap, glyph cleaning), the research renderer (361 lines, 48pt margins, word-wrap, NO glyph replacement), and the opportunity-hunt renderer (issue 6403, 36pt margins, word-wrap, glyph cleaning). All reached ONLY through the single dispatch in unifiedReportPipeline.ts.",
    resolution: "pinned",
    reason:
      "Content models differ by type (screener run vs option screen result vs ranked research report of at most 5 qualified plus watchlist plus rejected-with-reasons vs opportunity-hunt result of one row per symbol with entry/exit signals and grouped recommendations), so a merged renderer would be a redesign, not a dedup. The flip that must NOT happen: one renderer for all types — it would either drop type-specific content or grow a type switch that re-creates the four renderers inside one file. Routing is unified; rendering is type-specific, and the rendering deltas (margins, wrap, glyphs) are pinned type behavior, not accidents to be averaged away.",
    defaultBehavior:
      "Routing stays unified through the single dispatch; the four renderers stay separate with their own margins (screener and opportunity-hunt 36pt, options and research 48pt), layout (screener, research, and opportunity-hunt word-wrap, options truncates each string to 120 chars with no wrap), and glyph handling (screener full set incl. triangle marks, options the same minus the triangles, research none, opportunity-hunt the screener set). The dispatch now refuses unknown types loudly instead of silently rendering them through the options branch.",
  },
  {
    id: "R-2",
    finding:
      "Goal-screen artifacts bypass the unified pipeline: a fourth self-contained pdf-lib renderer (own pagination below y 56, 100-hit cap, Yahoo-fallback provenance line), called directly, never through the asset owner or the pipeline stage; own key family (goal_screen with R2 goals mapping); per-format FAILURE_REPORT_PDF_GENERATION failure with the run still succeeding. Blob store shared; store leg unified via the store stage in the scheduled path, generate leg NOT.",
    resolution: "pinned",
    reason:
      "The asset owner accepts the pipeline types (screener, options, research, and — since issue 6403 — opportunity-hunt), so routing goal-screen through it would require a fifth asset type plus a fifth pipeline type plus a content-model mapping for goal-screen hits — new-engine work the scan does not prove required. The flip that must NOT happen: forcing goal-screen through the pipeline dispatch (before this slice it would silently render as an options report; after the dispatch hardening it is refused, which is the honest outcome) or deleting the direct path (which would leave goal-screen runs with no PDF at all). The per-format failure contract is the shared #1278 report policy applied to goal-screen artifacts, not a second failure model.",
    defaultBehavior:
      "Goal-screen PDF/XLSX/CSV keep generating directly with per-format FAILURE_REPORT_PDF_GENERATION and the run succeeding; keys stay in the goal_screen family; the blob seam and the scheduled-path canonical-row write stay unified. No fourth pipeline type is invented in this slice.",
  },
  {
    id: "R-3",
    finding:
      "Tabular (XLSX/CSV) generation has two orchestration sites over shared generators: the screener agent (per-run key plus latest pointer keys) vs the shard executor generateTabular shard (single per-run key, explicit content types, read-back verification before the canonical row). Underlying tabular generators shared per type; duplicated is the generate-and-store orchestration. Goal-screen tabular generators are a third, type-specific set (see R-2).",
    resolution: "pinned",
    reason:
      "The two sites serve different caller contracts: the agent's latest pointer is the route-served latest contract (manual and scheduled runs addressable as latest), while the shard's read-back verification is the shard honesty contract (the blob must read back before the canonical row is written). The flip that must NOT happen: one orchestration forcing one key and verification contract on both callers — it would either drop the latest pointer and break the latest routes, or drop read-back verification and weaken shard honesty. A helper with options for both would re-create the two sites inside one function.",
    defaultBehavior:
      "The screener agent keeps per-run plus latest keys; the shard keeps a single per-run key with explicit content types and read-back verification; the XLSX/CSV generators stay shared per type; goal-screen tabular stays its own type-specific set.",
  },
  {
    id: "R-7",
    finding:
      "Report-confirm delivery, canonical vs legacy paths inside one handler (POST /trading/reports/confirm, own state machine, NOT a mirror of POST /payments/confirm): approved branches three ways — kind screener resubmits held follow-up delivery; rows with a stored id deliver the STORED canonical copy (audits with the stored id); legacy pre-#308 rows deliver from the embedded payload (same audit names, file name and sheets count instead of the stored id; error mapping differs: missing stored maps to 500, email unavailable to 503, webhook unconfigured to 503 vs webhook failure to 502).",
    resolution: "pinned",
    reason:
      "The legacy path is a compatibility shim, not a second delivery system — but it is load-bearing for rows that predate the canonical store, which have no stored copy to deliver. The flip that must NOT happen: deleting the shim on a date (which would strand approvals for pre-#308 rows still pending) or routing legacy rows through the canonical path (which would fail every one of them with a missing stored report). The payments-confirm route is name similarity only (different tables, state machines, effects) and is not a pair with this handler.",
    defaultBehavior:
      "All three approved branches stay: screener resubmit, canonical stored-copy delivery, and legacy embedded-payload delivery with their current audit payloads and error mapping. The legacy shim retires only on drain: when zero pending confirmations reference rows without a stored id, observed — never on a calendar date. Until that observation, the shim stays.",
  },
  {
    id: "S1",
    finding:
      "Two research-report engines (engine-level, not renderer-level): the market-data single-symbol equity report (Yahoo fundamentals plus quote plus bars, DID attestation, live/cached provenance vocabulary, served by the market-data research REST route and MCP research commands) vs the ResearchAgent governed options-research OODA loop (E*TRADE research data provider, research settings/runs/evaluations tables, task ledger, schedule guard, stored PDF reports; multi-leg strategy research, gates and evaluation provenance). No shared report builder between them.",
    resolution: "pinned",
    reason:
      "The slice decision, recorded: these are two capabilities sharing a word, not one capability with two engines. Inputs differ (symbol vs strategy/universe), engines differ, stores differ, provenance vocabularies differ; merging them would force one provenance vocabulary and one input shape onto both, destroying the governed loop's gates or the equity report's attestation. The flip that must NOT happen: a naive engine merge, or a shared builder that pretends a symbol report and a strategy research run are the same input. The shared seam is the PDF/history surfaces (R-4/R-5/R-6), not the engines.",
    defaultBehavior:
      "Both engines stay: Market-data single-symbol equity reports and the governed options-research loop, each with its own inputs, stores, and provenance; both publish through the shared canonical store, blob seam, and semantic index surfaces.",
  },
  {
    id: "R-4",
    finding:
      "Canonical store: the ORM canonical method is a direct wrapper over the scheduled store function (same function, same idempotency on generation id, same never-throws contract); the pipeline store stage is a thin null-safe adapter over the same ORM method. Caller-level caveat, NOT store divergence: generation ids are derived differently per caller.",
    resolution: "identical",
    reason:
      "One store, one idempotency key, one contract — there is nothing to switch and nothing to merge. The id caveat is recorded, not fixed, in this slice: unifying id derivation would change idempotency semantics (which rows collapse) for live callers, which needs its own Red evidence and gate, not a silent change inside a pin slice.",
    defaultBehavior:
      "One canonical write path, idempotent on generation id. The three live id schemes stay as they are, named so a future slice can reason about them: pipeline type:trigger:timestamp, report-dispatch sha256 of the body JSON, scheduled generationIdOf of the input. Two callers can mint different ids for the same logical report and store two rows; the store cannot dedupe across id schemes, and this slice does not pretend otherwise.",
  },
  {
    id: "R-5",
    finding:
      "Blob store: one seam (put/get report bytes) used by the asset owner, the screener agent, the research agent, goal-screen artifacts, shard executors, and the knowledge-corpus seam. R2-vs-DO fallback lives inside the seam, not re-implemented per caller. Key-naming differences (per-run vs latest pointers, family prefixes) are caller key choices, not store divergence.",
    resolution: "identical",
    reason:
      "One seam, one fallback, one key-family mapping — there is nothing to switch and nothing to merge. Collapsing caller key choices into one naming rule would break the latest-pointer routes (R-3) and the goal-screen family (R-2).",
    defaultBehavior:
      "One blob seam with the R2-vs-DO fallback inside it; family mapping screener to stocks, options to options, goal-screen to goals, knowledge to knowledge; per-run vs latest remains a caller key choice.",
  },
  {
    id: "R-6",
    finding:
      "Semantic index: one index path (best-effort, never fails the run) and one search path (served by the semantic-search route). Research publish, and only research publish, was found indexing at generation; no second indexing pipeline was found.",
    resolution: "identical",
    reason:
      "One index, one search — there is nothing to switch and nothing to merge. Wiring a second indexer (e.g. indexing screener runs at generation) would be a new capability, not a dedup, and is not claimed here.",
    defaultBehavior:
      "One index path and one search path; research publish keeps indexing at generation; nothing else indexes at generation.",
  },
  {
    id: "R07",
    finding:
      "Routes-scan carry-over: the screener/options/research/goal-screen report routes vs the reports routes vs the AgentDB reports list. The old doc's four-parallel-generators framing is outdated — the pipeline is no longer a fourth parallel generator; it is the single dispatch over three renderers plus one bypass (goal-screen).",
    resolution: "resolved",
    reason:
      "This item is fully covered by R-1..R-7 above; re-reporting it as a separate pair would double-count the same renderers, routes, and stores. The flip that must NOT happen: treating the routes scan as a tenth divergence requiring its own switch — the routes are surfaces over the pinned pairs, not a pair themselves.",
    defaultBehavior:
      "No new route unification: the report routes, the reports routes, and the AgentDB reports list stay as they are, each over the pinned R-1..R-7 pairs.",
  },
  {
    id: "S2",
    finding:
      "Goal/scenario screen orchestration over the one pipeline, NOT a second engine: the goal-driven screen module is plan plus ledger orchestration only, executing through the Phase 0 screening provider registry; the scenario engine supplies the scenario/taxonomy language (goal kinds, outlooks, DTE/liquidity constraints), not a competing screener. The ResearchAgent goal-discovery tool produces PROPOSED goals/scenarios for human confirmation — a different stage (discovery of goals) from screening against them.",
    resolution: "identical",
    reason:
      "Orchestration over the pipeline is not a second engine, and proposing goals is not screening against them. There is nothing to switch and nothing to merge; recording this here prevents a future slice from re-reporting the goal screen as a duplicate screener.",
    defaultBehavior:
      "Goal-driven screening keeps orchestrating through the one provider registry with its ledger; the scenario engine keeps supplying language, not screening; goal discovery keeps proposing goals for human confirmation.",
  },
];

export function reportGeneratorPin(id: ReportGeneratorPinId): ReportGeneratorPin | undefined {
  return REPORT_GENERATOR_1731_PINS.find((pin) => pin.id === id);
}
