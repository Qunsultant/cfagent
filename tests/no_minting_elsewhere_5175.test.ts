// @vitest-environment node
/**
 * Issue #5175 slice 4 — the no-minting-elsewhere pin.
 *
 * Rule (user ruling 2026-11-17, comment 6962347431; slices 1-3 merged):
 * no fresh-entropy id minting anywhere except the one leaf minter,
 * `src/services/executionTreeIds.ts`. Slice 1 built the leaf
 * (`newRunId`, `newAsyncJobId`, `newPaymentDraftId`, `newTaskProposalId`,
 * `newLocalOrderId`, `newDidProofId`, `newGoalRecordId`, `newScheduleId`,
 * `newPlatformRowId`, plus the derived builders and `parseId`); slice 2
 * built the `mas_runs` registry; slice 3 migrated the 27 inventoried
 * Area-2 run-id mint points onto the leaf. This pin locks that win: it
 * is a census over every run/job-id mint signature in `src/`, asserting
 * the exact count per family. A new mint anywhere fails the pin; a
 * migration removes a site from the census and updates this pin in the
 * same PR (gitops section 7: pins my change alters are updated in the
 * same PR).
 *
 * Scope: `src/` only (server + client — the leaf is client-importable,
 * so client run mints are in scope). `tests/` is NOT scanned: fixtures
 * mint example ids constantly, and the slice-1 pin plus the census pins
 * scan `src/`. The leaf file itself is excluded from the scan: it IS the
 * minting authority, and its derived builders (`chain:${family}` etc.)
 * would otherwise match the family patterns. The slice-1 pin
 * (`tests/id_authority_leaf_minter_5175.test.ts`) covers the leaf.
 *
 * Two categories, kept distinct in the comments below — do not blur them:
 *
 *  - DECIDED EXEMPTIONS: slice 3 decided these (see
 *    `impl-5175-slice3/status.md`). They are never flagged: the 2.5
 *    job-chain correlation UUIDs (no ruled minter yet — a follow-up
 *    owns them), the deferred deterministic / idempotency-load-bearing
 *    sites (they keep legacy STRINGS; they do not mint fresh entropy),
 *    and the excluded families (rsr_ research ids, CFO lane #5118;
 *    Cloudflare instanceId; quota-charge idempotency keys, where
 *    stability IS the correctness property; the
 *    optionsServeRecord.ts:775 delivery-id fallback, a replay-
 *    convergence key, not a run id; enrichment-calibration,
 *    binding-schedule, options_research).
 *  - KNOWN UNMIGRATED: run/job-id mints the slice-3 inventory did not
 *    cover and no decision has been made on. The pin records them
 *    exactly — so they cannot grow silently — but they are NOT
 *    exemptions: a follow-up migration owns them and updates this pin
 *    in the same PR. Families: the stage-leg run ids (P17), the
 *    platform run id (P19, 6 sites), the discovery run id (P19,
 *    2 sites), the `:service:` / `:route:` options-panel run ids (P08,
 *    4 sites), the client saga mint (P12, 2 sites), and the mesh /
 *    bridge / schedule-action job ids (P05 chat pair, P18 pair).
 *
 * Correlation ids are NOT run identities (evidence in the P19 comment):
 * the history/universe dep-resolution calls mint one fresh runId per
 * call — one screen run mints several, so the value cannot be the
 * run's identity — and the premium quota charges mint one fresh runId
 * per charge (the quota probe's key, same `chargePremiumQuota` family
 * as the excluded screen/goalScreen quota keys). They are enumerated
 * in P19 with that classification, not exempted as run ids.
 *
 * Pattern forms: a template pattern anchors on `${` immediately after
 * the prefix, EXCEPT the families that have literal segments before
 * the first interpolation (`screener:chat:` / `:scheduled:` / `:manual:`,
 * `goal-screen:manual:` / `:scheduled:` / `:live-test:`,
 * `options:csv:` / `:pdf:` / `:screen:` / `:scheduled:`,
 * `options-panel:service:` / `:route:`, `options_scanner:nlq:` /
 * `:manual:`, `saga-job-` / `saga-h-`, `discovery:pdf:` / `:scheduled:`)
 * — those use the bare prefix (backtick + prefix). `run:` / `job:` keep
 * the `${` anchor: the bare form would also match the
 * `run: ${report.runId}` log line in otelAlerting.ts:362 and the
 * `"job:root"` string, neither of which is an id mint. The `chain:`
 * bridge-job pattern requires the entropy fragment
 * (`crypto.randomUUID()` inside the template) because the leaf's
 * derived `chain:${family}` builder and the
 * `chain:${chain.provenance}` provenance label share the prefix. Two
 * counted occurrences are prose mentions, not templates: a backtick
 * inside a `"..."` description string (P05's openapiSpec.ts:658,
 * P11's researchJobCommands.ts:41). The census counts pattern
 * occurrences and classifies each in the comments; a new prose mention
 * fails the pin and forces review, which is the fail-closed behavior
 * a census pin wants.
 *
 * Out of scope (recorded, not counted): D1 / in-memory adapter row-id
 * defaults (`() => crypto.randomUUID()` — dataset row ids, not run
 * ids; the leaf's `newPlatformRowId` exists but the adapters were not
 * migrated — same follow-up family as Area 4); message-envelope ids
 * (`jobPipelineEvents.ts`, `runLedgerQueueTransport.ts` — CloudEvents
 * envelope / `run-ledger-project:` ids, not run ids); non-id entropy
 * (`Math.random` for sampling, `Date.now` for timestamps, the OTEL
 * `Math.random().toString(36)` fragments in `datenow36` /
 * `mathrand36` that are not run ids); the client idempotency-key
 * helper (`src/client/profileApi.ts:73`); test fixtures.
 *
 * Open questions (recorded in `impl-5175-slice4/status.md`, NOT
 * decided here): (1) the 4 `:service:` / `:route:` options-panel run
 * mints — migrate in a follow-up or exempt (the `:609` doc comment in
 * optionsScreenEngine.ts says the `:service:` run id is part of the
 * #4275 contract); (2) the client `generateSagaIds` saga mint —
 * migrate the client to the leaf's `newRunId` or exempt; (3) the
 * research-engine run id at researchScreenEngine.ts:180 is recorded
 * under the research exclusion family by evidence (a research run id
 * in the CFO lane, same as rsr_) — that extension of the exclusion is
 * a judgment call, flagged for review.
 *
 * Red-first proof: the pin was proven red by temporarily adding a
 * `screener:` template mint in a scratch file under `src/` (see
 * `impl-5175-slice4/status.md` for the exact proof); the scratch file
 * was deleted before the pin was reported green.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const SRC_ROOT = join(repo, "src");
const LEAF_REL = "src/services/executionTreeIds.ts";

function walkSrc(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(full, acc);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc.sort();
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'A-Za-z0-9_])\/\/.*$/gm, "$1");
}

interface ScannedFile {
  rel: string;
  source: string;
}

const ALL_FILES = walkSrc(SRC_ROOT).map((full) => relative(repo, full));
const SCAN: ScannedFile[] = ALL_FILES.filter((rel) => rel !== LEAF_REL).map(
  (rel) => ({ rel, source: stripComments(readFileSync(join(repo, rel), "utf8")) }),
);

function countAll(pattern: RegExp): number {
  let total = 0;
  for (const file of SCAN) total += (file.source.match(pattern) ?? []).length;
  return total;
}

// P19 is line-based: a bare UUID is a run/job/chain id only when the
// same line names a run-ish role. Lines that open a template are
// excluded here — the template patterns (P01-P18) own those lines.
// The identifier alternation is case-insensitive so `httpChainId`,
// `platformRunId`, `discoveryRunId` and `bridgeJobId` all match.
const RUNISH_ROLE = /chainid|jobid|runid|sagaid/i;

function countBareUuidRunIds(): number {
  let total = 0;
  for (const file of SCAN) {
    for (const line of file.source.split("\n")) {
      if (!line.includes("crypto.randomUUID()")) continue;
      if (line.includes("`")) continue;
      if (!RUNISH_ROLE.test(line)) continue;
      total += 1;
    }
  }
  return total;
}

describe("5175 slice 4 — no minting elsewhere", () => {
  it("P00 the leaf is the minting authority and is excluded from the scan", () => {
    expect(
      ALL_FILES,
      "the walk must find the leaf file (otherwise the exclusion is vacuous)",
    ).toContain(LEAF_REL);
    expect(
      SCAN.map((file) => file.rel),
      "the leaf must not be scanned (its builders would match the family patterns)",
    ).not.toContain(LEAF_REL);
    expect(SCAN.length, "the scan must cover src/ (a broken walk finds nothing)").toBeGreaterThan(
      500,
    );
    const leaf = readFileSync(join(repo, LEAF_REL), "utf8");
    expect(leaf).toContain("export function newRunId");
    expect(leaf).toContain("export function newAsyncJobId");
  });

  it("P01 run: reassembly adapters only (2)", () => {
    // Both are reassembly, not minting: the registry read path rebuilds
    // `run:${parsed.runBody}` from a stored canonical id.
    // - src/data/doSqliteRunRegistryAdapter.ts:176
    // - src/data/inMemoryRunRegistryAdapter.ts:121
    // NOT counted: the `run: ${report.runId}` log line in
    // src/observability/otelAlerting.ts:362 (a log format, not an id —
    // the `${` anchor excludes it by construction).
    expect(
      countAll(/`run:\$\{/g),
      "run: templates: a new one is a new run-id mint outside the leaf",
    ).toBe(2);
  });

  it("P02 job: goal-run descriptors + stage addresses only (7)", () => {
    // - src/agents/scheduled-agent.ts:2527, 2561, 3617 — descriptors
    //   `job:${job.jobId}` (the async job's own id, not a mint).
    // - src/workflows/stageRunnerPorts.ts:137 — the JobStageId type.
    // - src/workflows/stageRunnerPorts.ts:141 — the node address
    //   `job:${nodePath}` (root is the plain string "job:root").
    // - src/services/unifiedScheduleManagement.ts:170, 175 — the
    //   #5890 list-collapse key `job:${catalogueId}` (a grouping key
    //   built from an EXISTING catalogue id, not a mint: the live
    //   alarm and the derived record for one duty share the key).
    // The `job:<uuid>` mint itself lives in the leaf (newAsyncJobId);
    // slice-3 P02 pins it.
    expect(
      countAll(/`job:\$\{/g),
      "job: templates: a new one is a new job-id mint outside the leaf",
    ).toBe(7);
  });

  it("P03 goal: deterministic labels only (2)", () => {
    // - src/services/goalDrivenScreen.ts:841 — universe label
    //   `goal:${input.scenario.goalKind}`.
    // - src/services/goalFiringClaims.ts:72 — claim key
    //   `goal:${goalId}:${startedMs}`.
    expect(
      countAll(/`goal:\$\{/g),
      "goal: templates: a new one is a new goal-id mint outside the leaf",
    ).toBe(2);
  });

  it("P04 scen: / outc: templates are gone (0)", () => {
    // The scen: / outc: mints live in the leaf (slice-3 P04); no
    // template remains anywhere in src/.
    expect(
      countAll(/`(?:scen|outc):\$\{/g),
      "scen:/outc: templates: one reappearing is a regression to slice 3",
    ).toBe(0);
  });

  it("P05 screener: family is exactly 30", () => {
    // Deferred deterministic family, slice 3 (14) — `screener:${timestamp}`
    // run / generation ids, no fresh entropy:
    // - src/agents/nlq/execution.ts:160
    // - src/agents/orchestrator/reportDispatch.ts:344
    // - src/agents/orchestrator/scheduledCallbacks.ts:516, 517, 543
    // - src/agents/screener-agent.ts:4003
    // - src/services/runSummaries.ts:519
    // - src/services/scheduledTasks.ts:2020, 2135
    // - src/workflows/stageQueueTransport.ts:119, 343
    // - src/workflows/stageReportProduction.ts:221
    // - src/workflows/screenerCollation.ts:1047
    // - src/workflows/screenerWorkflowFlow.deprecated.ts:814 (retired flow)
    // Literal-segment run ids, same deferred family (3) — derived from
    // universe / sector / timestamp, no randomUUID:
    // - src/workflows/screenerWorkflowRoutes.ts:57 —
    //   `screener:manual:${universe}:${new Date().toISOString()}`
    // - src/workflows/stockScreenPlanner.ts:94 —
    //   `screener:scheduled:${universe}:${sector}:${timestamp.slice(0, 16)}`
    // - src/workflows/stockScreenPlanner.ts:95 —
    //   `screener:manual:${universe}:${sector}:${timestamp}`
    // Storage / client keys (9):
    // - src/agents/screener-agent.ts:857, 864, 867, 873 — `screener:${key}`
    // - src/agents/screenerAgentName.ts:19 — `screener:${userLogin}` (DO name)
    // - src/client/StockHub.tsx:459, 1207 — client replay / confirm fetch
    // - src/events/screenerPublishers.ts:286 — agent name
    // - src/services/shardExecutors.ts:1122 — report key
    //   `screener:${chain.chainId}:${format}`
    // One literal-segment storage key (1):
    // - src/agents/orchestrator/scheduledCallbacks.ts:419 —
    //   `screener:scheduled:last-slot:${universe}`
    // KNOWN UNMIGRATED chat job ids (2) — the mesh / NLQ chat screen
    // job id, minted with a fresh uuid8 suffix:
    // - src/agents/orchestrator/meshScreenDoor.ts:549
    // - src/agents/orchestrator/nlqPorts.ts:351
    // One prose mention (1) — a backtick inside a `"..."` OpenAPI
    // description string, not a template and not a mint:
    // - src/security/openapiSpec.ts:658
    // Bare-prefix pattern (not `${`-anchored) so the `chat:`,
    // `scheduled:`, and `manual:` literal segments are counted.
    expect(
      countAll(/`screener:/g),
      "screener: templates: a new one is a new screener-id mint outside the leaf",
    ).toBe(30);
  });

  it("P06 goal-screen: family is exactly 14", () => {
    // Deferred taskId forms, slice 3 (10) — `goal-screen:${taskId}` run /
    // generation / delivery ids, derived from the task id:
    // - src/agents/orchestrator/goalScreenDispatch.ts:110, 111, 153
    // - src/agents/screener-agent.ts:3089
    // - src/services/goalDrivenScreen.ts:173, 191, 368
    // - src/services/screeningRuntime.ts:392, 393, 424
    // (goalDrivenScreen.ts:173 and :368 carry the `?? crypto.randomUUID()`
    // quota-key fallback — the excluded quota family, not a run mint.)
    // Literal-segment forms, same family, found by the slice-4 survey (4):
    // - src/agents/routes/paymentAssuranceLive.ts:263 —
    //   `goal-screen:live-test:${runRequestId}` (live-test job id)
    // - src/agents/routes/screenerResearch.ts:1641 —
    //   `goal-screen:manual:${userLogin}:${scenario.goalKind}:${iso}`
    //   (manual idempotency key)
    // - src/services/scheduledTasks.ts:2308 —
    //   `goal-screen:scheduled:${userLogin}:${scenario.goalKind}:${timestamp}`
    // - src/services/scheduledTasks.ts:2309 —
    //   `goal-screen:manual:${userLogin}:${scenario.goalKind}:${timestamp}`
    expect(
      countAll(/`goal-screen:/g),
      "goal-screen: templates: a new one is a new goal-screen-id mint outside the leaf",
    ).toBe(14);
  });

  it("P07 options: family is exactly 17", () => {
    // Deferred re-serve rows, slice 3 (7) — `options:${chainId}` /
    // `options:${timestamp}` run / generation ids:
    // - src/services/optionsChainPipelineJobs.ts:582, 679, 680
    // - src/services/optionsServeRecord.ts:702, 703, 857, 858
    // Excluded delivery-id fallback (1) — a replay-convergence key, not
    // a run id (slice 3):
    // - src/services/optionsServeRecord.ts:775
    // Artifact / planner keys (4) — derived from a run id or a trigger:
    // - src/workflows/optionsScreenPorts.ts:67 — `options:${runId}:${stageId}`
    // - src/workflows/optionsStageSeam.ts:69 — `options:screen:${runId}`
    // - src/workflows/blocks/plannerPort.ts:198 —
    //   `options:${input.trigger}:${idempotencySubject}:${timestamp}`
    // - src/services/scheduledTasks.ts:3081 — jobKey
    // Storage / export keys (5):
    // - src/agents/orchestrator.ts:1741 — `options:scheduled:last-slot:`
    // - src/agents/screener-agent.ts:3701 — `options:csv:${uuid8}`
    //   (fresh-entropy export key, not a run id)
    // - src/agents/screener-agent.ts:3763, 3781, 3807 —
    //   `options:pdf/xlsx/csv:strategy:${id}`
    expect(
      countAll(/`options:/g),
      "options: templates: a new one is a new options-id mint outside the leaf",
    ).toBe(17);
  });

  it("P08 options-panel: service / route run ids are exactly 4", () => {
    // KNOWN UNMIGRATED — open question 1 in impl-5175-slice4/status.md:
    // these four mint `:service:` / `:route:` options-panel run ids with
    // `new Date().toISOString()` and were never migrated (a different
    // mint point from slice 3's scheduled variant; the :609 doc comment
    // in optionsScreenEngine.ts says the `:service:` run id is part of
    // the #4275 contract). Sibling `:service:` tests assert the
    // `strategy-screen:options-panel:service:` shape and still pass.
    // - src/agents/routes/etradeOptionsEvaluate.ts:387
    // - src/services/discoveryService.ts:494
    // - src/workflows/manualPanelScreen.ts:61
    // - src/workflows/optionsScreenEngine.ts:641
    // Bare-prefix pattern (not `${`-anchored): the templates carry the
    // `service:` / `route:` literal segment before the first
    // interpolation.
    expect(
      countAll(/`options-panel:/g),
      "options-panel: templates: a new one is a new options-panel run mint outside the leaf",
    ).toBe(4);
  });

  it("P09 options_scanner: family is exactly 2", () => {
    // - src/agents/nlq/execution.ts:125 —
    //   `options_scanner:nlq:${generatedAt}` (derived from the passed-in
    //   timestamp; the literal itself contains no entropy).
    // - src/agents/routes/etradeOptionsScreen.ts:181 —
    //   `options_scanner:manual:${iso}` (deferred, slice 3).
    // Bare-prefix pattern (not `${`-anchored): the templates carry the
    // `nlq:` / `manual:` literal segment before the first interpolation.
    expect(
      countAll(/`options_scanner:/g),
      "options_scanner: templates: a new one is a new options-scanner-id mint outside the leaf",
    ).toBe(2);
  });

  it("P10 screen: / goalScreen: quota keys are exactly 4", () => {
    // EXCLUDED quota-charge idempotency keys (slice 3) — stability is
    // the correctness property:
    // - src/agents/screener-agent.ts:1300 —
    //   `screen:${lockLogin}:${lockUniverse}:${lock.startedAt ?? Date.now()}`
    // - src/services/screenInFlight.ts:57 — `screen:${userLogin}:${universe}:${startedAtMs}`
    // - src/agents/screener-agent.ts:3131, 3254 —
    //   `goalScreen:${req.idempotencyKey}`
    expect(
      countAll(/`(?:screen|goalScreen):\$\{/g),
      "screen:/goalScreen: templates: a new one is a new quota-key mint outside the leaf",
    ).toBe(4);
  });

  it("P11 research: namespaces and keys are exactly 6", () => {
    // - src/a2a/resolution.ts:86 — `research:${login}` (DO namespace)
    // - src/agents/orchestrator.ts:948 — `research:${login}` (DO stub)
    // - src/server/routes/platform.ts:205 — `research:${userLogin}`
    // - src/agents/orchestrator/researchPublish.ts:196 — idempotency key
    // - src/services/recommendationKernel.ts:369 — baseId
    // - src/agents/orchestrator.ts:1102 — `research:${login}` (#3185
    //   bridge: mirror provenance label for the reconcile's research
    //   leg, not a mint — the stub at :948 is the addressing site)
    // One prose mention — a backtick inside a `"..."` MCP tool
    // description string, not a template and not a mint:
    // - src/mcps/openaimp/researchJobCommands.ts:41
    // (The `research:<runId>` engine-job mentions elsewhere are comments.)
    expect(
      countAll(/`research:/g),
      "research: templates: a new one is a new research-id mint outside the leaf",
    ).toBe(7);
  });

  it("P12 saga- family is exactly 7", () => {
    // KNOWN UNMIGRATED client mint (2) — open question 2:
    // - src/client/GoalScreenPanel.tsx:256 — `saga-${suffix}` (the client
    //   `generateSagaIds` mint; the server now mints `run:` and accepts a
    //   client-supplied sagaId opaquely, slice-3 P07).
    // - src/client/GoalScreenPanel.tsx:257 — `saga-job-${suffix}`.
    // Derived sanitizers / hashes, no fresh entropy (5):
    // - src/workflows/sagaJourneyGate.ts:198 — `saga-${sanitized}`
    // - src/workflows/sagaJourneyGate.ts:200 — `saga-h-${hashSagaId(sagaId)}`
    // - src/workflows/sagaLegPort.ts:92 — `saga-${leg}-${sanitized}`
    // - src/workflows/sagaLegPort.ts:94, 118 — `saga-h-${hashSagaId(...)}`
    expect(
      countAll(/`saga-/g),
      "saga- templates: a new one is a new saga-id mint outside the leaf",
    ).toBe(7);
  });

  it("P13 rsr_ research ids are exactly 0 (retired by #5911)", () => {
    // #5911 removed the last `rsr_` mint outside the leaf: the research
    // pipeline adopts the run id the engine minted and, only when a direct
    // call names none, mints through executionTreeIds.newRunId (#5175) —
    // the CFO-lane exception this pin used to allow is gone with it. A new
    // `rsr_` template would be a new private research run-id mint.
    expect(
      countAll(/`rsr_/g),
      "rsr_ templates: a new one is a new research run-id mint outside the leaf",
    ).toBe(0);
  });

  it("P14 iv_collection: / pipeline-generate: deferred sites are exactly 3", () => {
    // Deferred, slice 3 — derived from the report date / the definition:
    // - src/services/scheduledTasks.ts:5614, 5615 —
    //   `iv_collection:${report.date}` (run + generation)
    // - src/services/generateJobs.ts:812 —
    //   `pipeline-generate:${def.id}:${document.inputArtifactId}`
    expect(
      countAll(/`(?:iv_collection|pipeline-generate):\$\{/g),
      "iv_collection:/pipeline-generate: templates: a new one is a new deferred-family mint",
    ).toBe(3);
  });

  it("P15 retired / never-minted families have zero templates (0)", () => {
    // No code template builds these job ids — the engine's derived
    // builders construct them (verified: no `+` concatenation either).
    // `shard-scan:` is built only by the leaf's `shardScanRunId`
    // (slice-3 P05); `options-screen:` / `strategy-screen:` /
    // `options-chain:` are engine job ids, not template mints.
    expect(
      countAll(
        /`(?:options-screen|strategy-screen|options-chain|stock_scanner|goal_screen|nlq-panel|nlq-scan|retention|shard-scan):/g,
      ),
      "retired families: a template here is a resurrected legacy mint",
    ).toBe(0);
  });

  it("P16 discovery: storage and export keys are exactly 4", () => {
    // Not run ids — a storage key and export-file keys, derived:
    // - src/agents/orchestrator/scheduledCallbacks.ts:802 —
    //   `discovery:scheduled:last-slot:${hash36}`
    // - src/services/discoveryReportPublish.ts:68, 86, 112 —
    //   `discovery:pdf/xlsx/csv:${id}`
    expect(
      countAll(/`discovery:/g),
      "discovery: templates: a new one is a new discovery-id mint outside the leaf",
    ).toBe(4);
  });

  it("P17 stage-leg run ids are exactly 9", () => {
    // KNOWN UNMIGRATED — the stage jobs mint their own run id when the
    // caller supplies none (`opts.runId ?? <legacy>`). A follow-up
    // migration owns them (the leaf's `newRunId` is the ruled minter).
    // - src/services/feedJobs.ts:946, 1240, 1531, 1872, 2309 —
    //   `feed-${crypto.randomUUID()}`
    // - src/services/analyzeJobs.ts:689 — `analyze-run-${uuid}`
    // - src/services/deliverJobs.ts:692 — `deliver-run-${uuid}`
    // - src/services/enrichJobs.ts:1143 — `enrich-run-${uuid}`
    // - src/services/generateJobs.ts:869 — `generate-run-${uuid}`
    expect(
      countAll(/`(?:feed|analyze-run|deliver-run|enrich-run|generate-run)-\$\{/g),
      "stage-leg run ids: a new one is a new stage-leg run mint outside the leaf",
    ).toBe(9);
  });

  it("P18 other job-id template mints are exactly 2", () => {
    // KNOWN UNMIGRATED — job ids for job systems other than the async
    // job family (which is `job:<uuid>` through the leaf, slice-3 P02):
    // - src/services/agentScheduleCapability.ts:842 —
    //   `agent-schedule-action-${crypto.randomUUID()}` (scheduled-action
    //   job-run record)
    // - src/agents/orchestrator/meshDoors.ts:1236 —
    //   `chain:${entry.jobId}:${nowIso}:${uuid8}` (mesh-door bridge job id)
    // The `chain:` pattern requires the entropy fragment because the
    // leaf's derived `chain:${family}` builder and the
    // `chain:${chain.provenance}` provenance label share the prefix.
    expect(
      countAll(/`agent-schedule-action-\$\{/g),
      "agent-schedule-action- templates: a new one is a new schedule-action job mint",
    ).toBe(1);
    expect(
      countAll(/`chain:[^`]*crypto\.randomUUID\(\)/g),
      "chain: bridge-job templates: a new one is a new bridge job mint",
    ).toBe(1);
  });

  it("P19 bare-UUID run / job / chain ids are exactly 27", () => {
    // Line-based (no backtick — template lines belong to P01-P18).
    // DECIDED EXEMPTION — the 2.5 job-chain correlation UUIDs (5):
    // - src/agents/orchestrator/asyncJobs.ts:472 (`httpChainId`),
    //   1642 (`chainId` fallback)
    // - src/agents/routes/schedules.ts:2334 (`chainId`)
    // - src/services/scheduledTasks.ts:1399, 3209 (`chainId`)
    // Correlation ids, NOT run identities (12) — one screen run mints
    // several, one per dep-resolution call, so the value cannot be the
    // run's identity; they scope history / universe capture rows:
    // - src/agents/research-agent.ts:499, 514, 591, 606, 874, 889, 1020,
    //   1035 (`resolveYahooHistoryDeps` runId)
    // - src/agents/routes/screenerResearch.ts:1906 (same)
    // - src/services/fitDiscoveryRunner.ts:236 (history), 253 (universe)
    // - src/trading/screenerPipeline.ts:708 (universe)
    // Quota-charge correlation ids (2) — the `chargePremiumQuota` probe
    // key, same family as the excluded screen/goalScreen quota keys:
    // - src/agents/routes/premium.ts:429 (optionsScan), 577 (marketResearch)
    // KNOWN UNMIGRATED — the platform run id (6): the data-provider
    // leg's run id, minted when no provider block has minted one yet
    // ("so the listings capture shares the screen's run id"):
    // - src/agents/screener-agent.ts:1502, 1543, 1558, 2012, 3281
    // - src/trading/options/unifiedOptionsService.ts:732
    // KNOWN UNMIGRATED — the discovery run id (2): minted per run()
    // call, "so every discovery fetch is attributable to exactly one
    // discovery run":
    // - src/services/discoveryService.ts:681, 761
    expect(
      countBareUuidRunIds(),
      "bare-UUID run/job/chain ids: a new one is a new bare-UUID mint outside the leaf",
    ).toBe(27);
  });
});
